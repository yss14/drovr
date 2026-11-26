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

interface LinearOptions {
  /** Linear workspace slug, for `--workspace`. Defaults to the CLI's default credential. */
  workspace?: string;
  binary?: string;
}

type Json = Record<string, unknown>;

export class LinearError extends Error {
  override name = "LinearError";
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

const EXIT_HINTS: Record<number, string> = {
  2: "usage error (check the configured filters)",
  3: "not found (check the team, labels, states, or project names)",
  4: "authentication failed (run `linear auth login`)",
  5: "Linear unavailable or rate limited",
};

/** Issues per provenance query: each costs about 380 of Linear's 10,000 complexity points per query (measured). */
const PROVENANCE_BATCH = 20;
const PROVENANCE_FIELDS =
  "createdAt creator { id name } labels { nodes { name } } " +
  "history(first: 100) { pageInfo { hasNextPage } nodes { createdAt actor { id name } addedLabels { name } updatedDescription fromTitle toTitle } }";
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createLinearProvider(ctx: ProviderContext, options: LinearOptions = {}): TicketSource {
  const binary = options.binary ?? "linear";
  const globalArgs = ["--no-input", ...(options.workspace ? ["--workspace", options.workspace] : [])];

  async function json(args: string[]): Promise<unknown> {
    const result = await ctx.exec(binary, [...args, ...globalArgs], { timeoutMs: 120_000, env: { NO_COLOR: "1" } });
    if (result.code !== 0) {
      const hint = result.code !== null ? EXIT_HINTS[result.code] : undefined;
      throw new LinearError(`${hint ? `${hint}: ` : ""}${describeFailure(result)}`, result.code);
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new LinearError(`Expected JSON from linear ${args.slice(0, 2).join(" ")}, got: ${result.stdout.slice(0, 200)}`, result.code);
    }
  }

  async function resolveActor(ref: string): Promise<Actor> {
    let user: Json | null | undefined;
    if (ref === "@me") {
      user = ((await json(["api", "query { viewer { id name } }"])) as { data?: { viewer?: Json } }).data?.viewer;
    } else if (EMAIL.test(ref)) {
      const query = "query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id name } } }";
      user = ((await json(["api", query, "--variable", `email=${ref}`])) as { data?: { users?: { nodes?: Json[] } } }).data?.users?.nodes?.[0];
    } else if (UUID.test(ref)) {
      const query = "query($id: String!) { user(id: $id) { id name } }";
      user = await json(["api", query, "--variable", `id=${ref}`]).then(
        (response) => (response as { data?: { user?: Json } }).data?.user,
        (error: unknown) => {
          if (error instanceof LinearError && error.exitCode === 3) return undefined;
          throw error;
        },
      );
    } else {
      throw new LinearError(`"${ref}" is not a Linear user email or ID (display names can change, so drovr does not trust them)`, null);
    }
    if (!user) throw new LinearError(`no Linear user "${ref}"`, null);
    return { id: actorId(String(user.id)), name: String(user.name) };
  }

  return {
    kind: "tickets",
    id: "linear",

    provenance: {
      async resolveActors(refs) {
        const resolved = [];
        for (const ref of refs) resolved.push({ ref, actor: await resolveActor(ref) });
        return resolved;
      },

      async read(refs) {
        const result = new Map<string, Provenance>();
        for (let start = 0; start < refs.length; start += PROVENANCE_BATCH) {
          const batch = refs.slice(start, start + PROVENANCE_BATCH);
          const declared = batch.map((_, i) => `$i${i}: String!`).join(", ");
          const query = `query(${declared}) { ${batch.map((_, i) => `i${i}: issue(id: $i${i}) { ${PROVENANCE_FIELDS} }`).join(" ")} }`;
          const variables = batch.flatMap((ref, i) => ["--variable", `i${i}=${ref.identifier}`]);
          const data = ((await json(["api", query, ...variables])) as { data?: Json | null }).data ?? {};
          batch.forEach((ref, i) => {
            const issue = data[`i${i}`] as Json | null | undefined;
            if (issue) result.set(ref.id, toProvenance(issue));
          });
        }
        return result;
      },
    },

    async checkAvailability(): Promise<AvailabilityResult> {
      if (!(await which(ctx.exec, binary))) return { ok: false, detail: `${binary} not found on PATH` };
      const version = (await ctx.exec(binary, ["--version"])).stdout.trim();
      const whoami = await ctx.exec(binary, ["auth", "whoami", ...globalArgs], { timeoutMs: 30_000, env: { NO_COLOR: "1" } });
      if (whoami.code !== 0) return { ok: false, detail: `${version}: not authenticated — ${describeFailure(whoami)}` };
      const who = whoami.stdout.trim().split("\n")[0] ?? "";
      return { ok: true, detail: `${version}, ${who}` };
    },

    describeQuery(criteria) {
      const parts = [
        criteria.team ? `team ${criteria.team}` : "default team",
        criteria.labels.length > 0 ? `labels [${criteria.labels.join(" AND ")}]` : undefined,
        criteria.excludeLabels.length > 0 ? `excluding [${criteria.excludeLabels.join(", ")}]` : undefined,
        criteria.states.length > 0 ? `states [${criteria.states.join(", ")}]` : "any state",
        criteria.assignee === "any" ? "any assignee" : criteria.assignee === "none" ? "unassigned" : `assignee ${criteria.assignee}`,
        criteria.project ? `project ${criteria.project}` : undefined,
      ];
      return parts.filter(Boolean).join(", ");
    },

    async validateCriteria(criteria) {
      const teams = (await json(["team", "list", "--json"])) as Json[];
      const team = criteria.team?.toLowerCase();
      const found = team && teams.find((t) => [t.key, t.name, t.id].some((v) => String(v).toLowerCase() === team));
      if (team && !found) {
        return { ok: false, detail: `team "${criteria.team}" not found (known: ${teams.map((t) => t.key).join(", ")})` };
      }
      const wanted = [...criteria.labels, ...criteria.excludeLabels];
      if (wanted.length === 0) return { ok: true, detail: found ? `team ${String(found.key)}` : "default team" };
      const labelArgs = criteria.team ? ["--team", criteria.team] : ["--all-teams"];
      const labels = (await json(["label", "list", "--json", ...labelArgs])) as Json[];
      const known = new Set(labels.map((l) => String(l.name).toLowerCase()));
      const missing = wanted.filter((l) => !known.has(l.toLowerCase()));
      if (missing.length > 0) {
        return { ok: false, detail: `label${missing.length > 1 ? "s" : ""} ${missing.map((l) => `"${l}"`).join(", ")} not found${criteria.team ? ` for team ${criteria.team}` : ""} — create ${missing.length > 1 ? "them" : "it"} in Linear or change tickets.labels` };
      }
      return { ok: true, detail: `team ${found ? String(found.key) : "(default)"}, labels ${wanted.join(", ")} exist` };
    },

    async listCandidates(criteria: TicketCriteria): Promise<Ticket[]> {
      // `--limit all` makes the CLI follow pagination to the end.
      const args = ["issue", "list", "--json", "--limit", "all", "--no-pager", "--sort", "priority"];
      if (criteria.team) args.push("--team", criteria.team);
      if (criteria.states.length === 0) args.push("--all-states");
      for (const state of criteria.states) args.push("--state", state);
      for (const label of criteria.labels) args.push("--label", label);
      if (criteria.assignee === "any") args.push("--all-assignees");
      else if (criteria.assignee === "none") args.push("--unassigned");
      else args.push("--assignee", criteria.assignee);
      if (criteria.project) args.push("--project", criteria.project);

      const data = await json(args);
      if (!Array.isArray(data)) throw new LinearError("linear issue list --json did not return an array", 0);
      return data.map((issue) => toTicket(issue as Json));
    },

    async moveTicket(ref, state) {
      const result = await ctx.exec(binary, ["issue", "update", ref.identifier, "--state", state, ...globalArgs], { timeoutMs: 60_000, env: { NO_COLOR: "1" } });
      if (result.code !== 0) {
        const hint = result.code !== null ? EXIT_HINTS[result.code] : undefined;
        throw new LinearError(`${hint ? `${hint}: ` : ""}${describeFailure(result)}`, result.code);
      }
    },

    async checkState(state, team) {
      if (!team) return { ok: true, detail: `state "${state}" (not verified without a team)` };
      const states = (await json(["team", "states", team, "--json"])) as Json[];
      const wanted = state.toLowerCase();
      const match = states.find((s) => String(s.name).toLowerCase() === wanted || String(s.type).toLowerCase() === wanted);
      if (!match) return { ok: false, detail: `state "${state}" not found for team ${team} (known: ${states.map((s) => s.name).join(", ")})` };
      return { ok: true, detail: `moves launched tickets to "${String(match.name)}"` };
    },

    async getTicket(ref) {
      const data = (await json(["issue", "view", ref.identifier, "--json", "--no-comments", "--no-download", "--no-pager"])) as Json;
      // `issue view` omits the UUID (keep the caller's stable ID) and the state type (ask the API).
      const ticket = { ...toTicket(data), id: ref.id };
      const stateQuery = "query($id: String!) { issue(id: $id) { state { name type } } }";
      const response = (await json(["api", stateQuery, "--variable", `id=${ref.identifier}`])) as { data?: { issue?: { state?: { name?: string; type?: string } } } };
      const state = response.data?.issue?.state;
      if (!state?.type) throw new LinearError(`Could not read the workflow state of ${ref.identifier}`, 0);
      return { ...ticket, state: { name: String(state.name ?? ticket.state.name), type: state.type } };
    },
  };
}

/** A null actor is an automation, integration, or API key (Linear names those in botActor). */
function toActor(value: unknown): Actor | null {
  const actor = value as Json | null | undefined;
  return actor && typeof actor.id === "string" ? { id: actorId(actor.id), name: String(actor.name) } : null;
}

function toProvenance(issue: Json): Provenance {
  const created: Attribution = { actor: toActor(issue.creator), at: Date.parse(String(issue.createdAt)) };
  const history = (issue.history ?? {}) as { pageInfo?: { hasNextPage?: boolean }; nodes?: Json[] };
  const entries = history.nodes ?? [];
  const complete = !history.pageInfo?.hasNextPage;
  const labeled = new Map<string, Attribution>();
  const edited: ContentEdit[] = [];
  for (const entry of entries) {
    const by: Attribution = { actor: toActor(entry.actor), at: Date.parse(String(entry.createdAt)) };
    for (const label of (entry.addedLabels as Json[] | null) ?? []) {
      const name = String(label.name).toLowerCase();
      if (by.at >= (labeled.get(name)?.at ?? -Infinity)) labeled.set(name, by);
    }
    if (entry.updatedDescription) edited.push({ ...by, field: "description" });
    if (entry.fromTitle != null || entry.toTitle != null) edited.push({ ...by, field: "title" });
  }
  // Linear records no history entry for labels set at creation; only full history proves a label had no later add.
  if (complete) {
    const labels = ((issue.labels as Json | undefined)?.nodes as Json[] | undefined) ?? [];
    for (const label of labels) {
      const name = String(label.name).toLowerCase();
      if (!labeled.has(name)) labeled.set(name, created);
    }
  }
  const oldest = Math.min(...entries.map((e) => Date.parse(String(e.createdAt))));
  return { created, labeled, edited, completeSince: complete ? created.at : oldest };
}

function toTicket(issue: Json): Ticket {
  const state = (issue.state ?? {}) as Json;
  const labels = Array.isArray(issue.labels) ? (issue.labels as Json[]) : ((issue.labels as Json | undefined)?.nodes as Json[] | undefined) ?? [];
  const assignee = issue.assignee as Json | null | undefined;
  return {
    id: String(issue.id ?? ""),
    identifier: String(issue.identifier),
    title: String(issue.title ?? ""),
    url: String(issue.url ?? ""),
    state: { name: String(state.name ?? "unknown"), type: String(state.type ?? "unknown") },
    labels: labels.map((label) => String(label.name)),
    team: (issue.team as Json | undefined)?.key as string | undefined,
    assignee: assignee ? String(assignee.displayName ?? assignee.name) : undefined,
    project: (issue.project as Json | null | undefined)?.name as string | undefined,
    priority: typeof issue.priority === "number" ? issue.priority : undefined,
    createdAt: issue.createdAt as string | undefined,
    updatedAt: issue.updatedAt as string | undefined,
    branchName: typeof issue.branchName === "string" && issue.branchName ? issue.branchName : undefined,
    description: typeof issue.description === "string" ? issue.description : undefined,
  };
}
