import { describe, expect, it } from "vitest";
import type { Exec } from "../src/core/exec.js";
import { silentLogger } from "../src/core/log.js";
import { createLinearProvider } from "../src/plugins/builtin/linear.js";

/** Replays output shapes captured from linear CLI 3.0.0. */
function fakeLinear(responses: Record<string, unknown>): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const body = responses[key];
    return { command, args, code: body === undefined ? 1 : 0, stdout: JSON.stringify(body ?? null), stderr: "", timedOut: false };
  };
  return { exec, calls };
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

  it("moves a ticket with issue update --state", async () => {
    const { exec, calls } = fakeLinear({ "issue update": {} });
    await createLinearProvider({ exec, log: silentLogger }).moveTicket!({ id: "uuid-1", identifier: "PQ-1" }, "In Progress");
    expect(calls[0]).toEqual(["issue", "update", "PQ-1", "--state", "In Progress", "--no-input"]);
  });
});
