import { describe, expect, it } from "vitest";
import { evaluateTicket, isCompleted } from "../src/core/eligibility.js";
import type { Exec } from "../src/core/exec.js";
import { silentLogger } from "../src/core/log.js";
import { createGithubProvider, issueNumber } from "../src/plugins/builtin/github.js";

/** Replays output shapes captured from gh 2.97.0. */
function fakeGh(responses: Record<string, unknown>): { exec: Exec; calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = [];
  const exec: Exec = async (command, args, options) => {
    calls.push({ args, cwd: options?.cwd });
    const body = responses[args.slice(0, 2).join(" ")];
    return { command, args, code: body === undefined ? 1 : 0, stdout: JSON.stringify(body ?? null), stderr: "", timedOut: false };
  };
  return { exec, calls };
}

const issue = {
  id: "I_kwDODKw3uc8AAAABbMLNbw",
  number: 12,
  title: "Support dark mode",
  url: "https://github.com/acme/web/issues/12",
  state: "OPEN",
  stateReason: "",
  labels: [{ id: "LA_1", name: "agent-ready", description: "", color: "c62946" }],
  assignees: [{ id: "U_1", login: "octocat", name: "Octo Cat" }],
  milestone: { number: 1, title: "v2", description: "", dueOn: null },
  createdAt: "2026-10-30T13:09:47Z",
  updatedAt: "2026-10-30T13:13:05Z",
};

const criteria = { labels: ["agent-ready"], excludeLabels: [], states: ["open"], assignee: "any" };

describe("github provider", () => {
  it("lists open issues as tickets that match open states", async () => {
    const { exec, calls } = fakeGh({ "issue list": [issue] });
    const [ticket] = await createGithubProvider({ exec, log: silentLogger }, { cwd: "/code/web" }).listCandidates(criteria);
    expect(ticket).toMatchObject({
      id: issue.id,
      identifier: "GH-12",
      state: { name: "Open", type: "unstarted" },
      labels: ["agent-ready"],
      assignee: "octocat",
      project: "v2",
    });
    expect(evaluateTicket(ticket!, criteria).eligible).toBe(true);
    expect(calls[0]!.cwd).toBe("/code/web");
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--state", "open", "--label", "agent-ready"]));
  });

  it("filters unassigned issues with a search and passes --repo when configured", async () => {
    const { exec, calls } = fakeGh({ "issue list": [] });
    await createGithubProvider({ exec, log: silentLogger }, { repo: "acme/web" }).listCandidates({ ...criteria, assignee: "none", states: [] });
    expect(calls[0]!.args).toEqual(expect.arrayContaining(["--repo", "acme/web", "--search", "no:assignee", "--state", "all"]));
  });

  it("maps closed issues to completed or canceled", async () => {
    const completion = { stateTypes: ["completed", "canceled"], states: [], whenWorkspaceClosed: true, whenAgentFinished: true };
    for (const stateReason of ["COMPLETED", "NOT_PLANNED"]) {
      const { exec } = fakeGh({ "issue view": { ...issue, state: "CLOSED", stateReason, body: "Body" } });
      const ticket = await createGithubProvider({ exec, log: silentLogger }).getTicket({ id: issue.id, identifier: "GH-12" });
      expect(ticket.state.type).toBe(stateReason === "COMPLETED" ? "completed" : "canceled");
      expect(ticket.description).toBe("Body");
      expect(isCompleted(ticket, completion)).toBe(true);
    }
  });

  it("marks a launched issue as started by adding a label", async () => {
    const { exec, calls } = fakeGh({ "issue edit": {} });
    await createGithubProvider({ exec, log: silentLogger }).moveTicket!({ id: issue.id, identifier: "GH-12" }, "in-progress");
    expect(calls[0]!.args).toEqual(["issue", "edit", "12", "--add-label", "in-progress"]);
  });

  it("rejects Linear-style states and missing labels at startup", async () => {
    const { exec } = fakeGh({ "label list": [{ name: "agent-ready" }] });
    const github = createGithubProvider({ exec, log: silentLogger });
    expect((await github.validateCriteria!({ ...criteria, states: ["Todo"] })).ok).toBe(false);
    expect((await github.validateCriteria!(criteria)).ok).toBe(true);
    expect((await github.checkState!("in-progress")).ok).toBe(false);
  });

  it("accepts GH-12, #12, and 12 as issue references", () => {
    expect(["GH-12", "#12", "12", "gh-12"].map(issueNumber)).toEqual(["12", "12", "12", "12"]);
    expect(() => issueNumber("PQ-x")).toThrow();
  });
});
