import { describe, expect, it, vi } from "vitest";
import { Watcher } from "../src/core/watcher.js";
import { harness, ticket } from "./fakes.js";

function watcher(h: ReturnType<typeof harness>) {
  return new Watcher({ config: h.config, store: h.store, providers: h.providers, dispatcher: h.dispatcher, log: h.log });
}

const states = (h: ReturnType<typeof harness>) =>
  Object.fromEntries(h.store.list(h.config.workflow).map((r) => [r.identifier, r.state]));

describe("Watcher", () => {
  it("baselines already-matching tickets on the first run and launches only newcomers", async () => {
    const h = harness({ firstRun: "baseline" });
    h.tickets.tickets.push(ticket(1), ticket(2));
    await watcher(h).start({ once: true });
    expect(states(h)).toEqual({ "PQ-1": "baseline", "PQ-2": "baseline" });
    expect(h.terminal.workspaces).toHaveLength(0);

    h.tickets.tickets.push(ticket(3));
    await watcher(h).start({ once: true });
    expect(states(h)["PQ-3"]).toBe("running");
    expect(h.terminal.workspaces).toHaveLength(1);
  });

  it("launches existing matches on the first run with firstRun=dispatch, respecting the concurrency limit", async () => {
    const h = harness({ firstRun: "dispatch", maxConcurrent: 1 });
    h.tickets.tickets.push(ticket(1, { priority: 3 }), ticket(2, { priority: 1 }));
    await watcher(h).start({ once: true });
    expect(states(h)).toEqual({ "PQ-2": "running" });

    // Slot frees when the ticket reaches a completion state.
    h.tickets.tickets[1]!.state = { name: "Done", type: "completed" };
    await watcher(h).start({ once: true });
    expect(states(h)).toEqual({ "PQ-2": "completed", "PQ-1": "running" });
  });

  it("launches a baselined ticket that stops matching and later matches again", async () => {
    const h = harness({ firstRun: "baseline" });
    const t = ticket(1);
    h.tickets.tickets.push(t);
    await watcher(h).start({ once: true });
    expect(states(h)["PQ-1"]).toBe("baseline");

    t.labels = [];
    await watcher(h).start({ once: true });
    expect(states(h)["PQ-1"]).toBeUndefined();

    t.labels = ["agent-ready"];
    await watcher(h).start({ once: true });
    expect(states(h)["PQ-1"]).toBe("running");
  });

  it("never dispatches the same ticket twice", async () => {
    const h = harness({ firstRun: "dispatch", maxConcurrent: 5 });
    h.tickets.tickets.push(ticket(1));
    await watcher(h).start({ once: true });
    await watcher(h).start({ once: true });
    expect(h.terminal.workspaces).toHaveLength(1);
  });

  it("retries a failed ticket move on the next poll", async () => {
    const h = harness({ firstRun: "dispatch" });
    h.tickets.tickets.push(ticket(1));
    h.tickets.failNextMove = true;
    await watcher(h).start({ once: true });
    expect(h.tickets.moves).toEqual([]);
    await watcher(h).start({ once: true });
    expect(h.tickets.moves).toEqual(["PQ-1→In Progress"]);
    expect(h.terminal.workspaces).toHaveLength(1);
  });

  it("refuses to start while another watcher holds the lease", async () => {
    const h = harness();
    const lease = h.store.acquireLease(h.config.workflow, 60_000);
    expect(lease.ok).toBe(true);
    await expect(watcher(h).start({ once: true })).rejects.toThrow(/Another drovr watcher/);
  });

  it("reconciles a launch interrupted by a crash on startup", async () => {
    const h = harness({ firstRun: "dispatch" });
    const t = ticket(1);
    h.tickets.tickets.push(t);
    h.store.setMeta(h.config.workflow, "baseline_done_at", "x");
    const record = h.store.claim(h.config.workflow, t, "launching")!;
    h.store.update(h.config.workflow, record.issueId, { step: "workspace" });

    await watcher(h).start({ once: true });
    expect(states(h)["PQ-1"]).toBe("running");
  });

  it("picks up retries before new tickets", async () => {
    const h = harness({ firstRun: "dispatch", maxConcurrent: 1 });
    const t1 = ticket(1);
    h.tickets.tickets.push(t1);
    h.store.setMeta(h.config.workflow, "baseline_done_at", "x");
    h.store.claim(h.config.workflow, t1, "retry");
    h.tickets.tickets.push(ticket(2, { priority: 1 }));
    await watcher(h).start({ once: true });
    expect(states(h)).toEqual({ "PQ-1": "running" });
  });

  it("resumes a launch automatically once the user dismisses a startup dialog, and reports agent state", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ firstRun: "dispatch", monitorIntervalSeconds: 5 });
      h.tickets.tickets.push(ticket(1));
      h.terminal.screen = "Trust this folder?";
      const w = watcher(h);
      await w.start();
      expect(states(h)["PQ-1"]).toBe("needs_attention");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(states(h)["PQ-1"]).toBe("needs_attention");

      h.terminal.screen = "";
      await vi.advanceTimersByTimeAsync(5_000);
      expect(states(h)["PQ-1"]).toBe("running");
      expect(h.terminal.prompts).toHaveLength(1);

      h.terminal.agents[0]!.activity = "blocked";
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.log.lines.some((l) => l.includes("PQ-1 is waiting for you"))).toBe(true);

      h.terminal.workspaces = [];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(states(h)["PQ-1"]).toBe("completed");
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees the slot once the agent finishes its first run and launches the next ticket", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ firstRun: "dispatch", maxConcurrent: 1, monitorIntervalSeconds: 5 });
      h.tickets.tickets.push(ticket(1, { priority: 1 }), ticket(2, { priority: 2 }));
      const w = watcher(h);
      await w.start();
      expect(states(h)).toEqual({ "PQ-1": "running" });
      const agent = h.terminal.agents[0]!;

      agent.activity = "working";
      await vi.advanceTimersByTimeAsync(5_000);
      agent.activity = "done";
      await vi.advanceTimersByTimeAsync(5_000); // first idle/done observation: still holds the slot
      expect(states(h)["PQ-1"]).toBe("running");

      agent.activity = "blocked"; // waiting for approval resets the streak
      await vi.advanceTimersByTimeAsync(5_000);
      agent.activity = "idle";
      await vi.advanceTimersByTimeAsync(5_000);
      expect(states(h)["PQ-1"]).toBe("running");

      await vi.advanceTimersByTimeAsync(5_000); // second consecutive idle: finished, next ticket starts
      expect(states(h)).toEqual({ "PQ-1": "finished", "PQ-2": "running" });
      expect(h.terminal.workspaces).toHaveLength(2);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the slot after the agent finishes when whenAgentFinished is off", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ firstRun: "dispatch", maxConcurrent: 1, monitorIntervalSeconds: 5, completion: { whenAgentFinished: false } });
      h.tickets.tickets.push(ticket(1), ticket(2));
      const w = watcher(h);
      await w.start();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(Object.values(states(h))).toEqual(["running"]);
      await w.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
