import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, configSchema } from "../src/config/schema.js";
import { Dispatcher } from "../src/core/dispatcher.js";
import type { Exec } from "../src/core/exec.js";
import { type Logger } from "../src/core/log.js";
import { Store } from "../src/core/store.js";
import { DEFAULT_PROMPT } from "../src/core/template.js";
import type { Providers } from "../src/plugins/registry.js";
import type { AgentState, PaneState, StartAgentResult, TerminalProvider, Ticket, TicketSource, VcsProvider, WorktreeInfo } from "../src/plugins/types.js";

export function ticket(n: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: `uuid-${n}`,
    identifier: `PQ-${n}`,
    title: `Ticket ${n}`,
    url: `https://linear.app/x/issue/PQ-${n}`,
    state: { name: "Todo", type: "unstarted" },
    labels: ["agent-ready"],
    priority: 2,
    createdAt: `2026-01-${String(n % 28 + 1).padStart(2, "0")}T00:00:00Z`,
    branchName: `feature/pq-${n}-ticket`,
    description: `Do thing ${n}`,
    ...overrides,
  };
}

export class FakeTickets implements TicketSource {
  readonly kind = "tickets" as const;
  readonly id = "fake";
  tickets: Ticket[] = [];
  async checkAvailability() {
    return { ok: true, detail: "fake" };
  }
  describeQuery() {
    return "fake query";
  }
  async listCandidates() {
    return this.tickets.map((t) => ({ ...t, description: undefined }));
  }
  moves: string[] = [];
  failNextMove = false;
  async moveTicket(ref: { id: string; identifier: string }, state: string) {
    if (this.failNextMove) {
      this.failNextMove = false;
      throw new Error("Linear unavailable");
    }
    this.moves.push(`${ref.identifier}→${state}`);
    const found = this.tickets.find((t) => t.id === ref.id)!;
    found.state = { name: state, type: "started" };
  }
  async getTicket(ref: { id: string }) {
    const found = this.tickets.find((t) => t.id === ref.id);
    if (!found) throw new Error(`no ticket ${ref.id}`);
    return found;
  }
}

export class FakeVcs implements VcsProvider {
  readonly kind = "vcs" as const;
  readonly id = "fake-git";
  worktrees: WorktreeInfo[] = [];
  branches = new Set<string>();
  async checkAvailability() {
    return { ok: true, detail: "fake" };
  }
  async checkRepository() {
    return { ok: true, detail: "fake" };
  }
  async defaultBranch() {
    return "main";
  }
  async listWorktrees() {
    return [...this.worktrees];
  }
  async branchExists(_: string, branch: string) {
    return this.branches.has(branch);
  }
  async fetch() {}
  excluded: string[] = [];
  async excludeLocally(_: string, pattern: string) {
    this.excluded.push(pattern);
  }
  /** Simulates worktrunk: creation runs setup hooks, and they can be re-run. */
  hooks = false;
  hookRuns: string[] = [];
  /** Makes the next creation leave a worktree behind but fail in its hooks. */
  failHooksOnCreate = false;
  async addWorktree(opts: { path: string; branch: string }) {
    this.worktrees.push({ path: opts.path, branch: opts.branch });
    this.branches.add(opts.branch);
    if (this.hooks) {
      if (this.failHooksOnCreate) {
        this.failHooksOnCreate = false;
        throw new Error("pre-start hook failed");
      }
      this.hookRuns.push(`create:${opts.path}`);
    }
    return { path: opts.path, ranSetupHooks: this.hooks };
  }
  get runSetupHooks() {
    return this.hooks ? async (path: string) => void this.hookRuns.push(`rerun:${path}`) : undefined;
  }
}

interface FakeWorkspace {
  id: string;
  label: string;
  env: Record<string, string>;
  pane: PaneState;
}

export class FakeTerminal implements TerminalProvider {
  readonly kind = "terminal" as const;
  readonly id = "herdr";
  workspaces: FakeWorkspace[] = [];
  agents: AgentState[] = [];
  prompts: { agent: string; text: string }[] = [];
  calls: string[] = [];
  /** Makes the next createWorkspace succeed but throw as if its response was lost. */
  loseNextCreateResponse = false;
  /** Makes startAgent report not_ready, leaving an unready agent in the pane. */
  startNotReady = false;
  /** Makes submitPrompt deliver the prompt but throw afterwards. */
  losePromptResponse = false;
  /** Makes the next prompt vanish without the agent reacting. */
  swallowNextPrompt = false;
  output = "";
  /** What is on screen now (startup dialogs). */
  screen = "";
  private seq = 0;

  async checkAvailability() {
    return { ok: true, detail: "fake" };
  }
  supportedAgentKinds() {
    return ["codex", "claude"];
  }
  async createWorkspace(opts: { cwd: string; label: string; env: Record<string, string> }) {
    this.calls.push("createWorkspace");
    const id = `w${++this.seq}`;
    const pane: PaneState = { paneId: `${id}:p1`, workspaceId: id, cwd: opts.cwd, activity: "unknown" };
    this.workspaces.push({ id, label: opts.label, env: opts.env, pane });
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new Error("socket closed");
    }
    return { workspaceId: id, paneId: pane.paneId };
  }
  async findWorkspace(opts: { label: string; cwd: string }) {
    const ws = this.workspaces.find((w) => w.label === opts.label && w.pane.cwd === opts.cwd);
    return ws && { workspaceId: ws.id, paneId: ws.pane.paneId };
  }
  async workspaceExists(id: string) {
    return this.workspaces.some((w) => w.id === id);
  }
  async listWorkspaceIds() {
    return new Set(this.workspaces.map((w) => w.id));
  }
  async getPane(paneId: string) {
    return this.workspaces.find((w) => w.pane.paneId === paneId)?.pane;
  }
  async startAgent(opts: { name: string; paneId: string; launch: { kind: string } }): Promise<StartAgentResult> {
    this.calls.push("startAgent");
    const ws = this.workspaces.find((w) => w.pane.paneId === opts.paneId)!;
    const agent: AgentState = { name: undefined, paneId: opts.paneId, workspaceId: ws.id, agent: opts.launch.kind, activity: "unknown", interactiveReady: false };
    this.agents.push(agent);
    if (this.startNotReady) return { status: "not_ready", detail: "timeout" };
    agent.name = opts.name;
    agent.activity = "idle";
    agent.interactiveReady = true;
    return { status: "ready", agent };
  }
  async getAgent(target: string) {
    return this.agents.find((a) => a.name === target || a.paneId === target);
  }
  async listAgents() {
    return [...this.agents];
  }
  async renameAgent(target: string, name: string) {
    const agent = await this.getAgent(target);
    if (agent) agent.name = name;
  }
  async submitPrompt(agent: string, text: string) {
    this.calls.push("submitPrompt");
    if (this.swallowNextPrompt) {
      this.swallowNextPrompt = false;
      return { confirmed: false, detail: "agent_prompt_stalled" };
    }
    this.prompts.push({ agent, text });
    this.output += text;
    if (this.losePromptResponse) {
      this.losePromptResponse = false;
      throw new Error("socket closed");
    }
    return { confirmed: true };
  }
  async readAgentOutput(_: string, __: number, source?: "visible" | "recent") {
    return source === "visible" ? this.screen : this.output;
  }
  /** Simulates the user answering a startup dialog. */
  makeReady(paneId: string) {
    const agent = this.agents.find((a) => a.paneId === paneId)!;
    agent.interactiveReady = true;
    agent.activity = "idle";
  }
}

export const noExec: Exec = async (command, args) => ({ command, args, code: 0, stdout: "", stderr: "", timedOut: false });

export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (topic, message) => lines.push(`${topic}: ${message}`), detail: (message) => lines.push(`  ${message}`) };
}

export function harness(configInput: Record<string, unknown> = {}) {
  const config: Config = configSchema.parse({
    terminal: { session: "test" },
    repositories: [{ path: "/repo", fetch: false }],
    prompt: { delivery: "inline" },
    ...configInput,
  });
  const store = new Store(":memory:");
  const tickets = new FakeTickets();
  const terminal = new FakeTerminal();
  const vcs = new FakeVcs();
  const providers: Providers = {
    tickets,
    terminal,
    vcsFor: () => vcs,
    agent: {
      kind: "agent",
      id: "codex",
      displayName: "Codex",
      checkAvailability: async () => ({ ok: true, detail: "fake" }),
      launchSpec: (_terminal, args) => ({ kind: "codex", args }),
      detectBlocker: (screen) => (screen.includes("Trust this folder?") ? "folder trust prompt" : undefined),
    },
  };
  const log = recordingLogger();
  const dispatcher = new Dispatcher({ config, store, providers, log, exec: noExec, promptTemplate: DEFAULT_PROMPT, startupSettleMs: 0 });
  return { config, store, tickets, terminal, vcs, providers, log, dispatcher };
}

/** A git repository with an origin remote, in a fresh temporary directory. */
export function gitRepo(remote = "git@github.com:Acme/Web-App.git"): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "drovr-repo-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", remote);
  return dir;
}
