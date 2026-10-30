import { describeFailure, which } from "../../core/exec.js";
import type { AvailabilityResult, ProviderContext, Ticket, TicketCriteria, TicketSource } from "../types.js";

interface GithubOptions {
  /** `[HOST/]OWNER/REPO`. Defaults to the repository gh finds in `cwd`. */
  repo?: string;
  /** Directory gh resolves the repository from when `repo` is not set (the first configured repository). */
  cwd?: string;
  binary?: string;
}

type Json = Record<string, unknown>;

export class GithubError extends Error {
  override name = "GithubError";
}

/** Issues have no workflow states: "open" and "closed" map to the normalised state types drovr uses. */
const OPEN_TYPES = new Set(["open", "triage", "backlog", "unstarted", "started"]);
const CLOSED_TYPES = new Set(["closed", "completed", "canceled"]);
const ISSUE_FIELDS = "id,number,title,url,state,stateReason,labels,assignees,milestone,createdAt,updatedAt";
/** gh needs a number; no repository needs more candidates than this per poll. */
const LIST_LIMIT = "1000";

/** "GH-12", "#12", or "12" → 12. */
export function issueNumber(ref: string): string {
  const match = /(\d+)$/.exec(ref.trim());
  if (!match) throw new GithubError(`"${ref}" is not a GitHub issue number (expected e.g. GH-12 or 12)`);
  return match[1]!;
}

export function createGithubProvider(ctx: ProviderContext, options: GithubOptions = {}): TicketSource {
  const binary = options.binary ?? "gh";
  const repoArgs = options.repo ? ["--repo", options.repo] : [];

  async function gh(args: string[]): Promise<string> {
    const result = await ctx.exec(binary, args, { cwd: options.cwd, timeoutMs: 120_000, env: { NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GH_PAGER: "" } });
    if (result.code !== 0) throw new GithubError(describeFailure(result));
    return result.stdout;
  }

  async function json(args: string[]): Promise<unknown> {
    const stdout = await gh(args);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new GithubError(`Expected JSON from gh ${args.slice(0, 2).join(" ")}, got: ${stdout.slice(0, 200)}`);
    }
  }

  async function labelNames(): Promise<Set<string>> {
    const labels = (await json(["label", "list", "--json", "name", "--limit", LIST_LIMIT, ...repoArgs])) as Json[];
    return new Set(labels.map((l) => String(l.name).toLowerCase()));
  }

  return {
    kind: "tickets",
    id: "github",

    async checkAvailability(): Promise<AvailabilityResult> {
      if (!(await which(ctx.exec, binary))) return { ok: false, detail: `${binary} not found on PATH` };
      const version = (await ctx.exec(binary, ["--version"])).stdout.trim().split("\n")[0] ?? binary;
      const auth = await ctx.exec(binary, ["auth", "status", "--active"], { timeoutMs: 30_000, env: { NO_COLOR: "1" } });
      if (auth.code !== 0) return { ok: false, detail: `${version}: not authenticated (run \`gh auth login\`) — ${describeFailure(auth)}` };
      try {
        const repo = (await json(["repo", "view", ...(options.repo ? [options.repo] : []), "--json", "nameWithOwner,hasIssuesEnabled"])) as Json;
        if (repo.hasIssuesEnabled === false) return { ok: false, detail: `${String(repo.nameWithOwner)} has issues disabled` };
        return { ok: true, detail: `${version}, issues of ${String(repo.nameWithOwner)}` };
      } catch (error) {
        const where = options.repo ?? `the repository in ${options.cwd ?? "the current directory"}`;
        return { ok: false, detail: `cannot read ${where} (set tickets.options.repo to OWNER/REPO): ${(error as Error).message}` };
      }
    },

    describeQuery(criteria) {
      const parts = [
        `issues of ${options.repo ?? "the current repository"}`,
        criteria.labels.length > 0 ? `labels [${criteria.labels.join(" AND ")}]` : undefined,
        criteria.excludeLabels.length > 0 ? `excluding [${criteria.excludeLabels.join(", ")}]` : undefined,
        criteria.states.length > 0 ? `states [${criteria.states.join(", ")}]` : "any state",
        criteria.assignee === "any" ? "any assignee" : criteria.assignee === "none" ? "unassigned" : `assignee ${criteria.assignee}`,
        criteria.project ? `milestone ${criteria.project}` : undefined,
      ];
      return parts.filter(Boolean).join(", ");
    },

    async validateCriteria(criteria) {
      const unknown = criteria.states.filter((s) => !OPEN_TYPES.has(s.toLowerCase()) && !CLOSED_TYPES.has(s.toLowerCase()));
      if (unknown.length > 0) {
        return { ok: false, detail: `GitHub issues are only open or closed; tickets.states ${unknown.map((s) => `"${s}"`).join(", ")} never match (use ["open"])` };
      }
      const warnings = criteria.team ? [`tickets.team is ignored by the github provider (set tickets.options.repo instead)`] : [];
      const wanted = [...criteria.labels, ...criteria.excludeLabels];
      if (wanted.length === 0) return { ok: true, detail: "no labels required", warnings };
      const known = await labelNames();
      const missing = wanted.filter((l) => !known.has(l.toLowerCase()));
      if (missing.length > 0) {
        return { ok: false, detail: `label${missing.length > 1 ? "s" : ""} ${missing.map((l) => `"${l}"`).join(", ")} not found — create ${missing.length > 1 ? "them" : "it"} with \`gh label create\` or change tickets.labels`, warnings };
      }
      return { ok: true, detail: `labels ${wanted.join(", ")} exist`, warnings };
    },

    async listCandidates(criteria: TicketCriteria): Promise<Ticket[]> {
      const args = ["issue", "list", "--json", ISSUE_FIELDS, "--limit", LIST_LIMIT, ...repoArgs];
      const wanted = criteria.states.map((s) => s.toLowerCase());
      const state = wanted.length === 0 ? "all" : wanted.every((s) => OPEN_TYPES.has(s)) ? "open" : wanted.every((s) => CLOSED_TYPES.has(s)) ? "closed" : "all";
      args.push("--state", state);
      for (const label of criteria.labels) args.push("--label", label);
      if (criteria.assignee === "none") args.push("--search", "no:assignee");
      else if (criteria.assignee !== "any") args.push("--assignee", criteria.assignee);
      if (criteria.project) args.push("--milestone", criteria.project);

      const data = await json(args);
      if (!Array.isArray(data)) throw new GithubError("gh issue list --json did not return an array");
      return data.map((issue) => toTicket(issue as Json));
    },

    async getTicket(ref) {
      const data = (await json(["issue", "view", issueNumber(ref.identifier), "--json", `${ISSUE_FIELDS},body`, ...repoArgs])) as Json;
      return toTicket(data);
    },

    /** Issues have no workflow states to move between, so the started "state" is a label added to the issue. */
    async moveTicket(ref, label) {
      await gh(["issue", "edit", issueNumber(ref.identifier), "--add-label", label, ...repoArgs]);
    },

    async checkState(label) {
      if (!(await labelNames()).has(label.toLowerCase())) {
        return { ok: false, detail: `label "${label}" (tickets.startedState) not found — create it with \`gh label create "${label}"\` or set tickets.startedState to null` };
      }
      return { ok: true, detail: `labels launched issues "${label}"` };
    },
  };
}

function toTicket(issue: Json): Ticket {
  const open = String(issue.state).toUpperCase() === "OPEN";
  const reason = String(issue.stateReason ?? "").toUpperCase();
  const labels = Array.isArray(issue.labels) ? (issue.labels as Json[]) : [];
  const assignees = Array.isArray(issue.assignees) ? (issue.assignees as Json[]) : [];
  return {
    id: String(issue.id ?? ""),
    identifier: `GH-${String(issue.number)}`,
    title: String(issue.title ?? ""),
    url: String(issue.url ?? ""),
    state: open
      ? { name: "Open", type: "unstarted" }
      : { name: "Closed", type: reason === "NOT_PLANNED" || reason === "DUPLICATE" ? "canceled" : "completed" },
    labels: labels.map((label) => String(label.name)),
    assignee: assignees.length > 0 ? assignees.map((a) => String(a.login)).join(", ") : undefined,
    project: (issue.milestone as Json | null | undefined)?.title as string | undefined,
    createdAt: issue.createdAt as string | undefined,
    updatedAt: issue.updatedAt as string | undefined,
    description: typeof issue.body === "string" ? issue.body : undefined,
  };
}
