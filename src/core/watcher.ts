import type { Config } from "../config/schema.js";
import type { Providers } from "../plugins/registry.js";
import type { AgentState, Ticket } from "../plugins/types.js";
import type { Dispatcher } from "./dispatcher.js";
import { compareTickets, criteriaFromConfig, evaluateTicket, isCompleted } from "./eligibility.js";
import type { Logger } from "./log.js";
import { ACTIVE_STATES, type DispatchRecord, type Store } from "./store.js";

export interface WatcherDeps {
  config: Config;
  store: Store;
  providers: Providers;
  dispatcher: Dispatcher;
  log: Logger;
}

export type WatcherPhase = "idle" | "polling" | "launching" | "monitoring";

const BASELINE_KEY = "baseline_done_at";

export class Watcher {
  private paused = false;
  private stopping = false;
  private pollTimer?: NodeJS.Timeout;
  private monitorTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
  private busy = false;
  private leaseToken?: string;
  private nextPollAt?: number;
  private lastPollAt?: number;
  phase: WatcherPhase = "idle";
  /** Resolves when the watcher stops (quit or lost lease). */
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(private readonly deps: WatcherDeps) {
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  private get workflow() {
    return this.deps.config.workflow;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Takes the workflow lease, reconciles interrupted launches, and starts the loops. */
  async start(opts: { once?: boolean } = {}): Promise<void> {
    const { config, store, log } = this.deps;
    const staleAfterMs = Math.max(config.pollIntervalSeconds * 3, 60) * 1000;
    const lease = store.acquireLease(this.workflow, staleAfterMs);
    if (!lease.ok) {
      throw new Error(
        `Another drovr watcher (pid ${lease.holder.pid} on ${lease.holder.host}, last heartbeat ${lease.holder.heartbeatAt}) is running workflow "${this.workflow}". ` +
          "Stop it first, or use --workflow to run a separate workflow.",
      );
    }
    this.leaseToken = lease.token;
    if (lease.tookOver) log.log("drovr", `took over a stale watcher lease (pid ${lease.tookOver.pid}, last heartbeat ${lease.tookOver.heartbeatAt})`);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 10_000);

    await this.serial(() => this.reconcile());
    await this.serial(() => this.poll());
    if (opts.once) {
      await this.stop();
      return;
    }
    this.schedulePoll();
    this.monitorTimer = setInterval(() => {
      if (!this.busy) void this.serial(() => this.monitor());
    }, config.monitorIntervalSeconds * 1000);
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.done;
    this.stopping = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.monitorTimer);
    clearInterval(this.heartbeatTimer);
    await this.chain;
    if (this.leaseToken) this.deps.store.releaseLease(this.workflow, this.leaseToken);
    this.resolveDone();
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.deps.log.log("drovr", `paused — no polling or launching until resumed${this.phase === "launching" ? " (the launch in progress will finish first)" : ""}`);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.deps.log.log("drovr", "resumed — polling now");
    this.pollNow();
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pollNow(): void {
    if (this.stopping) return;
    clearTimeout(this.pollTimer);
    void this.serial(() => this.poll()).then(() => this.schedulePoll());
  }

  /** One-line summary for the status shortcut. */
  statusLine(): string {
    const active = this.deps.store.countActive(this.workflow);
    const next = this.nextPollAt ? Math.max(0, Math.round((this.nextPollAt - Date.now()) / 1000)) : undefined;
    return [
      this.paused ? "PAUSED" : this.phase,
      `${active}/${this.deps.config.maxConcurrent} slots in use`,
      this.lastPollAt ? `last poll ${new Date(this.lastPollAt).toTimeString().slice(0, 8)}` : "not polled yet",
      !this.paused && next !== undefined ? `next poll in ${next}s` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  activeRecords(): DispatchRecord[] {
    return this.deps.store.list(this.workflow, { states: [...ACTIVE_STATES, "retry", "failed"] });
  }

  // ── Loops ────────────────────────────────────────────────────────────────

  private schedulePoll(): void {
    if (this.stopping) return;
    clearTimeout(this.pollTimer);
    const delay = this.deps.config.pollIntervalSeconds * 1000;
    this.nextPollAt = Date.now() + delay;
    this.pollTimer = setTimeout(() => {
      void this.serial(() => this.poll()).then(() => this.schedulePoll());
    }, delay);
  }

  /** Runs operations one at a time so polls, launches, and monitoring never interleave. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      this.busy = true;
      try {
        await fn();
      } catch (error) {
        this.deps.log.log("error", (error as Error).message);
      } finally {
        this.busy = false;
        this.phase = "idle";
      }
    });
    this.chain = run;
    return run;
  }

  private heartbeat(): void {
    if (!this.leaseToken || this.stopping) return;
    if (!this.deps.store.heartbeat(this.workflow, this.leaseToken)) {
      this.deps.log.log("error", "lost the watcher lease to another process — stopping to avoid duplicate dispatches");
      this.leaseToken = undefined;
      void this.stop();
    }
  }

  /** Dispatches left in `launching` belonged to a watcher that died mid-launch. Resume them first. */
  private async reconcile(): Promise<void> {
    const { store, dispatcher, log } = this.deps;
    const orphans = store.list(this.workflow, { states: ["launching"] });
    for (const record of orphans) {
      log.log("launch", `${record.identifier} was interrupted at step ${record.step ?? "start"} — reconciling with what already exists`);
      this.phase = "launching";
      await dispatcher.launch(record);
    }
  }

  private async poll(): Promise<void> {
    if (this.paused || this.stopping) return;
    const { config, store, providers, log } = this.deps;
    this.phase = "polling";
    this.lastPollAt = Date.now();
    const criteria = criteriaFromConfig(config);

    let fetched: Ticket[];
    try {
      fetched = await providers.tickets.listCandidates(criteria);
    } catch (error) {
      log.log("error", `polling ${providers.tickets.id} failed: ${(error as Error).message} — will retry next poll`);
      return;
    }

    const eligible: Ticket[] = [];
    for (const ticket of fetched) {
      const evaluation = evaluateTicket(ticket, criteria);
      if (evaluation.eligible) eligible.push(ticket);
      else log.log("skip", `${ticket.identifier} does not match: ${evaluation.reasons.join("; ")}`);
    }
    log.log("poll", `${fetched.length} ticket(s) fetched (${providers.tickets.describeQuery(criteria)}), ${eligible.length} eligible`);

    if (!store.getMeta(this.workflow, BASELINE_KEY)) {
      store.setMeta(this.workflow, BASELINE_KEY, new Date().toISOString());
      if (config.firstRun === "baseline") {
        for (const ticket of eligible) store.claim(this.workflow, ticket, "baseline", "matched on the first poll");
        log.log("drovr", `first run of workflow "${this.workflow}": recorded ${eligible.length} already-matching ticket(s) as a baseline without launching them`);
        for (const ticket of eligible) log.detail(`${ticket.identifier} ${ticket.title}`);
        log.detail("they launch only if they stop matching and match again later; use `drovr retry <ticket>` to launch one now");
        return;
      }
      log.log("drovr", `first run of workflow "${this.workflow}" with firstRun=dispatch: already-matching tickets will launch`);
    }

    this.forgetUnmatchedBaselines(eligible);
    await this.retryTicketMoves();
    await this.checkCompletion();

    const queue = this.buildQueue(eligible);
    const free = Math.max(0, config.maxConcurrent - store.countActive(this.workflow));
    if (queue.length === 0) {
      log.log("queue", `nothing new to launch (${config.maxConcurrent - free}/${config.maxConcurrent} slots in use)`);
      return;
    }
    log.log("queue", `${queue.length} ticket(s) waiting, ${free}/${config.maxConcurrent} slot(s) free`);
    if (free === 0) {
      for (const item of queue) log.detail(`${item.identifier} queued — waiting for a free slot`);
      return;
    }
    let slots = free;
    for (const item of queue) {
      if (slots === 0) {
        log.detail(`${item.identifier} queued — waiting for a free slot`);
        continue;
      }
      if (this.paused || this.stopping) break;
      let record: DispatchRecord | undefined;
      if (item.record) {
        record = item.record;
        log.log("match", `${record.identifier} retry requested — resuming`);
      } else {
        record = store.claim(this.workflow, item.ticket!, "launching");
        if (!record) {
          log.log("skip", `${item.identifier} was claimed by another process — skipping`);
          continue;
        }
        log.log("match", `${item.identifier} newly eligible (${item.reasons.join(", ")}) — launching`);
      }
      this.phase = "launching";
      await this.deps.dispatcher.launch(record);
      slots -= 1;
    }
  }

  private buildQueue(eligible: Ticket[]) {
    const { store, config, log } = this.deps;
    type Item = { identifier: string; ticket?: Ticket; record?: DispatchRecord; reasons: string[] };
    const retries: Item[] = store
      .list(this.workflow, { states: ["retry"] })
      .reverse()
      .map((record) => ({ identifier: record.identifier, record, reasons: ["retry"] }));
    const fresh: Item[] = [];
    for (const ticket of [...eligible].sort(compareTickets)) {
      const existing = store.get(this.workflow, ticket.id);
      if (existing) {
        if (existing.state !== "retry") log.log("skip", `${ticket.identifier} already dispatched (${existing.state} since ${existing.updatedAt})`);
        continue;
      }
      fresh.push({ identifier: ticket.identifier, ticket, reasons: evaluateTicket(ticket, criteriaFromConfig(config)).reasons });
    }
    return [...retries, ...fresh];
  }

  /** A baselined ticket that stops matching is forgotten, so it launches if it matches again later. */
  private forgetUnmatchedBaselines(eligible: Ticket[]): void {
    const { store, log } = this.deps;
    const ids = new Set(eligible.map((t) => t.id));
    for (const record of store.list(this.workflow, { states: ["baseline"] })) {
      if (ids.has(record.issueId)) continue;
      store.delete(this.workflow, record.issueId);
      log.log("skip", `${record.identifier} (baseline) no longer matches — it will launch if it matches again`);
    }
  }

  /** Retries moving tickets whose agent has them but whose move to the started state failed. */
  private async retryTicketMoves(): Promise<void> {
    if (!this.deps.config.tickets.startedState) return;
    for (const record of this.deps.store.list(this.workflow, { states: ["running", "needs_attention", "finished"] })) {
      if (record.promptedAt && !record.ticketMovedAt) await this.deps.dispatcher.moveTicket(record);
    }
  }

  /** Checks ticket state for active dispatches; idle agents do not mean the ticket is done. */
  private async checkCompletion(): Promise<void> {
    const { store, providers, config, log } = this.deps;
    for (const record of store.list(this.workflow, { states: ["running", "needs_attention"] })) {
      try {
        const ticket = await providers.tickets.getTicket({ id: record.issueId, identifier: record.identifier });
        if (isCompleted(ticket, config.completion)) {
          this.complete(record, `ticket moved to ${ticket.state.name}`);
        }
      } catch (error) {
        log.log("warn", `${record.identifier}: could not check ticket state: ${(error as Error).message}`);
      }
    }
  }

  /** The agent's first run is over; the ticket may still need review or follow-ups in its workspace. */
  private finish(record: DispatchRecord, status: string): void {
    const { store, log } = this.deps;
    const why = `agent finished its first run (${status})`;
    store.update(this.workflow, record.issueId, { state: "finished", agentStatus: status, reason: why });
    store.addEvent(this.workflow, record, "finished", why);
    log.log("done", `${record.identifier}: ${why} — slot freed; workspace ${record.workspaceId} stays open for review and follow-ups`);
  }

  private complete(record: DispatchRecord, why: string): void {
    const { store, log } = this.deps;
    store.update(this.workflow, record.issueId, { state: "completed", step: null, autoResume: false, reason: why, completedAt: new Date().toISOString() });
    store.addEvent(this.workflow, record, "completed", why);
    log.log("done", `${record.identifier} completed: ${why} — slot freed`);
  }

  /** Reports agent activity changes, detects closed workspaces, and resumes launches waiting on the user. */
  private async monitor(): Promise<void> {
    const { store, providers, config, log, dispatcher } = this.deps;
    const records = store.list(this.workflow, { states: ["running", "needs_attention"] });
    if (records.length === 0) return;
    this.phase = "monitoring";

    let workspaceIds: Set<string>;
    let agents: AgentState[];
    try {
      [workspaceIds, agents] = await Promise.all([providers.terminal.listWorkspaceIds(), providers.terminal.listAgents()]);
    } catch (error) {
      log.log("warn", `could not read ${providers.terminal.id} state: ${(error as Error).message}`);
      return;
    }
    const byName = new Map(agents.filter((a) => a.name).map((a) => [a.name!, a]));
    let freedSlot = false;
    const byPane = new Map(agents.map((a) => [a.paneId, a]));

    for (const record of records) {
      if (record.workspaceId && !workspaceIds.has(record.workspaceId)) {
        if (config.completion.whenWorkspaceClosed) this.complete(record, `workspace ${record.workspaceId} was closed`);
        else if (record.agentStatus !== "closed") {
          store.update(this.workflow, record.issueId, { agentStatus: "closed" });
          log.log("warn", `${record.identifier}: workspace ${record.workspaceId} was closed; run \`drovr done ${record.identifier}\` to free its slot`);
        }
        continue;
      }

      const agent = (record.agentName && byName.get(record.agentName)) || (record.paneId && byPane.get(record.paneId)) || undefined;

      if (record.state === "needs_attention" && record.autoResume) {
        const ready = agent && agent.interactiveReady !== false && agent.activity !== "unknown" && !(await dispatcher.agentBlocker(record).catch(() => "unreadable"));
        if (ready && !this.paused) {
          log.log("agent", `${record.identifier}: the agent is ready and no dialog is showing — continuing the launch`);
          this.phase = "launching";
          await dispatcher.launch(record);
        }
        continue;
      }

      const status = agent ? agent.activity : "exited";
      const settled = (s: string | null) => s === "idle" || s === "done";
      if (record.state === "running" && config.completion.whenAgentFinished && settled(status) && settled(record.agentStatus)) {
        this.finish(record, status);
        freedSlot = true;
        continue;
      }
      if (status === record.agentStatus) continue;
      store.update(this.workflow, record.issueId, { agentStatus: status });
      store.addEvent(this.workflow, record, "agent_status", status);
      const where = `workspace ${record.workspaceId}`;
      switch (status) {
        case "blocked":
          log.log("agent", `${record.identifier} is waiting for you — approval or question in Herdr ${where}`);
          break;
        case "working":
          log.log("agent", `${record.identifier} is working`);
          break;
        case "idle":
        case "done":
          if (record.state === "running" && config.completion.whenAgentFinished) {
            log.log("agent", `${record.identifier} agent is ${status} — its slot is released if it is still ${status} at the next check`);
          } else {
            log.log("agent", `${record.identifier} agent is ${status} — the ticket stays active until ${completionHint(config)}`);
          }
          break;
        case "exited":
          log.log("warn", `${record.identifier}: no agent in ${where} anymore (exited?) — run \`drovr retry ${record.identifier}\` to restart it or \`drovr done ${record.identifier}\``);
          break;
        default:
          log.log("agent", `${record.identifier} agent state is ${status}`);
      }
    }
    if (freedSlot && !this.paused) this.pollNow();
  }
}

function completionHint(config: Config): string {
  const parts = [
    ...config.completion.stateTypes.map((t) => `a ${t} state`),
    ...config.completion.states.map((s) => `"${s}"`),
    config.completion.whenWorkspaceClosed ? "its workspace is closed" : undefined,
    "`drovr done`",
  ].filter(Boolean);
  return parts.join(", ");
}
