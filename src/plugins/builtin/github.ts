import { describeFailure, which } from "../../core/exec.js";
import {
  type Actor,
  actorId,
  type Attribution,
  type AvailabilityResult,
  type ContentEdit,
  type Provenance,
  type ProviderContext,
  type Ticket,
  type TicketCriteria,
  type TicketSource,
} from "../types.js";

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

/**
 * Issues have no workflow states: open issues are "Open" (type unstarted), closed ones "Closed"
 * (type completed or canceled). Only these names and types can ever match.
 */
const OPEN_STATES = new Set(["open", "unstarted"]);
const CLOSED_STATES = new Set(["closed", "completed", "canceled"]);
const ISSUES = "repos/{owner}/{repo}/issues";

/** Issues per provenance query: 50 cost 1 point of the 5,000-point GraphQL budget (measured). */
const PROVENANCE_BATCH = 50;
const ACTOR = "__typename login ... on User { id }";
// userContentEdits lists newest first and the timeline oldest first, so these windows both hold the newest 100.
const PROVENANCE_FRAGMENT = `fragment provenance on Issue {
  createdAt author { ${ACTOR} }
  userContentEdits(first: 100) { totalCount nodes { editedAt editor { ${ACTOR} } } }
  timelineItems(itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT], last: 100) { totalCount nodes { __typename
    ... on LabeledEvent { createdAt actor { ${ACTOR} } label { name } }
    ... on RenamedTitleEvent { createdAt actor { ${ACTOR} } } } }
}`;

/** "GH-12", "#12", or "12" → 12. */
export function issueNumber(ref: string): string {
  const match = /(\d+)$/.exec(ref.trim());
  if (!match) throw new GithubError(`"${ref}" is not a GitHub issue number (expected e.g. GH-12 or 12)`);
  return match[1]!;
}

/** "12", "#12", and "gh-12" → "GH-12", the identifier drovr records; anything else is returned as is. */
export function normalizeGithubRef(ref: string): string {
  const match = /^(?:gh-|#)?(\d+)$/i.exec(ref.trim());
  return match ? `GH-${match[1]}` : ref;
}

export function createGithubProvider(ctx: ProviderContext, options: GithubOptions = {}): TicketSource {
  const binary = options.binary ?? "gh";
  // GH_REPO selects the repository for `gh api`'s {owner}/{repo} placeholders and for `gh issue`.
  const host = options.repo?.split("/").length === 3 ? options.repo.split("/")[0] : undefined;
  const env = { NO_COLOR: "1", GH_PROMPT_DISABLED: "1", GH_PAGER: "", ...(options.repo ? { GH_REPO: options.repo } : {}), ...(host ? { GH_HOST: host } : {}) };
  let login: string | undefined;

  async function gh(args: string[]): Promise<string> {
    const result = await ctx.exec(binary, args, { cwd: options.cwd, timeoutMs: 120_000, env });
    if (result.code !== 0) throw new GithubError(describeFailure(result));
    return result.stdout;
  }

  async function json(args: string[]): Promise<unknown> {
    const stdout = await gh(args);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new GithubError(`Expected JSON from gh ${args.slice(0, 3).join(" ")}, got: ${stdout.slice(0, 200)}`);
    }
  }

  /** A GraphQL query's data. gh exits 1 when part of a query failed (e.g. one deleted issue) but still prints the rest. */
  async function graphql(query: string, fields: string[] = []): Promise<Json> {
    const result = await ctx.exec(binary, ["api", "graphql", "-f", `query=${query}`, ...fields], { cwd: options.cwd, timeoutMs: 120_000, env });
    let body: { data?: Json | null } | undefined;
    try {
      body = JSON.parse(result.stdout) as { data?: Json | null };
    } catch {}
    if (!body?.data) throw new GithubError(describeFailure(result));
    return body.data;
  }

  /** Every item of a REST list endpoint, following pagination to the end. */
  async function list(path: string, query: Record<string, string> = {}): Promise<Json[]> {
    const fields = Object.entries({ ...query, per_page: "100" }).flatMap(([key, value]) => ["-f", `${key}=${value}`]);
    const pages = await json(["api", "--method", "GET", path, ...fields, "--paginate", "--slurp"]);
    if (!Array.isArray(pages)) throw new GithubError(`gh api ${path} did not return a list`);
    return (pages as unknown[]).flat() as Json[];
  }

  async function labelNames(): Promise<Set<string>> {
    const labels = await list("repos/{owner}/{repo}/labels");
    return new Set(labels.map((l) => String(l.name).toLowerCase()));
  }

  /** The REST API filters by milestone number; a title is looked up. */
  async function milestoneNumber(milestone: string): Promise<string> {
    if (/^\d+$/.test(milestone)) return milestone;
    const milestones = await list("repos/{owner}/{repo}/milestones", { state: "all" });
    const match = milestones.find((m) => String(m.title).toLowerCase() === milestone.toLowerCase());
    if (!match) throw new GithubError(`milestone "${milestone}" not found (known: ${milestones.map((m) => m.title).join(", ") || "none"})`);
    return String(match.number);
  }

  /** The REST API takes a login, not @me. */
  async function assigneeLogin(assignee: string): Promise<string> {
    if (assignee !== "@me") return assignee;
    login ??= String(((await json(["api", "user"])) as Json).login);
    return login;
  }

  return {
    kind: "tickets",
    id: "github",

    async checkAvailability(): Promise<AvailabilityResult> {
      if (!(await which(ctx.exec, binary))) return { ok: false, detail: `${binary} not found on PATH` };
      const version = (await ctx.exec(binary, ["--version"])).stdout.trim().split("\n")[0] ?? binary;
      const auth = await ctx.exec(binary, ["auth", "status", "--active", ...(host ? ["--hostname", host] : [])], { timeoutMs: 30_000, env });
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

    normalizeIdentifier: normalizeGithubRef,

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
      const unknown = criteria.states.filter((s) => !OPEN_STATES.has(s.toLowerCase()) && !CLOSED_STATES.has(s.toLowerCase()));
      if (unknown.length > 0) {
        return {
          ok: false,
          detail: `GitHub issues are only open (type unstarted) or closed (completed, canceled); tickets.states ${unknown.map((s) => `"${s}"`).join(", ")} can never match (use ["open"])`,
        };
      }
      const warnings = criteria.team ? [`tickets.team is ignored by the github provider (set tickets.options.repo instead)`] : [];
      const details: string[] = [];
      if (criteria.project) details.push(`milestone #${await milestoneNumber(criteria.project)}`);
      const wanted = [...criteria.labels, ...criteria.excludeLabels];
      if (wanted.length > 0) {
        const known = await labelNames();
        const missing = wanted.filter((l) => !known.has(l.toLowerCase()));
        if (missing.length > 0) {
          return { ok: false, detail: `label${missing.length > 1 ? "s" : ""} ${missing.map((l) => `"${l}"`).join(", ")} not found — create ${missing.length > 1 ? "them" : "it"} with \`gh label create\` or change tickets.labels`, warnings };
        }
        details.push(`labels ${wanted.join(", ")} exist`);
      }
      return { ok: true, detail: details.join(", ") || "no labels required", warnings };
    },

    async listCandidates(criteria: TicketCriteria): Promise<Ticket[]> {
      const wanted = criteria.states.map((s) => s.toLowerCase());
      const query: Record<string, string> = {
        state: wanted.length === 0 ? "all" : wanted.every((s) => OPEN_STATES.has(s)) ? "open" : wanted.every((s) => CLOSED_STATES.has(s)) ? "closed" : "all",
        sort: "created",
        direction: "asc",
      };
      // The issues endpoint requires every listed label.
      if (criteria.labels.length > 0) query.labels = criteria.labels.join(",");
      if (criteria.assignee !== "any") query.assignee = criteria.assignee === "none" ? "none" : await assigneeLogin(criteria.assignee);
      if (criteria.project) query.milestone = await milestoneNumber(criteria.project);
      // The issues endpoint also returns pull requests.
      return (await list(ISSUES, query)).filter((issue) => !issue.pull_request).map(toTicket);
    },

    async getTicket(ref) {
      return toTicket((await json(["api", `${ISSUES}/${issueNumber(ref.identifier)}`])) as Json);
    },

    /** Issues have no workflow states to move between, so the started "state" is a label added to the issue. */
    async moveTicket(ref, label) {
      await gh(["issue", "edit", issueNumber(ref.identifier), "--add-label", label]);
    },

    async checkState(label) {
      if (!(await labelNames()).has(label.toLowerCase())) {
        return { ok: false, detail: `label "${label}" (tickets.startedState) not found — create it with \`gh label create "${label}"\` or set tickets.startedState to null` };
      }
      return { ok: true, detail: `labels launched issues "${label}"` };
    },

    provenance: {
      async resolveActors(refs) {
        const logins = [...new Set(refs.filter((ref) => ref !== "@me"))];
        const declared = logins.map((_, i) => `$u${i}: String!`).join(", ");
        const users = logins.map((_, i) => `u${i}: user(login: $u${i}) { id login }`).join(" ");
        const data = await graphql(`query${declared ? `(${declared})` : ""} { viewer { id login } ${users} }`, logins.flatMap((login, i) => ["-f", `u${i}=${login}`]));
        return refs.map((ref) => {
          const user = (ref === "@me" ? data.viewer : data[`u${logins.indexOf(ref)}`]) as Json | null | undefined;
          if (!user) throw new GithubError(`no GitHub user "${ref}"`);
          return { ref, actor: { id: actorId(String(user.id)), name: String(user.login) } };
        });
      },

      async read(refs) {
        const result = new Map<string, Provenance>();
        for (let start = 0; start < refs.length; start += PROVENANCE_BATCH) {
          const batch = refs.slice(start, start + PROVENANCE_BATCH);
          const issues = batch.map((ref, i) => `i${i}: issue(number: ${issueNumber(ref.identifier)}) { ...provenance }`).join("\n");
          const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${issues}\n} }\n${PROVENANCE_FRAGMENT}`;
          const repository = (await graphql(query, ["-F", "owner={owner}", "-F", "name={repo}"])).repository as Json | null;
          if (!repository) throw new GithubError("the repository was not found");
          batch.forEach((ref, i) => {
            const issue = repository[`i${i}`] as Json | null | undefined;
            if (issue) result.set(ref.id, toProvenance(issue));
          });
        }
        return result;
      },
    },
  };
}

/** Bots and apps cannot be named in tickets.trustedActors, and a deleted user is null, so only users count. */
function toActor(value: unknown): Actor | null {
  const actor = value as Json | null | undefined;
  return actor?.__typename === "User" && typeof actor.id === "string" ? { id: actorId(actor.id), name: String(actor.login) } : null;
}

/** One issue's `...provenance` fragment. */
function toProvenance(issue: Json): Provenance {
  const created: Attribution = { actor: toActor(issue.author), at: Date.parse(String(issue.createdAt)) };
  const labeled = new Map<string, Attribution>();
  const edited: ContentEdit[] = [];
  const truncatedAt: number[] = [];
  const window = (connection: unknown, at: (node: Json) => number): Json[] => {
    const { totalCount, nodes } = (connection ?? {}) as { totalCount?: number; nodes?: Json[] };
    const items = nodes ?? [];
    if ((totalCount ?? 0) > items.length) truncatedAt.push(Math.min(...items.map(at)));
    return items;
  };

  for (const event of window(issue.timelineItems, (e) => Date.parse(String(e.createdAt)))) {
    const by: Attribution = { actor: toActor(event.actor), at: Date.parse(String(event.createdAt)) };
    if (event.__typename === "RenamedTitleEvent") edited.push({ ...by, field: "title" });
    if (event.__typename !== "LabeledEvent") continue;
    const name = String((event.label as Json | null)?.name ?? "").toLowerCase();
    if (by.at >= (labeled.get(name)?.at ?? -Infinity)) labeled.set(name, by);
  }
  // The oldest entry is the original body, dated at creation, by the author.
  for (const edit of window(issue.userContentEdits, (e) => Date.parse(String(e.editedAt)))) {
    edited.push({ actor: toActor(edit.editor), at: Date.parse(String(edit.editedAt)), field: "description" });
  }
  // Each truncated list is complete only from its oldest entry on, so all are complete from the newest of those.
  return { created, labeled, edited, completeSince: truncatedAt.length > 0 ? Math.max(...truncatedAt) : created.at };
}

/** A REST issue (`repos/{owner}/{repo}/issues`) as a ticket. */
function toTicket(issue: Json): Ticket {
  const open = String(issue.state).toLowerCase() === "open";
  const reason = String(issue.state_reason ?? "").toLowerCase();
  const labels = Array.isArray(issue.labels) ? (issue.labels as Json[]) : [];
  const assignees = Array.isArray(issue.assignees) ? (issue.assignees as Json[]) : [];
  return {
    id: String(issue.node_id ?? ""),
    identifier: `GH-${String(issue.number)}`,
    title: String(issue.title ?? ""),
    url: String(issue.html_url ?? ""),
    state: open
      ? { name: "Open", type: "unstarted" }
      : { name: "Closed", type: reason === "not_planned" || reason === "duplicate" ? "canceled" : "completed" },
    labels: labels.map((label) => String(label.name)),
    assignee: assignees.length > 0 ? assignees.map((a) => String(a.login)).join(", ") : undefined,
    project: (issue.milestone as Json | null | undefined)?.title as string | undefined,
    createdAt: issue.created_at as string | undefined,
    updatedAt: issue.updated_at as string | undefined,
    description: typeof issue.body === "string" ? issue.body : undefined,
  };
}
