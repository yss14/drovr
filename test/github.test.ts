import { describe, expect, it } from "vitest";
import { evaluateTicket, isCompleted } from "../src/core/eligibility.js";
import type { Exec } from "../src/core/exec.js";
import { silentLogger } from "../src/core/log.js";
import { createGithubProvider, issueNumber, normalizeGithubRef } from "../src/plugins/builtin/github.js";

type Call = { args: string[]; cwd?: string; env?: Record<string, string | undefined> };

/** Replays REST shapes captured from gh 2.97.0; keyed by the endpoint (`gh api`) or the first two arguments. */
function fakeGh(responses: Record<string, unknown>): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ args, cwd: options?.cwd, env: options?.env });
    const key = args[0] === "api" ? args.find((a) => a.startsWith("repos/") || a === "user")! : args.slice(0, 2).join(" ");
    const body = responses[key];
    return { command, args, code: body === undefined ? 1 : 0, stdout: JSON.stringify(body ?? null), stderr: "", timedOut: false };
  };
  return { exec, calls };
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

  it("accepts GH-12, #12, and 12 as issue references", () => {
    expect(["GH-12", "#12", "12", "gh-12"].map(issueNumber)).toEqual(["12", "12", "12", "12"]);
    expect(["#12", "12", "gh-12", "GH-12"].map(normalizeGithubRef)).toEqual(["GH-12", "GH-12", "GH-12", "GH-12"]);
    expect(normalizeGithubRef("I_kwDOAB")).toBe("I_kwDOAB");
    expect(() => issueNumber("PQ-x")).toThrow();
  });
});
