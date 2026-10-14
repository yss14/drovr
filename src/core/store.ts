import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Dispatch lifecycle:
 *
 *   baseline         matched on the first poll of a workflow; recorded as seen, never launched
 *   launching        the launch pipeline is in progress (see `step`)
 *   running          prompt submitted; the agent is working the ticket
 *   needs_attention  the launch stopped at a step that needs the user (dialog, conflict, uncertain prompt)
 *   failed           a step failed; nothing retries it until `drovr retry`
 *   retry            the user asked to resume; the watcher picks it up when a slot is free
 *   finished         the agent finished its first run on the ticket; the slot is free, the workspace stays
 *   completed        the ticket reached a completion state, its workspace closed, or `drovr done` was run
 */
export type DispatchState = "baseline" | "launching" | "running" | "needs_attention" | "failed" | "retry" | "finished" | "completed";

/** States that occupy a concurrency slot. */
export const ACTIVE_STATES: DispatchState[] = ["launching", "running", "needs_attention"];

export type LaunchStep = "worktree" | "setup" | "workspace" | "agent" | "prompt";

export interface DispatchRecord {
  workflow: string;
  issueId: string;
  identifier: string;
  title: string;
  url: string | null;
  state: DispatchState;
  step: LaunchStep | null;
  reason: string | null;
  /** When set, the watcher resumes automatically once the condition clears (e.g. agent became ready). */
  autoResume: boolean;
  repoPath: string | null;
  baseBranch: string | null;
  branch: string | null;
  worktreePath: string | null;
  setupDoneAt: string | null;
  workspaceId: string | null;
  paneId: string | null;
  agentName: string | null;
  agentKind: string | null;
  agentStatus: string | null;
  /** Set before the prompt is submitted; with promptedAt null it means the outcome is unknown. */
  promptIntentAt: string | null;
  promptedAt: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  launchedAt: string | null;
  completedAt: string | null;
  /** When the ticket was moved to the configured "started" state in the tracker. */
  ticketMovedAt: string | null;
}

export interface DispatchEvent {
  id: number;
  workflow: string;
  issueId: string;
  identifier: string;
  at: string;
  kind: string;
  message: string;
}

export interface WatcherLease {
  workflow: string;
  token: string;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dispatches (
  workflow TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  state TEXT NOT NULL,
  step TEXT,
  reason TEXT,
  auto_resume INTEGER NOT NULL DEFAULT 0,
  repo_path TEXT,
  base_branch TEXT,
  branch TEXT,
  worktree_path TEXT,
  setup_done_at TEXT,
  workspace_id TEXT,
  pane_id TEXT,
  agent_name TEXT,
  agent_kind TEXT,
  agent_status TEXT,
  prompt_intent_at TEXT,
  prompted_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  launched_at TEXT,
  completed_at TEXT,
  ticket_moved_at TEXT,
  PRIMARY KEY (workflow, issue_id)
);
CREATE INDEX IF NOT EXISTS dispatches_identifier ON dispatches (workflow, identifier);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_issue ON events (workflow, issue_id, id);
CREATE TABLE IF NOT EXISTS workflow_meta (
  workflow TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (workflow, key)
);
CREATE TABLE IF NOT EXISTS watchers (
  workflow TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
`;

const COLUMNS: Record<keyof Omit<DispatchRecord, "workflow" | "issueId">, string> = {
  identifier: "identifier",
  title: "title",
  url: "url",
  state: "state",
  step: "step",
  reason: "reason",
  autoResume: "auto_resume",
  repoPath: "repo_path",
  baseBranch: "base_branch",
  branch: "branch",
  worktreePath: "worktree_path",
  setupDoneAt: "setup_done_at",
  workspaceId: "workspace_id",
  paneId: "pane_id",
  agentName: "agent_name",
  agentKind: "agent_kind",
  agentStatus: "agent_status",
  promptIntentAt: "prompt_intent_at",
  promptedAt: "prompted_at",
  attempts: "attempts",
  createdAt: "created_at",
  updatedAt: "updated_at",
  launchedAt: "launched_at",
  completedAt: "completed_at",
  ticketMovedAt: "ticket_moved_at",
};

/** Columns added after the first release; created on databases that predate them. */
const ADDED_COLUMNS: [string, string][] = [["ticket_moved_at", "TEXT"]];

type Row = Record<string, unknown>;

function toRecord(row: Row): DispatchRecord {
  const record: Record<string, unknown> = { workflow: row.workflow, issueId: row.issue_id };
  for (const [key, column] of Object.entries(COLUMNS)) record[key] = row[column];
  record.autoResume = Boolean(row.auto_resume);
  return record as unknown as DispatchRecord;
}

const now = () => new Date().toISOString();

export type DispatchPatch = Partial<Omit<DispatchRecord, "workflow" | "issueId" | "createdAt" | "updatedAt">>;

export class Store {
  readonly db: Database.Database;

  constructor(path: string, opts: { readonly?: boolean } = {}) {
    if (path !== ":memory:" && !opts.readonly) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { readonly: Boolean(opts.readonly), fileMustExist: Boolean(opts.readonly) });
    this.db.pragma("busy_timeout = 5000");
    if (!opts.readonly) {
      this.db.pragma("journal_mode = WAL");
      this.db.exec(SCHEMA);
      const existing = new Set((this.db.prepare("PRAGMA table_info(dispatches)").all() as { name: string }[]).map((c) => c.name));
      for (const [column, type] of ADDED_COLUMNS) {
        if (!existing.has(column)) this.db.exec(`ALTER TABLE dispatches ADD COLUMN ${column} ${type}`);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Dispatches ───────────────────────────────────────────────────────────

  get(workflow: string, issueId: string): DispatchRecord | undefined {
    const row = this.db.prepare("SELECT * FROM dispatches WHERE workflow = ? AND issue_id = ?").get(workflow, issueId) as Row | undefined;
    return row && toRecord(row);
  }

  /** Looks up by issue ID or (case-insensitive) identifier. */
  find(workflow: string, ref: string): DispatchRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM dispatches WHERE workflow = ? AND (issue_id = ? OR identifier = ? COLLATE NOCASE) ORDER BY updated_at DESC LIMIT 1")
      .get(workflow, ref, ref) as Row | undefined;
    return row && toRecord(row);
  }

  list(workflow: string, opts: { states?: DispatchState[]; limit?: number } = {}): DispatchRecord[] {
    const states = opts.states ?? [];
    const where = states.length > 0 ? `AND state IN (${states.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(`SELECT * FROM dispatches WHERE workflow = ? ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(workflow, ...states, opts.limit ?? -1) as Row[];
    return rows.map(toRecord);
  }

  countActive(workflow: string): number {
    const placeholders = ACTIVE_STATES.map(() => "?").join(",");
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM dispatches WHERE workflow = ? AND state IN (${placeholders})`)
      .get(workflow, ...ACTIVE_STATES) as { n: number };
    return row.n;
  }

  /**
   * Atomically creates a dispatch record. Returns undefined if one already exists, so two
   * processes can never both claim the same ticket.
   */
  claim(
    workflow: string,
    ticket: { id: string; identifier: string; title: string; url?: string },
    state: DispatchState,
    reason?: string,
  ): DispatchRecord | undefined {
    const ts = now();
    const result = this.db
      .prepare(
        `INSERT INTO dispatches (workflow, issue_id, identifier, title, url, state, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(workflow, ticket.id, ticket.identifier, ticket.title, ticket.url ?? null, state, reason ?? null, ts, ts);
    return result.changes === 1 ? this.get(workflow, ticket.id) : undefined;
  }

  update(workflow: string, issueId: string, patch: DispatchPatch): DispatchRecord {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    const sets = entries.map(([key]) => `${COLUMNS[key as keyof typeof COLUMNS]} = ?`);
    const values = entries.map(([key, value]) => (key === "autoResume" ? (value ? 1 : 0) : value));
    this.db
      .prepare(`UPDATE dispatches SET ${[...sets, "updated_at = ?"].join(", ")} WHERE workflow = ? AND issue_id = ?`)
      .run(...(values as unknown[]), now(), workflow, issueId);
    const record = this.get(workflow, issueId);
    if (!record) throw new Error(`Dispatch ${issueId} not found in workflow ${workflow}`);
    return record;
  }

  delete(workflow: string, issueId: string): void {
    this.db.prepare("DELETE FROM dispatches WHERE workflow = ? AND issue_id = ?").run(workflow, issueId);
  }

  // ── Events ───────────────────────────────────────────────────────────────

  addEvent(workflow: string, record: { issueId: string; identifier: string }, kind: string, message: string): void {
    this.db
      .prepare("INSERT INTO events (workflow, issue_id, identifier, at, kind, message) VALUES (?, ?, ?, ?, ?, ?)")
      .run(workflow, record.issueId, record.identifier, now(), kind, message);
  }

  events(workflow: string, issueId?: string, limit = 200): DispatchEvent[] {
    const rows = (
      issueId
        ? this.db.prepare("SELECT * FROM events WHERE workflow = ? AND issue_id = ? ORDER BY id DESC LIMIT ?").all(workflow, issueId, limit)
        : this.db.prepare("SELECT * FROM events WHERE workflow = ? ORDER BY id DESC LIMIT ?").all(workflow, limit)
    ) as Row[];
    return rows
      .map((row) => ({
        id: row.id as number,
        workflow: row.workflow as string,
        issueId: row.issue_id as string,
        identifier: row.identifier as string,
        at: row.at as string,
        kind: row.kind as string,
        message: row.message as string,
      }))
      .reverse();
  }

  // ── Workflow metadata ────────────────────────────────────────────────────

  getMeta(workflow: string, key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM workflow_meta WHERE workflow = ? AND key = ?").get(workflow, key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(workflow: string, key: string, value: string): void {
    this.db
      .prepare("INSERT INTO workflow_meta (workflow, key, value) VALUES (?, ?, ?) ON CONFLICT (workflow, key) DO UPDATE SET value = excluded.value")
      .run(workflow, key, value);
  }

  // ── Watcher lease ────────────────────────────────────────────────────────

  getLease(workflow: string): WatcherLease | undefined {
    const row = this.db.prepare("SELECT * FROM watchers WHERE workflow = ?").get(workflow) as Row | undefined;
    if (!row) return undefined;
    return {
      workflow: row.workflow as string,
      token: row.token as string,
      pid: row.pid as number,
      host: row.host as string,
      startedAt: row.started_at as string,
      heartbeatAt: row.heartbeat_at as string,
    };
  }

  /**
   * Takes the single-watcher lease for a workflow. An existing lease is taken over only if its
   * heartbeat is older than staleAfterMs or its process is gone (same host).
   */
  acquireLease(workflow: string, staleAfterMs: number): { ok: true; token: string; tookOver?: WatcherLease } | { ok: false; holder: WatcherLease } {
    const host = hostname();
    return this.db.transaction(() => {
      const existing = this.getLease(workflow);
      if (existing && !isLeaseStale(existing, staleAfterMs, host)) return { ok: false as const, holder: existing };
      const token = randomUUID();
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO watchers (workflow, token, pid, host, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (workflow) DO UPDATE SET token = excluded.token, pid = excluded.pid, host = excluded.host,
             started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
        )
        .run(workflow, token, process.pid, host, ts, ts);
      return { ok: true as const, token, tookOver: existing };
    }).immediate();
  }

  /** Refreshes the heartbeat. Returns false if the lease was taken over by another process. */
  heartbeat(workflow: string, token: string): boolean {
    return this.db.prepare("UPDATE watchers SET heartbeat_at = ? WHERE workflow = ? AND token = ?").run(now(), workflow, token).changes === 1;
  }

  releaseLease(workflow: string, token: string): void {
    this.db.prepare("DELETE FROM watchers WHERE workflow = ? AND token = ?").run(workflow, token);
  }
}

export function isLeaseStale(lease: WatcherLease, staleAfterMs: number, host = hostname()): boolean {
  if (Date.now() - Date.parse(lease.heartbeatAt) > staleAfterMs) return true;
  return lease.host === host && !processAlive(lease.pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
