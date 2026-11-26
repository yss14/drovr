import { describe, expect, it } from "vitest";
import type { Exec } from "../src/core/exec.js";
import { silentLogger } from "../src/core/log.js";
import { createLinearProvider } from "../src/plugins/builtin/linear.js";

type ApiResponse = { code?: number; body: unknown };

/** Replays output shapes captured from linear CLI 3.0.0. `linear api` calls not in `responses` go to `api`. */
function fakeLinear(responses: Record<string, unknown>, api?: (query: string, variables: Record<string, string>) => ApiResponse): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    if (args[0] === "api" && !(key in responses) && api) {
      const variables = Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === "--variable" ? [a.split(/=(.*)/s).slice(0, 2)] : [])));
      const { code = 0, body } = api(args[1]!, variables);
      return { command, args, code, stdout: JSON.stringify(body), stderr: "", timedOut: false };
    }
    const body = responses[key];
    return { command, args, code: body === undefined ? 1 : 0, stdout: JSON.stringify(body ?? null), stderr: "", timedOut: false };
  };
  return { exec, calls };
}

const me = { id: "1e67e2e1-e6e7-4d53-9bd2-e1c8d5c2df1f", name: "Yannick" };
const mallory = { id: "9a0c6f2e-0000-4000-8000-000000000001", name: "Mallory" };
const at = (iso: string) => Date.parse(iso);

/** Shaped like PQ-8795 and PQ-8424 (linear api, 2026-11-26): history newest first, automations with actor null. */
const issue = (overrides: Record<string, unknown> = {}) => ({
  createdAt: "2026-11-20T10:00:00.000Z",
  creator: me,
  labels: { nodes: [{ name: "agent-ready" }, { name: "Bug" }] },
  history: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { createdAt: "2026-11-22T09:00:00.000Z", actor: null, addedLabels: null, updatedDescription: true, fromTitle: null, toTitle: null },
      { createdAt: "2026-11-21T09:00:00.000Z", actor: mallory, addedLabels: null, updatedDescription: null, fromTitle: "Old", toTitle: "New" },
      { createdAt: "2026-11-20T11:00:00.000Z", actor: mallory, addedLabels: [{ name: "Bug" }], updatedDescription: null, fromTitle: null, toTitle: null },
    ],
  },
  ...overrides,
});

/** Answers each `iN: issue(id: $iN)` alias from `issues` by identifier. */
function provenanceApi(issues: Record<string, unknown>) {
  return (query: string, variables: Record<string, string>): ApiResponse => {
    const aliases = [...query.matchAll(/(i\d+): issue\(id: \$i\d+\)/g)].map(([, alias]) => alias!);
    return { body: { data: Object.fromEntries(aliases.map((alias) => [alias, issues[variables[alias]!] ?? null])) } };
  };
}

describe("linear provider", () => {
  it("reads the state type from the API because `issue view` omits it", async () => {
    const { exec, calls } = fakeLinear({
      "issue view": {
        identifier: "PQ-7180",
        title: "Move schedules",
        url: "https://linear.app/x/issue/PQ-7180",
        state: { name: "Todo", color: "#e2e2e2" },
        labels: [{ name: "Bug" }],
        branchName: "feature/pq-7180-move",
        description: "Body",
      },
      "api query($id: String!) { issue(id: $id) { state { name type } } }": { data: { issue: { state: { name: "Todo", type: "unstarted" } } } },
    });
    const ticket = await createLinearProvider({ exec, log: silentLogger }).getTicket({ id: "uuid-1", identifier: "PQ-7180" });
    expect(ticket).toMatchObject({ id: "uuid-1", identifier: "PQ-7180", state: { name: "Todo", type: "unstarted" }, labels: ["Bug"], branchName: "feature/pq-7180-move" });
    expect(calls[1]).toContain("id=PQ-7180");
  });

  it("attributes a label with no history entry to the creator, but only when the whole history was read", async () => {
    const { exec } = fakeLinear({}, provenanceApi({ "PQ-1": issue(), "PQ-2": issue({ history: { ...issue().history, pageInfo: { hasNextPage: true } } }) }));
    const read = await createLinearProvider({ exec, log: silentLogger }).provenance!.read([
      { id: "uuid-1", identifier: "PQ-1" },
      { id: "uuid-2", identifier: "PQ-2" },
    ]);
    const full = read.get("uuid-1")!;
    expect(full.labeled.get("agent-ready")).toEqual({ actor: { id: me.id, name: me.name }, at: at("2026-11-20T10:00:00.000Z") });
    expect(full.labeled.get("bug")).toEqual({ actor: { id: mallory.id, name: mallory.name }, at: at("2026-11-20T11:00:00.000Z") });
    expect(full.completeSince).toBe(at("2026-11-20T10:00:00.000Z"));
    const partial = read.get("uuid-2")!;
    expect(partial.labeled.has("agent-ready")).toBe(false);
    expect(partial.completeSince).toBe(at("2026-11-20T11:00:00.000Z"));
  });

  it("reads edits by automations as edits by nobody, and keeps the latest application of a label", async () => {
    const relabeled = issue({
      history: {
        pageInfo: { hasNextPage: false },
        nodes: [
          { createdAt: "2026-11-23T09:00:00.000Z", actor: me, addedLabels: [{ name: "agent-ready" }], updatedDescription: null, fromTitle: null, toTitle: null },
          ...issue().history.nodes,
          { createdAt: "2026-11-20T10:30:00.000Z", actor: mallory, addedLabels: [{ name: "agent-ready" }], updatedDescription: null, fromTitle: null, toTitle: null },
        ],
      },
    });
    const { exec } = fakeLinear({}, provenanceApi({ "PQ-1": relabeled }));
    const provenance = (await createLinearProvider({ exec, log: silentLogger }).provenance!.read([{ id: "uuid-1", identifier: "PQ-1" }])).get("uuid-1")!;
    expect(provenance.labeled.get("agent-ready")).toEqual({ actor: { id: me.id, name: me.name }, at: at("2026-11-23T09:00:00.000Z") });
    expect(provenance.edited).toEqual(
      expect.arrayContaining([
        { field: "description", actor: null, at: at("2026-11-22T09:00:00.000Z") },
        { field: "title", actor: { id: mallory.id, name: mallory.name }, at: at("2026-11-21T09:00:00.000Z") },
      ]),
    );
  });

  it("reads provenance 20 issues per query by identifier, leaving out missing issues", async () => {
    const issues = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`PQ-${i + 1}`, issue()]));
    delete issues["PQ-30"];
    const { exec, calls } = fakeLinear({}, provenanceApi(issues));
    const refs = Array.from({ length: 45 }, (_, i) => ({ id: `uuid-${i + 1}`, identifier: `PQ-${i + 1}` }));
    const read = await createLinearProvider({ exec, log: silentLogger }).provenance!.read(refs);
    expect(calls).toHaveLength(3);
    expect(read.size).toBe(44);
    expect(read.has("uuid-30")).toBe(false);
  });

  it("resolves @me, emails, and user IDs, and rejects display names and unknown users", async () => {
    const api = (query: string, variables: Record<string, string>): ApiResponse => {
      if (query.includes("viewer")) return { body: { data: { viewer: me } } };
      if (query.includes("users(filter")) return { body: { data: { users: { nodes: variables.email === "mallory@example.com" ? [mallory] : [] } } } };
      if (variables.id === mallory.id) return { body: { data: { user: mallory } } };
      return { code: 3, body: { errors: [{ message: "Entity not found: User" }], data: null } };
    };
    const linear = createLinearProvider({ exec: fakeLinear({}, api).exec, log: silentLogger });
    expect(await linear.provenance!.resolveActors(["@me", "mallory@example.com", mallory.id])).toEqual([
      { ref: "@me", actor: me },
      { ref: "mallory@example.com", actor: mallory },
      { ref: mallory.id, actor: mallory },
    ]);
    await expect(linear.provenance!.resolveActors(["nobody@example.com"])).rejects.toThrow('no Linear user "nobody@example.com"');
    await expect(linear.provenance!.resolveActors(["00000000-0000-4000-8000-000000000000"])).rejects.toThrow(/no Linear user/);
    await expect(linear.provenance!.resolveActors(["Mallory"])).rejects.toThrow(/not a Linear user email or ID/);
  });

  it("moves a ticket with issue update --state", async () => {
    const { exec, calls } = fakeLinear({ "issue update": {} });
    await createLinearProvider({ exec, log: silentLogger }).moveTicket!({ id: "uuid-1", identifier: "PQ-1" }, "In Progress");
    expect(calls[0]).toEqual(["issue", "update", "PQ-1", "--state", "In Progress", "--no-input"]);
  });
});
