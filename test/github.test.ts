import { describe, expect, it } from "vitest";
import { evaluateTicket, isCompleted } from "../src/core/eligibility.js";
import type { Exec } from "../src/core/exec.js";
import { silentLogger } from "../src/core/log.js";
import { createGithubProvider, issueNumber, normalizeGithubRef } from "../src/plugins/builtin/github.js";

type Call = { args: string[]; cwd?: string; env?: Record<string, string | undefined> };

type GraphqlResponse = { code?: number; body: unknown };

/**
 * Replays REST shapes captured from gh 2.97.0; keyed by the endpoint (`gh api`) or the first two arguments.
 * `gh api graphql` calls go to `graphql`, which gets the query and the -f/-F fields.
 */
function fakeGh(responses: Record<string, unknown>, graphql?: (query: string, fields: string[]) => GraphqlResponse): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ args, cwd: options?.cwd, env: options?.env });
    if (args[0] === "api" && args[1] === "graphql" && graphql) {
      const fields = args.slice(2).filter((_, i) => i % 2 === 1);
      const query = fields.find((f) => f.startsWith("query="))!.slice("query=".length);
      const { code = 0, body } = graphql(query, fields);
      return { command, args, code, stdout: JSON.stringify(body), stderr: "", timedOut: false };
    }
    const key = args[0] === "api" ? args.find((a) => a.startsWith("repos/") || a === "user")! : args.slice(0, 2).join(" ");
    const body = responses[key];
    return { command, args, code: body === undefined ? 1 : 0, stdout: JSON.stringify(body ?? null), stderr: "", timedOut: false };
  };
  return { exec, calls };
}

const user = (login: string) => ({ __typename: "User", login, id: `U_${login}` });
const at = (iso: string) => Date.parse(iso);

/** One issue's provenance fragment, shaped like cli/cli#15147 and #3292 (gh api graphql, 2026-11-26). */
const issueProvenance = {
  createdAt: "2026-11-20T10:00:00Z",
  author: user("mallory"),
  userContentEdits: {
    totalCount: 2,
    nodes: [
      { editedAt: "2026-11-21T09:00:00Z", editor: user("mallory") },
      { editedAt: "2026-11-20T10:00:00Z", editor: user("mallory") },
    ],
  },
  timelineItems: {
    totalCount: 4,
    nodes: [
      { __typename: "LabeledEvent", createdAt: "2026-11-20T10:00:05Z", actor: { __typename: "Bot", login: "github-actions" }, label: { name: "needs-triage" } },
      { __typename: "LabeledEvent", createdAt: "2026-11-20T10:00:06Z", actor: user("mallory"), label: { name: "agent-ready" } },
      { __typename: "LabeledEvent", createdAt: "2026-11-20T12:00:00Z", actor: user("yss"), label: { name: "Agent-Ready" } },
      { __typename: "RenamedTitleEvent", createdAt: "2026-11-21T08:00:00Z", actor: null },
    ],
  },
};

/** Answers each `iN: issue(number: N)` alias from `issues`, null (as GitHub does) for a missing one. */
function provenanceResponder(issues: Record<number, unknown>) {
  return (query: string): GraphqlResponse => {
    const aliases = [...query.matchAll(/(i\d+): issue\(number: (\d+)\)/g)];
    const repository = Object.fromEntries(aliases.map(([, alias, n]) => [alias, issues[Number(n)] ?? null]));
    const missing = aliases.some(([, , n]) => issues[Number(n)] === undefined);
    return { code: missing ? 1 : 0, body: { data: { repository } } };
  };
}

const issue = {
  node_id: "I_kwDODKw3uc8AAAABaVv7jA",
  number: 12,
  title: "Support dark mode",
  html_url: "https://github.com/acme/web/issues/12",
  state: "open",
  state_reason: null,
  labels: [{ id: 1, name: "agent-ready", color: "c62946" }],
  assignees: [{ id: 1, login: "octocat" }],
  milestone: { number: 1, title: "v2" },
  created_at: "2026-10-30T13:09:47Z",
  updated_at: "2026-10-30T13:13:05Z",
  body: "Body",
};
const pullRequest = { ...issue, node_id: "PR_1", number: 13, pull_request: { url: "…" } };

const criteria = { labels: ["agent-ready"], excludeLabels: [], states: ["open"], assignee: "any" };
const field = (call: Call, name: string) => call.args[call.args.findIndex((a) => a.startsWith(`${name}=`))]?.slice(name.length + 1);

describe("github provider", () => {
  it("lists every page of open issues, without pull requests, as tickets that match open states", async () => {
    const page2 = { ...issue, node_id: "I_2", number: 14 };
    const { exec, calls } = fakeGh({ "repos/{owner}/{repo}/issues": [[issue, pullRequest], [page2]] });
    const tickets = await createGithubProvider({ exec, log: silentLogger }, { cwd: "/code/web" }).listCandidates(criteria);
    expect(tickets.map((t) => t.identifier)).toEqual(["GH-12", "GH-14"]);
    expect(tickets[0]).toMatchObject({ id: issue.node_id, state: { name: "Open", type: "unstarted" }, labels: ["agent-ready"], assignee: "octocat", project: "v2", description: "Body" });
    expect(evaluateTicket(tickets[0]!, criteria).eligible).toBe(true);
    expect(calls[0]!.cwd).toBe("/code/web");
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--paginate", "--slurp"]));
    expect([field(calls[0]!, "state"), field(calls[0]!, "labels")]).toEqual(["open", "agent-ready"]);
  });

  it("resolves @me and milestone titles for the REST filters, and selects the repository with GH_REPO", async () => {
    const { exec, calls } = fakeGh({
      "repos/{owner}/{repo}/issues": [[]],
      "repos/{owner}/{repo}/milestones": [[{ number: 3, title: "v2" }]],
      user: { login: "octocat" },
    });
    await createGithubProvider({ exec, log: silentLogger }, { repo: "acme/web" }).listCandidates({ ...criteria, assignee: "@me", project: "V2", states: [] });
    const list = calls.find((c) => c.args.includes("repos/{owner}/{repo}/issues"))!;
    expect([field(list, "assignee"), field(list, "milestone"), field(list, "state")]).toEqual(["octocat", "3", "all"]);
    expect(list.env?.GH_REPO).toBe("acme/web");
  });

  it("maps closed issues to completed or canceled", async () => {
    const completion = { stateTypes: ["completed", "canceled"], states: [], whenWorkspaceClosed: true, whenAgentFinished: true };
    for (const state_reason of ["completed", "not_planned"]) {
      const { exec } = fakeGh({ "repos/{owner}/{repo}/issues/12": { ...issue, state: "closed", state_reason } });
      const ticket = await createGithubProvider({ exec, log: silentLogger }).getTicket({ id: issue.node_id, identifier: "GH-12" });
      expect(ticket.state.type).toBe(state_reason === "completed" ? "completed" : "canceled");
      expect(isCompleted(ticket, completion)).toBe(true);
    }
  });

  it("marks a launched issue as started by adding a label", async () => {
    const { exec, calls } = fakeGh({ "issue edit": {} });
    await createGithubProvider({ exec, log: silentLogger }).moveTicket!({ id: issue.node_id, identifier: "GH-12" }, "in-progress");
    expect(calls[0]!.args).toEqual(["issue", "edit", "12", "--add-label", "in-progress"]);
  });

  it("rejects states no issue can be in, and missing labels, at startup", async () => {
    const { exec } = fakeGh({ "repos/{owner}/{repo}/labels": [[{ name: "agent-ready" }]] });
    const github = createGithubProvider({ exec, log: silentLogger });
    for (const state of ["Todo", "triage", "backlog", "started"]) expect((await github.validateCriteria!({ ...criteria, states: [state] })).ok).toBe(false);
    for (const state of ["open", "unstarted", "closed", "canceled"]) expect((await github.validateCriteria!({ ...criteria, states: [state] })).ok).toBe(true);
    expect((await github.checkState!("in-progress")).ok).toBe(false);
  });

  it("reports who labeled and edited an issue, counting bots and deleted users as nobody", async () => {
    const { exec, calls } = fakeGh({}, provenanceResponder({ 12: issueProvenance }));
    const read = await createGithubProvider({ exec, log: silentLogger }, { repo: "acme/web" }).provenance!.read([{ id: "I_12", identifier: "GH-12" }]);
    const provenance = read.get("I_12")!;
    expect(provenance.created).toEqual({ actor: { id: "U_mallory", name: "mallory" }, at: at("2026-11-20T10:00:00Z") });
    expect(provenance.labeled.get("agent-ready")).toEqual({ actor: { id: "U_yss", name: "yss" }, at: at("2026-11-20T12:00:00Z") });
    expect(provenance.labeled.get("needs-triage")!.actor).toBeNull();
    expect(provenance.edited).toEqual(
      expect.arrayContaining([
        { field: "title", actor: null, at: at("2026-11-21T08:00:00Z") },
        { field: "description", actor: { id: "U_mallory", name: "mallory" }, at: at("2026-11-21T09:00:00Z") },
      ]),
    );
    expect(provenance.completeSince).toBe(provenance.created.at);
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["owner={owner}", "name={repo}"]));
    expect(calls[0]!.env?.GH_REPO).toBe("acme/web");
  });

  it("is complete only from the newest of the oldest entries of truncated lists", async () => {
    const edits = Array.from({ length: 100 }, (_, i) => ({ editedAt: new Date(at("2026-11-10T00:00:00Z") - i * 60_000).toISOString(), editor: user("yss") }));
    const events = Array.from({ length: 100 }, (_, i) => ({ __typename: "LabeledEvent", createdAt: new Date(at("2026-11-05T00:00:00Z") + i * 60_000).toISOString(), actor: user("yss"), label: { name: "x" } }));
    const issue = { ...issueProvenance, userContentEdits: { totalCount: 130, nodes: edits }, timelineItems: { totalCount: 180, nodes: events } };
    const { exec } = fakeGh({}, provenanceResponder({ 12: issue }));
    const read = await createGithubProvider({ exec, log: silentLogger }).provenance!.read([{ id: "I_12", identifier: "GH-12" }]);
    expect(read.get("I_12")!.completeSince).toBe(at("2026-11-10T00:00:00Z") - 99 * 60_000);
  });

  it("reads provenance 50 issues per query, leaving out issues that no longer exist", async () => {
    const issues = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [i + 1, issueProvenance]));
    delete issues[77];
    const { exec, calls } = fakeGh({}, provenanceResponder(issues));
    const refs = Array.from({ length: 120 }, (_, i) => ({ id: `I_${i + 1}`, identifier: `GH-${i + 1}` }));
    const read = await createGithubProvider({ exec, log: silentLogger }).provenance!.read(refs);
    expect(calls.filter((c) => c.args[1] === "graphql")).toHaveLength(3);
    expect(read.size).toBe(119);
    expect(read.has("I_77")).toBe(false);
  });

  it("resolves @me and logins to user IDs, and rejects a login that does not exist", async () => {
    const graphql = (query: string, fields: string[]): GraphqlResponse => {
      const logins = fields.filter((f) => /^u\d+=/.test(f)).map((f) => f.split("=")[1]!);
      const users = Object.fromEntries(logins.map((login, i) => [`u${i}`, login === "nobody-xq" ? null : { id: `U_${login}`, login }]));
      expect(query).toContain("viewer { id login }");
      return { code: logins.includes("nobody-xq") ? 1 : 0, body: { data: { viewer: { id: "U_yss", login: "yss" }, ...users } } };
    };
    const github = createGithubProvider({ exec: fakeGh({}, graphql).exec, log: silentLogger });
    expect(await github.provenance!.resolveActors(["@me", "octocat"])).toEqual([
      { ref: "@me", actor: { id: "U_yss", name: "yss" } },
      { ref: "octocat", actor: { id: "U_octocat", name: "octocat" } },
    ]);
    await expect(github.provenance!.resolveActors(["@me", "nobody-xq"])).rejects.toThrow('no GitHub user "nobody-xq"');
  });

  it("accepts GH-12, #12, and 12 as issue references", () => {
    expect(["GH-12", "#12", "12", "gh-12"].map(issueNumber)).toEqual(["12", "12", "12", "12"]);
    expect(["#12", "12", "gh-12", "GH-12"].map(normalizeGithubRef)).toEqual(["GH-12", "GH-12", "GH-12", "GH-12"]);
    expect(normalizeGithubRef("I_kwDOAB")).toBe("I_kwDOAB");
    expect(() => issueNumber("PQ-x")).toThrow();
  });
});
