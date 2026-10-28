import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Config, RepositoryConfig } from "../config/schema.js";
import type { Providers } from "../plugins/registry.js";
import { type Ticket, UserActionRequired } from "../plugins/types.js";
import { routeTicket } from "./eligibility.js";
import { describeFailure, type Exec } from "./exec.js";
import type { Logger } from "./log.js";
import type { DispatchPatch, DispatchRecord, LaunchStep, Store } from "./store.js";
import { PROMPT_MARKER, render, renderPrompt, safeName, ticketVars } from "./template.js";

/** Raised by a step that cannot proceed without the user. */
class Attention extends Error {
  constructor(
    message: string,
    readonly autoResume = false,
  ) {
    super(message);
  }
}

export interface DispatcherDeps {
  config: Config;
  store: Store;
  providers: Providers;
  log: Logger;
  exec: Exec;
  promptTemplate: string;
  /** Delay before inspecting a freshly started agent's screen. */
  startupSettleMs?: number;
}

export interface LaunchPlan {
  repo: RepositoryConfig;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  workspaceLabel: string;
  agentName: string;
}

const SETUP_TIMEOUT_MS = 30 * 60_000;
/** Ticket state types drovr may move forward to the started state. */
const NOT_STARTED_TYPES = new Set(["triage", "backlog", "unstarted"]);
/** Lets the agent draw its first screen before drovr inspects it. */
const STARTUP_SETTLE_MS = 1500;
const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)}s`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  private get workflow() {
    return this.deps.config.workflow;
  }

  /** Computes names and paths for a ticket without side effects (used by dry-run and the worktree step). */
  async plan(ticket: Ticket): Promise<LaunchPlan> {
    const { config, providers } = this.deps;
    const route = routeTicket(ticket, config.repositories);
    if (!route.ok) throw new Attention(`Cannot pick a repository: ${route.reason}`);
    const repo = route.repo;
    const vars = ticketVars(ticket);
    let branch = render(repo.branch, vars);
    if (/\{\w+\}/.test(branch)) branch = render(repo.fallbackBranch, vars);
    const branchSlug = branch.replace(/\//g, "-").replace(/[^\w.-]+/g, "-");
    const worktreePath = render(repo.worktreePath, { ...vars, repo: repo.path, branchSlug });
    const baseBranch = repo.baseBranch ?? (await providers.vcsFor(repo).defaultBranch(repo.path, repo.remote));
    return {
      repo,
      baseBranch,
      branch,
      worktreePath,
      workspaceLabel: render(config.terminal.workspaceLabel, vars),
      agentName: safeName(render(config.agent.name, vars)),
    };
  }

  /**
   * Runs (or resumes) the launch pipeline for a claimed dispatch. Every step first checks
   * whether its effect already exists, so re-running after a crash or lost response adopts
   * what was created instead of duplicating it.
   */
  async launch(initial: DispatchRecord): Promise<DispatchRecord> {
    const { log, store, providers } = this.deps;
    let record = this.patch(initial, { state: "launching", reason: null, autoResume: false, attempts: initial.attempts + 1 });
    const resuming = initial.step !== null;
    this.event(record, "launch", resuming ? `Resuming launch at step ${initial.step} (attempt ${record.attempts})` : `Launching (attempt ${record.attempts})`);
    log.log("launch", `${record.identifier} ${resuming ? `resuming at ${initial.step}` : "starting launch"}: ${record.title}`);

    let ticket: Ticket;
    try {
      ticket = await providers.tickets.getTicket({ id: record.issueId, identifier: record.identifier });
    } catch (error) {
      return this.fail(record, "worktree", `Could not load ticket details: ${(error as Error).message}`);
    }

    let step: LaunchStep = "worktree";
    try {
      const worktree = await this.stepWorktree(record, ticket);
      record = worktree.record;
      step = "setup";
      record = await this.stepSetup(record, worktree.ranSetupHooks);
      step = "workspace";
      record = await this.stepWorkspace(record);
      step = "agent";
      record = await this.stepAgent(record);
      step = "prompt";
      record = await this.stepPrompt(record, ticket);
    } catch (error) {
      if (error instanceof Attention) return this.attention(record, step, error.message, error.autoResume);
      if (error instanceof UserActionRequired) {
        return this.attention(record, step, `${error.message}, then run \`drovr retry ${record.identifier}\`.`, false);
      }
      return this.fail(record, step, (error as Error).message);
    }

    record = this.patch(record, { state: "running", step: null, launchedAt: new Date().toISOString() });
    this.event(record, "running", `Agent ${record.agentName} is working in workspace ${record.workspaceId}`);
    log.log("launch", `${record.identifier} launched: ${this.deps.providers.agent.displayName} "${record.agentName}" is working in Herdr workspace ${record.workspaceId}`);
    store.setMeta(this.workflow, "last_launch_at", new Date().toISOString());
    return this.moveTicket(record, ticket);
  }

  /**
   * Moves the ticket to `tickets.startedState` once its agent has it. Only tickets that are not
   * started yet move, so a retry never drags a ticket in review back. A failure is logged and
   * retried on later polls; it never fails the launch.
   */
  async moveTicket(record: DispatchRecord, ticket?: Ticket): Promise<DispatchRecord> {
    const { config, providers, log } = this.deps;
    const target = config.tickets.startedState;
    const tickets = providers.tickets;
    if (!target || record.ticketMovedAt || !record.promptedAt || !tickets.moveTicket) return record;
    try {
      const current = ticket ?? (await tickets.getTicket({ id: record.issueId, identifier: record.identifier }));
      const now = new Date().toISOString();
      if (current.state.name.toLowerCase() === target.toLowerCase()) return this.patch(record, { ticketMovedAt: now });
      if (!NOT_STARTED_TYPES.has(current.state.type.toLowerCase())) {
        log.detail(`${record.identifier} is already "${current.state.name}" in ${tickets.id} — not moving it to "${target}"`);
        return this.patch(record, { ticketMovedAt: now });
      }
      await tickets.moveTicket({ id: record.issueId, identifier: record.identifier }, target);
      log.log("launch", `${record.identifier} moved from "${current.state.name}" to "${target}" in ${tickets.id}`);
      this.event(record, "ticket_moved", `${current.state.name} → ${target}`);
      return this.patch(record, { ticketMovedAt: now });
    } catch (error) {
      log.log("warn", `${record.identifier}: could not move the ticket to "${target}": ${(error as Error).message} — will retry on the next poll`);
      this.event(record, "ticket_move_failed", (error as Error).message);
      return record;
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────────

  private async stepWorktree(record: DispatchRecord, ticket: Ticket): Promise<{ record: DispatchRecord; ranSetupHooks: boolean }> {
    const { log } = this.deps;
    record = this.patch(record, { step: "worktree" });

    if (record.worktreePath && record.repoPath) {
      const worktrees = await this.vcsFor(record).listWorktrees(record.repoPath);
      if (worktrees.some((w) => w.path === record.worktreePath)) {
        log.detail(`worktree ${record.worktreePath} already exists — reusing it`);
        return { record, ranSetupHooks: false };
      }
    }

    const plan = await this.plan(ticket);
    const { repo, branch, baseBranch } = plan;
    const vcs = this.deps.providers.vcsFor(repo);
    let worktreePath = plan.worktreePath;
    let ranSetupHooks = false;
    const worktrees = await vcs.listWorktrees(repo.path);
    const atPath = worktrees.find((w) => w.path === worktreePath);
    if (atPath) {
      if (atPath.branch !== branch) {
        throw new Attention(`${worktreePath} is already a worktree for branch ${atPath.branch ?? "(detached)"}, not ${branch}`);
      }
      log.detail(`worktree ${worktreePath} on ${branch} already exists — adopting it`);
    } else {
      const elsewhere = worktrees.find((w) => w.branch === branch);
      if (elsewhere) throw new Attention(`Branch ${branch} is already checked out at ${elsewhere.path}; finish or remove that worktree first`);
      if (existsSync(worktreePath)) throw new Attention(`${worktreePath} exists but is not a git worktree of ${repo.path}`);

      let startPoint = baseBranch;
      if (repo.fetch) {
        log.detail(`fetching ${repo.remote}/${baseBranch}`);
        await vcs.fetch(repo.path, repo.remote, baseBranch);
        startPoint = `${repo.remote}/${baseBranch}`;
      }
      const branchExists = await vcs.branchExists(repo.path, branch);
      log.detail(
        `${branchExists ? `checking out existing branch ${branch}` : `creating branch ${branch} from ${startPoint}`} at ${worktreePath} via ${vcs.id}` +
          (vcs.runSetupHooks ? " — waiting for its pre-start hooks to finish before starting the agent" : ""),
      );
      const started = Date.now();
      const created = await vcs.addWorktree({ repoPath: repo.path, path: worktreePath, branch, base: startPoint, createBranch: !branchExists });
      ranSetupHooks = created.ranSetupHooks;
      if (created.path !== worktreePath) {
        log.detail(`${vcs.id} placed the worktree at ${created.path}`);
        worktreePath = created.path;
      }
      log.detail(`worktree ready in ${seconds(started)}${ranSetupHooks ? " (pre-start hooks done)" : ""}`);
    }

    this.event(record, "worktree", `Worktree ${worktreePath} on ${branch} via ${vcs.id}${ranSetupHooks ? " (hooks ran)" : ""}`);
    return { record: this.patch(record, { repoPath: repo.path, baseBranch, branch, worktreePath }), ranSetupHooks };
  }

  /**
   * Blocks until the worktree is fully set up: the worktree provider's hooks (unless they already
   * ran while creating it in this attempt), then drovr's own setup commands.
   */
  private async stepSetup(record: DispatchRecord, ranSetupHooks: boolean): Promise<DispatchRecord> {
    const { log, exec } = this.deps;
    record = this.patch(record, { step: "setup" });
    if (record.setupDoneAt) return record;
    const vcs = this.vcsFor(record);
    if (!ranSetupHooks && vcs.runSetupHooks) {
      // Adopted after an interruption or a failed hook: their outcome is unknown, so run them again.
      log.detail(`running ${vcs.id} pre-start hooks in ${record.worktreePath} (blocking)`);
      const started = Date.now();
      await vcs.runSetupHooks(record.worktreePath!);
      log.detail(`${vcs.id} hooks done in ${seconds(started)}`);
      this.event(record, "setup", `Re-ran ${vcs.id} pre-start hooks`);
    }
    const commands = this.repoFor(record)?.setup ?? [];
    for (const command of commands) {
      const started = Date.now();
      log.detail(`setup: ${command}`);
      const result = await exec("/bin/sh", ["-c", command], { cwd: record.worktreePath!, timeoutMs: SETUP_TIMEOUT_MS });
      if (result.code !== 0) throw new Error(`Setup command failed: ${describeFailure(result)}`);
      log.detail(`setup: done in ${seconds(started)}`);
    }
    if (commands.length > 0) this.event(record, "setup", `Ran ${commands.length} setup command(s)`);
    return this.patch(record, { setupDoneAt: new Date().toISOString() });
  }

  private repoFor(record: DispatchRecord) {
    return this.deps.config.repositories.find((r) => r.path === record.repoPath);
  }

  private vcsFor(record: DispatchRecord) {
    const repo = this.repoFor(record);
    if (!repo) throw new Error(`Repository ${record.repoPath} is no longer configured`);
    return this.deps.providers.vcsFor(repo);
  }

  private async stepWorkspace(record: DispatchRecord): Promise<DispatchRecord> {
    const { providers, log, config } = this.deps;
    record = this.patch(record, { step: "workspace" });
    const terminal = providers.terminal;

    if (record.workspaceId && record.paneId && (await terminal.workspaceExists(record.workspaceId))) {
      log.detail(`workspace ${record.workspaceId} already exists — reusing it`);
      return record;
    }
    const label = render(config.terminal.workspaceLabel, ticketVars(ticketFromRecord(record)));
    // A previous attempt may have created the workspace without us recording the response.
    const found = await terminal.findWorkspace({ label, cwd: record.worktreePath! });
    if (found) {
      log.detail(`found workspace ${found.workspaceId} "${label}" from an interrupted launch — adopting it`);
      return this.patch(record, { workspaceId: found.workspaceId, paneId: found.paneId });
    }
    const created = await terminal.createWorkspace({
      cwd: record.worktreePath!,
      label,
      focus: config.terminal.focus,
      env: { ...config.agent.env, DROVR_TICKET: record.identifier, DROVR_WORKFLOW: this.workflow },
    });
    log.detail(`created Herdr workspace ${created.workspaceId} "${label}" (pane ${created.paneId}${config.terminal.focus ? "" : ", not focused"})`);
    this.event(record, "workspace", `Workspace ${created.workspaceId}, pane ${created.paneId}`);
    return this.patch(record, { workspaceId: created.workspaceId, paneId: created.paneId });
  }

  private async stepAgent(record: DispatchRecord): Promise<DispatchRecord> {
    const { providers, log, config } = this.deps;
    const terminal = providers.terminal;
    const name = record.agentName ?? safeName(render(config.agent.name, ticketVars(ticketFromRecord(record))));
    const launch = providers.agent.launchSpec(terminal.id, config.agent.args);
    record = this.patch(record, { step: "agent", agentName: name, agentKind: providers.agent.id });

    const byName = await terminal.getAgent(name);
    if (byName && byName.paneId !== record.paneId) {
      throw new Attention(`An agent named "${name}" already exists in pane ${byName.paneId}; rename or close it, then run \`drovr retry ${record.identifier}\``);
    }
    const inPane = byName ?? (await terminal.getAgent(record.paneId!));
    if (inPane) {
      if (inPane.agent && inPane.agent !== launch.kind) {
        throw new Attention(`Pane ${record.paneId} is running ${inPane.agent}, expected ${launch.kind}`);
      }
      if (inPane.interactiveReady === false) {
        throw new Attention(notReadyMessage(providers.agent.displayName, record), true);
      }
      if (inPane.name !== name) await terminal.renameAgent(record.paneId!, name);
      log.detail(`${providers.agent.displayName} is already running in pane ${record.paneId} — adopting it as "${name}"`);
      await this.assertNoBlocker(record, name);
      return record;
    }

    const pane = await terminal.getPane(record.paneId!);
    if (!pane) throw new Error(`Pane ${record.paneId} no longer exists`);
    log.detail(`starting ${providers.agent.displayName} as "${name}" in pane ${record.paneId} (waiting up to ${config.agent.startTimeoutSeconds}s for it to become ready)`);
    const result = await terminal.startAgent({ name, paneId: record.paneId!, launch, timeoutMs: config.agent.startTimeoutSeconds * 1000 });
    if (result.status === "not_ready") {
      log.detail(result.detail);
      throw new Attention(notReadyMessage(providers.agent.displayName, record), true);
    }
    this.event(record, "agent", `Started ${providers.agent.displayName} as ${name}`);
    // A freshly started agent has no context, even if an earlier agent in this pane was prompted.
    record = this.patch(record, { promptIntentAt: null, promptedAt: null });
    const settleMs = this.deps.startupSettleMs ?? STARTUP_SETTLE_MS;
    if (settleMs > 0) await sleep(settleMs);
    await this.assertNoBlocker(record, name);
    return record;
  }

  /**
   * Herdr reports agents as ready while they show startup dialogs (folder trust, login), and a
   * submitted prompt would answer the dialog — trusting the folder, or for Claude Code, exiting.
   * Such dialogs are left to the user.
   */
  async agentBlocker(record: DispatchRecord): Promise<string | undefined> {
    if (!record.agentName) return undefined;
    const screen = await this.deps.providers.terminal.readAgentOutput(record.agentName, 60, "visible");
    return this.deps.providers.agent.detectBlocker(screen);
  }

  private async assertNoBlocker(record: DispatchRecord, name: string): Promise<void> {
    const blocker = await this.agentBlocker({ ...record, agentName: name });
    if (!blocker) return;
    const agent = this.deps.providers.agent.displayName;
    throw new Attention(
      `${agent} is showing a ${blocker}. drovr does not answer these for you: open Herdr workspace ${record.workspaceId} and respond; ` +
        "drovr submits the ticket automatically once the dialog is gone.",
      true,
    );
  }

  private async stepPrompt(record: DispatchRecord, ticket: Ticket): Promise<DispatchRecord> {
    const { providers, log } = this.deps;
    record = this.patch(record, { step: "prompt" });
    if (record.promptedAt) return record;
    const name = record.agentName!;
    const marker = PROMPT_MARKER(record.identifier);

    if (record.promptIntentAt) {
      // The previous attempt tried to submit but we never saw the outcome.
      const output = await providers.terminal.readAgentOutput(name, 400).catch(() => "");
      if (output.includes(marker)) {
        log.detail("the prompt from the interrupted launch is visible in the agent's terminal — not resending");
        return this.patch(record, { promptedAt: new Date().toISOString() });
      }
      throw new Attention(
        `A previous attempt may already have submitted the prompt, but it could not be confirmed. Check workspace ${record.workspaceId}; ` +
          `run \`drovr retry ${record.identifier} --resend-prompt\` to send it again, or \`drovr done ${record.identifier}\` if the agent has it.`,
      );
    }

    const { brief, briefPath, text } = renderPrompt(this.deps.config, this.deps.promptTemplate, ticket, {
      worktreePath: record.worktreePath ?? undefined,
      branch: record.branch ?? undefined,
      baseBranch: record.baseBranch ?? undefined,
      repo: record.repoPath ?? undefined,
      agent: providers.agent.displayName,
    });
    if (briefPath) {
      const path = resolve(record.worktreePath!, briefPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, brief);
      await this.vcsFor(record).excludeLocally(record.repoPath!, `/${briefPath.split("/")[0]!}`);
      log.detail(`wrote the ticket brief to ${path}`);
    }
    await this.assertNoBlocker(record, name);
    record = this.patch(record, { promptIntentAt: new Date().toISOString() });
    const delivery = await providers.terminal.submitPrompt(name, text);
    if (!delivery.confirmed) {
      throw new Attention(
        `The prompt was sent to "${name}" but the agent did not react (${delivery.detail ?? "no state change"}). Check Herdr workspace ${record.workspaceId}: ` +
          `if the ticket text is waiting in the input, press Enter; if it is missing, run \`drovr retry ${record.identifier} --resend-prompt\`; ` +
          `if the agent is working on it, run \`drovr retry ${record.identifier}\` to mark it running.`,
      );
    }
    log.detail(`submitted the ticket prompt (${text.length} characters) to "${name}"; the agent reacted`);
    this.event(record, "prompt", "Prompt submitted and acknowledged");
    return this.patch(record, { promptedAt: new Date().toISOString() });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private patch(record: DispatchRecord, patch: DispatchPatch): DispatchRecord {
    return this.deps.store.update(this.workflow, record.issueId, patch);
  }

  private event(record: DispatchRecord, kind: string, message: string): void {
    this.deps.store.addEvent(this.workflow, record, kind, message);
  }

  private attention(record: DispatchRecord, step: LaunchStep, reason: string, autoResume: boolean): DispatchRecord {
    this.deps.log.log("warn", `${record.identifier} needs your attention (${step}): ${reason}`);
    this.event(record, "needs_attention", `${step}: ${reason}`);
    return this.patch(record, { state: "needs_attention", step, reason, autoResume });
  }

  private fail(record: DispatchRecord, step: LaunchStep, reason: string): DispatchRecord {
    this.deps.log.log("error", `${record.identifier} failed at ${step}: ${reason}`);
    this.deps.log.detail(`fix the cause, then run \`drovr retry ${record.identifier}\``);
    this.event(record, "failed", `${step}: ${reason}`);
    return this.patch(record, { state: "failed", step, reason });
  }
}

function notReadyMessage(agent: string, record: DispatchRecord): string {
  return (
    `${agent} started but has not reported that it is ready for input. It is probably showing a trust, login, or update prompt. ` +
    `Answer it in Herdr workspace ${record.workspaceId}; drovr will submit the ticket once the agent is ready.`
  );
}

/** Minimal ticket view of a record, for template variables. */
function ticketFromRecord(record: DispatchRecord): Ticket {
  return { id: record.issueId, identifier: record.identifier, title: record.title, url: record.url ?? "", state: { name: "", type: "" }, labels: [] };
}

