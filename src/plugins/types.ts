/**
 * Provider contracts. Every external system drovr talks to sits behind one of these
 * interfaces, so new trackers, terminal multiplexers, agents, or VCS backends can be
 * added as plugins without touching the dispatcher.
 */
import type { Exec } from "../core/exec.js";
import type { Logger } from "../core/log.js";

export type ProviderKind = "tickets" | "terminal" | "agent" | "vcs";

/** Thrown by a provider when only the user can unblock it (approve hooks, log in, …). */
export class UserActionRequired extends Error {
  override name = "UserActionRequired";
}

export interface AvailabilityResult {
  ok: boolean;
  /** Short human-readable summary, e.g. "herdr 0.7.5, session pricenow running". */
  detail: string;
  /** Non-fatal observations worth surfacing. */
  warnings?: string[];
}

export interface ProviderContext {
  exec: Exec;
  log: Logger;
}

export interface Provider {
  readonly kind: ProviderKind;
  readonly id: string;
  checkAvailability(): Promise<AvailabilityResult>;
}

// ── Tickets ────────────────────────────────────────────────────────────────

export interface TicketState {
  name: string;
  /** Normalised workflow category: triage | backlog | unstarted | started | completed | canceled. */
  type: string;
}

export interface Ticket {
  /** Stable provider-side ID. Dispatch records are keyed by this. */
  id: string;
  /** Human-facing key, e.g. PQ-1234. */
  identifier: string;
  title: string;
  url: string;
  state: TicketState;
  labels: string[];
  team?: string;
  assignee?: string;
  project?: string;
  priority?: number;
  createdAt?: string;
  updatedAt?: string;
  /** Provider-suggested git branch name, if any. */
  branchName?: string;
  description?: string;
}

export interface TicketCriteria {
  team?: string;
  /** Ticket must carry every one of these labels. */
  labels: string[];
  /** Ticket must carry none of these labels. */
  excludeLabels: string[];
  /** Ticket state name or type must match one of these. Empty = any state. */
  states: string[];
  /** "any", "none" (unassigned), "@me", or a user identifier. */
  assignee: string;
  project?: string;
}

export interface TicketSource extends Provider {
  readonly kind: "tickets";
  /** Human-readable summary of the query, for logs. */
  describeQuery(criteria: TicketCriteria): string;
  /** Optional startup check that the criteria refer to things that exist (team, labels). */
  validateCriteria?(criteria: TicketCriteria): Promise<AvailabilityResult>;
  /** Fetch all candidate tickets (handles pagination). Results may be a superset; drovr re-filters. */
  listCandidates(criteria: TicketCriteria): Promise<Ticket[]>;
  /** Fetch full details (description, branch name) for prompting. */
  getTicket(ref: { id: string; identifier: string }): Promise<Ticket>;
  /** Move a ticket to a workflow state (by name or type). Optional: sources without it cannot update tickets. */
  moveTicket?(ref: { id: string; identifier: string }, state: string): Promise<void>;
  /** Optional startup check that a workflow state exists for the team. */
  checkState?(state: string, team?: string): Promise<AvailabilityResult>;
}

// ── Terminal multiplexer ───────────────────────────────────────────────────

export type AgentActivity = "idle" | "working" | "blocked" | "done" | "unknown";

export interface WorkspaceRef {
  workspaceId: string;
  paneId: string;
}

export interface PaneState {
  paneId: string;
  workspaceId: string;
  cwd?: string;
  /** Agent detected in the pane (e.g. "claude"), if any. */
  agent?: string;
  agentName?: string;
  activity: AgentActivity;
  interactiveReady?: boolean;
}

export interface AgentState {
  name?: string;
  paneId: string;
  workspaceId: string;
  agent?: string;
  activity: AgentActivity;
  /** False while the agent is up but not accepting input yet (e.g. a startup dialog). */
  interactiveReady?: boolean;
}

export interface AgentLaunch {
  /** Terminal-specific agent kind (e.g. herdr's --kind). */
  kind: string;
  args: string[];
}

export type StartAgentResult =
  | { status: "ready"; agent: AgentState }
  /** The agent did not report readiness in time; usually a trust/auth/approval dialog. */
  | { status: "not_ready"; detail: string };

export interface TerminalProvider extends Provider {
  readonly kind: "terminal";
  /** Agent kinds this terminal can launch, or undefined if unknown. */
  supportedAgentKinds(): string[] | undefined;
  createWorkspace(opts: { cwd: string; label: string; focus: boolean; env: Record<string, string> }): Promise<WorkspaceRef>;
  /** Find an existing workspace by label whose root pane is in cwd (used to reconcile lost responses). */
  findWorkspace(opts: { label: string; cwd: string }): Promise<WorkspaceRef | undefined>;
  workspaceExists(workspaceId: string): Promise<boolean>;
  listWorkspaceIds(): Promise<Set<string>>;
  getPane(paneId: string): Promise<PaneState | undefined>;
  startAgent(opts: { name: string; paneId: string; launch: AgentLaunch; timeoutMs: number }): Promise<StartAgentResult>;
  getAgent(name: string): Promise<AgentState | undefined>;
  listAgents(): Promise<AgentState[]>;
  renameAgent(target: string, name: string): Promise<void>;
  /** Submits a prompt; `confirmed` is false when the agent showed no reaction (prompt likely swallowed). */
  submitPrompt(agentName: string, text: string): Promise<{ confirmed: boolean; detail?: string }>;
  /** Terminal output of an agent: what is on screen now ("visible") or recent scrollback ("recent"). */
  readAgentOutput(agentName: string, lines: number, source?: "visible" | "recent"): Promise<string>;
}

// ── Coding agents ──────────────────────────────────────────────────────────

export interface AgentProvider extends Provider {
  readonly kind: "agent";
  /** Display name, e.g. "Codex". */
  readonly displayName: string;
  /** How to launch this agent in the given terminal provider. */
  launchSpec(terminalId: string, extraArgs: string[]): AgentLaunch;
  /**
   * Recognises startup screens that must be answered by the user (folder trust, login, …).
   * Terminal readiness detection does not catch these, and a submitted prompt would answer them.
   * Returns a short description of the blocking screen, or undefined.
   */
  detectBlocker(screen: string): string | undefined;
}

// ── Version control ────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch?: string;
}

export interface VcsProvider extends Provider {
  readonly kind: "vcs";
  checkRepository(repoPath: string): Promise<AvailabilityResult>;
  defaultBranch(repoPath: string, remote: string): Promise<string>;
  listWorktrees(repoPath: string): Promise<WorktreeInfo[]>;
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  fetch(repoPath: string, remote: string, branch: string): Promise<void>;
  /** Adds a pattern to the repository's local, uncommitted ignore list (info/exclude). */
  excludeLocally(repoPath: string, pattern: string): Promise<void>;
  /**
   * Create a worktree at path on a new branch from base, or check out an existing branch.
   * Returns the actual path and whether the provider's own setup hooks already ran (blocking).
   */
  addWorktree(opts: { repoPath: string; path: string; branch: string; base: string; createBranch: boolean }): Promise<{ path: string; ranSetupHooks: boolean }>;
  /** Re-runs the provider's blocking setup hooks in an existing worktree (after an interrupted or failed launch). */
  runSetupHooks?(worktreePath: string): Promise<void>;
}

export type AnyProvider = TicketSource | TerminalProvider | AgentProvider | VcsProvider;
