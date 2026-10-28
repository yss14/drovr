import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UserActionRequired } from "../src/plugins/types.js";
import { harness, ticket } from "./fakes.js";

function claim(h: ReturnType<typeof harness>, n: number) {
  const t = ticket(n);
  h.tickets.tickets.push(t);
  return h.store.claim(h.config.workflow, t, "launching")!;
}

describe("Dispatcher.launch", () => {
  it("creates worktree, workspace, agent, and submits the prompt", async () => {
    const h = harness();
    const result = await h.dispatcher.launch(claim(h, 1));

    expect(result.state).toBe("running");
    expect(result.worktreePath).toBe("/repo/.worktrees/feature-pq-1-ticket");
    expect(result.branch).toBe("feature/pq-1-ticket");
    expect(result.baseBranch).toBe("main");
    expect(result.workspaceId).toBe("w1");
    expect(result.agentName).toBe("pq-1-ticket-1");
    expect(h.terminal.workspaces[0]!.label).toBe("PQ-1 Ticket 1");
    expect(h.terminal.prompts).toHaveLength(1);
    expect(h.terminal.prompts[0]!.text).toContain("[drovr:PQ-1]");
    expect(h.terminal.prompts[0]!.text).toContain("Do thing 1");
  });

  it("sets the configured agent env in the workspace, keeping drovr's own variables", async () => {
    const h = harness({ agent: { env: { CLAUDE_CONFIG_DIR: "/home/me/.claude-team", DROVR_TICKET: "nope" } } });
    await h.dispatcher.launch(claim(h, 1));
    expect(h.terminal.workspaces[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: "/home/me/.claude-team", DROVR_TICKET: "PQ-1", DROVR_WORKFLOW: h.config.workflow });
  });

  it("moves the ticket to In Progress once the agent has acknowledged it", async () => {
    const h = harness();
    const result = await h.dispatcher.launch(claim(h, 1));
    expect(h.tickets.moves).toEqual(["PQ-1→In Progress"]);
    expect(result.ticketMovedAt).not.toBeNull();
  });

  it("does not move the ticket while the prompt is unconfirmed, or when disabled", async () => {
    const h = harness();
    h.terminal.swallowNextPrompt = true;
    await h.dispatcher.launch(claim(h, 1));
    expect(h.tickets.moves).toEqual([]);

    const off = harness({ tickets: { startedState: null } });
    await off.dispatcher.launch(claim(off, 1));
    expect(off.tickets.moves).toEqual([]);
  });

  it("never moves a ticket that is already further along", async () => {
    const h = harness();
    const record = claim(h, 1);
    h.tickets.tickets[0]!.state = { name: "Review", type: "started" };
    const result = await h.dispatcher.launch(record);
    expect(result.state).toBe("running");
    expect(h.tickets.moves).toEqual([]);
    expect(result.ticketMovedAt).not.toBeNull();
  });

  it("keeps the launch running when the move fails, and moves it later", async () => {
    const h = harness();
    h.tickets.failNextMove = true;
    const result = await h.dispatcher.launch(claim(h, 1));
    expect(result.state).toBe("running");
    expect(result.ticketMovedAt).toBeNull();
    expect(h.log.lines.some((l) => l.includes("will retry on the next poll"))).toBe(true);

    const retried = await h.dispatcher.moveTicket(result);
    expect(retried.ticketMovedAt).not.toBeNull();
    expect(h.tickets.moves).toEqual(["PQ-1→In Progress"]);
  });

  it("writes the brief into the worktree and sends a one-line message with file delivery", async () => {
    const repo = mkdtempSync(join(tmpdir(), "drovr-repo-"));
    const h = harness({ repositories: [{ path: repo, fetch: false }], prompt: { delivery: "file" } });
    const result = await h.dispatcher.launch(claim(h, 1));
    expect(result.state).toBe("running");
    const message = h.terminal.prompts[0]!.text;
    expect(message).not.toContain("\n");
    expect(message).toContain("[drovr:PQ-1]");
    expect(message).toContain(".drovr/PQ-1.md");
    expect(readFileSync(join(result.worktreePath!, ".drovr/PQ-1.md"), "utf8")).toContain("Do thing 1");
    expect(h.vcs.excluded).toEqual(["/.drovr"]);
  });

  it("runs worktree hooks before starting the agent and re-runs them after a failed hook", async () => {
    const h = harness();
    h.vcs.hooks = true;
    h.vcs.failHooksOnCreate = true;
    const failed = await h.dispatcher.launch(claim(h, 1));
    expect(failed.state).toBe("failed");
    expect(failed.step).toBe("worktree");
    expect(h.terminal.workspaces).toHaveLength(0);

    const retried = await h.dispatcher.launch(failed);
    expect(retried.state).toBe("running");
    expect(h.vcs.hookRuns).toEqual(["rerun:/repo/.worktrees/feature-pq-1-ticket"]);
  });

  it("does not re-run hooks that already ran while creating the worktree", async () => {
    const h = harness();
    h.vcs.hooks = true;
    await h.dispatcher.launch(claim(h, 1));
    expect(h.vcs.hookRuns).toEqual(["create:/repo/.worktrees/feature-pq-1-ticket"]);
  });

  it("asks the user to approve hooks instead of approving them", async () => {
    const h = harness();
    h.vcs.addWorktree = async () => {
      throw new UserActionRequired("worktrunk hooks in /repo need your approval");
    };
    const result = await h.dispatcher.launch(claim(h, 1));
    expect(result.state).toBe("needs_attention");
    expect(result.reason).toMatch(/need your approval, then run `drovr retry PQ-1`/);
  });

  it("adopts a workspace whose create response was lost instead of creating a second one", async () => {
    const h = harness();
    h.terminal.loseNextCreateResponse = true;
    const first = await h.dispatcher.launch(claim(h, 1));
    expect(first.state).toBe("failed");
    expect(first.step).toBe("workspace");

    const second = await h.dispatcher.launch(first);
    expect(second.state).toBe("running");
    expect(h.terminal.workspaces).toHaveLength(1);
    expect(h.terminal.calls.filter((c) => c === "createWorkspace")).toHaveLength(1);
  });

  it("flags a not-ready agent for the user and resumes without restarting it", async () => {
    const h = harness();
    h.terminal.startNotReady = true;
    const stuck = await h.dispatcher.launch(claim(h, 1));
    expect(stuck.state).toBe("needs_attention");
    expect(stuck.autoResume).toBe(true);
    expect(stuck.reason).toMatch(/trust, login, or update prompt/);

    // Still not ready: stays put.
    expect((await h.dispatcher.launch(stuck)).state).toBe("needs_attention");

    h.terminal.makeReady(stuck.paneId!);
    const resumed = await h.dispatcher.launch(h.store.get(h.config.workflow, stuck.issueId)!);
    expect(resumed.state).toBe("running");
    expect(h.terminal.calls.filter((c) => c === "startAgent")).toHaveLength(1);
    expect(h.terminal.agents[0]!.name).toBe("pq-1-ticket-1");
    expect(h.terminal.prompts).toHaveLength(1);
  });

  it("does not resend a prompt whose delivery is visible in the terminal", async () => {
    const h = harness();
    h.terminal.losePromptResponse = true;
    const lost = await h.dispatcher.launch(claim(h, 1));
    expect(lost.state).toBe("failed");
    expect(lost.promptIntentAt).not.toBeNull();

    const resumed = await h.dispatcher.launch(lost);
    expect(resumed.state).toBe("running");
    expect(h.terminal.prompts).toHaveLength(1);
  });

  it("asks the user when prompt delivery cannot be confirmed", async () => {
    const h = harness();
    h.terminal.losePromptResponse = true;
    const lost = await h.dispatcher.launch(claim(h, 1));
    h.terminal.output = ""; // e.g. the agent collapsed the pasted prompt
    const result = await h.dispatcher.launch(lost);
    expect(result.state).toBe("needs_attention");
    expect(result.reason).toMatch(/--resend-prompt/);
    expect(h.terminal.prompts).toHaveLength(1);
  });

  it("leaves a startup dialog that Herdr reports as ready to the user, then continues", async () => {
    const h = harness();
    h.terminal.screen = "Folder access\nTrust this folder? Codex can read, edit\n› 1. Trust and continue";
    const stuck = await h.dispatcher.launch(claim(h, 1));
    expect(stuck.state).toBe("needs_attention");
    expect(stuck.autoResume).toBe(true);
    expect(stuck.reason).toMatch(/folder trust prompt/);
    expect(h.terminal.prompts).toHaveLength(0);
    expect(await h.dispatcher.agentBlocker(stuck)).toBe("folder trust prompt");

    h.terminal.screen = "› Ask Codex to do anything";
    expect(await h.dispatcher.agentBlocker(stuck)).toBeUndefined();
    const resumed = await h.dispatcher.launch(stuck);
    expect(resumed.state).toBe("running");
    expect(h.terminal.calls.filter((c) => c === "startAgent")).toHaveLength(1);
    expect(h.terminal.prompts).toHaveLength(1);
  });

  it("flags a prompt the agent did not react to instead of marking it running", async () => {
    const h = harness();
    h.terminal.swallowNextPrompt = true;
    const result = await h.dispatcher.launch(claim(h, 1));
    expect(result.state).toBe("needs_attention");
    expect(result.autoResume).toBe(false);
    expect(result.reason).toMatch(/did not react/);
    expect(result.promptedAt).toBeNull();
  });

  it("refuses to reuse a branch checked out elsewhere", async () => {
    const h = harness();
    h.vcs.worktrees.push({ path: "/elsewhere", branch: "feature/pq-1-ticket" });
    const result = await h.dispatcher.launch(claim(h, 1));
    expect(result.state).toBe("needs_attention");
    expect(result.reason).toMatch(/already checked out at \/elsewhere/);
  });

  it("refuses an agent name used by another pane", async () => {
    const h = harness();
    h.terminal.agents.push({ name: "pq-1-ticket-1", paneId: "other:p1", workspaceId: "other", agent: "codex", activity: "idle" });
    const result = await h.dispatcher.launch(claim(h, 1));
    expect(result.state).toBe("needs_attention");
    expect(result.reason).toMatch(/already exists in pane other:p1/);
  });

  it("falls back to a generated branch when the tracker suggests none", async () => {
    const h = harness();
    const t = ticket(7, { branchName: undefined, title: "Fix the Ümlaut bug!" });
    h.tickets.tickets.push(t);
    const plan = await h.dispatcher.plan(t);
    expect(plan.branch).toBe("drovr/pq-7-fix-the-umlaut-bug");
    expect(plan.worktreePath).toBe("/repo/.worktrees/drovr-pq-7-fix-the-umlaut-bug");
  });
});
