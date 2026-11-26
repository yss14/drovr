import { describe, expect, it } from "vitest";
import { assessTrust, type TrustPolicy } from "../src/core/trust.js";
import { type Actor, actorId, type Attribution, type ContentEdit, type Provenance, type ProvenanceReader } from "../src/plugins/types.js";

const me: Actor = { id: actorId("U_me"), name: "yss" };
const ally: Actor = { id: actorId("U_ally"), name: "octocat" };
const mallory: Actor = { id: actorId("U_mallory"), name: "mallory" };

const reader: ProvenanceReader = { resolveActors: async () => [], read: async () => new Map() };
const policy: TrustPolicy = {
  kind: "actors",
  reader,
  actors: new Map([
    [me.id, { ref: "@me", actor: me }],
    [ally.id, { ref: "octocat", actor: ally }],
  ]),
};

const by = (actor: Actor | null, at: number): Attribution => ({ actor, at });
const edit = (field: ContentEdit["field"], actor: Actor | null, at: number): ContentEdit => ({ field, actor, at });

function provenance(p: { created?: Attribution; labeled?: Record<string, Attribution>; edited?: ContentEdit[]; completeSince?: number } = {}): Provenance {
  const created = p.created ?? by(mallory, 0);
  return { created, labeled: new Map(Object.entries(p.labeled ?? {})), edited: p.edited ?? [], completeSince: p.completeSince ?? created.at };
}

function assess(p: Provenance | undefined, opts: { triggerLabels?: string[]; ticketLabels?: string[]; policy?: TrustPolicy } = {}) {
  const triggerLabels = opts.triggerLabels ?? ["agent-ready"];
  return assessTrust({ triggerLabels, ticketLabels: opts.ticketLabels ?? triggerLabels, provenance: p }, opts.policy ?? policy);
}

describe("assessTrust", () => {
  it("trusts a label you applied, with no later edits", () => {
    expect(assess(provenance({ labeled: { "agent-ready": by(me, 10) } }))).toEqual({ trusted: true, basis: "agent-ready applied by you" });
  });

  it("trusts a label applied by another configured actor", () => {
    expect(assess(provenance({ labeled: { "agent-ready": by(ally, 10) } })).trusted).toBe(true);
  });

  it("refuses a label applied by someone else or by a null actor, naming the label and who applied it", () => {
    const other = assess(provenance({ labeled: { "agent-ready": by(mallory, 10) } }));
    expect(other).toMatchObject({ trusted: false, distrust: { kind: "trigger-untrusted" } });
    expect(!other.trusted && other.reason).toBe("agent-ready was applied by mallory, who is not in tickets.trustedActors — apply it yourself to launch it");
    const ghost = assess(provenance({ labeled: { "agent-ready": by(null, 10) } }));
    expect(!ghost.trusted && ghost.reason).toMatch(/applied by an automation, integration, or deleted user/);
  });

  it("judges a label present at creation by the creator", () => {
    const created = by(me, 5);
    expect(assess(provenance({ created, labeled: { "agent-ready": created } })).trusted).toBe(true);
    const byMallory = by(mallory, 5);
    expect(assess(provenance({ created: byMallory, labeled: { "agent-ready": byMallory } })).trusted).toBe(false);
    const byIntegration = by(null, 5);
    expect(assess(provenance({ created: byIntegration, labeled: { "agent-ready": byIntegration } })).trusted).toBe(false);
  });

  it("refuses an untrusted title or description edit at or after the trigger, and allows one before it", () => {
    const labeled = { "agent-ready": by(me, 10) };
    const after = assess(provenance({ labeled, edited: [edit("description", mallory, 11)] }));
    expect(after).toMatchObject({ trusted: false, distrust: { kind: "edited-after", edit: { field: "description" } } });
    expect(!after.trusted && after.reason).toMatch(/^mallory edited the description at 1970-01-01 00:00 UTC, after agent-ready applied by you — review it, then remove and re-apply agent-ready yourself$/);
    expect(assess(provenance({ labeled, edited: [edit("title", mallory, 10)] }))).toMatchObject({ trusted: false, distrust: { kind: "edited-after", edit: { field: "title" } } });
    expect(assess(provenance({ labeled, edited: [edit("title", null, 12)] })).trusted).toBe(false);
    expect(assess(provenance({ labeled, edited: [edit("description", mallory, 9)] })).trusted).toBe(true);
    expect(assess(provenance({ labeled, edited: [edit("description", ally, 11), edit("title", me, 12)] })).trusted).toBe(true);
  });

  it("refuses when any of several trigger labels was applied by someone untrusted", () => {
    const triggerLabels = ["agent-ready", "backend"];
    const verdict = assess(provenance({ labeled: { "agent-ready": by(me, 10), backend: by(mallory, 20) } }), { triggerLabels });
    expect(verdict).toMatchObject({ trusted: false, distrust: { kind: "trigger-untrusted", trigger: { label: "backend" } } });
  });

  it("judges edits from the latest trigger application", () => {
    const triggerLabels = ["agent-ready", "backend"];
    const labeled = { "agent-ready": by(me, 10), backend: by(ally, 20) };
    expect(assess(provenance({ labeled, edited: [edit("description", mallory, 15)] }), { triggerLabels }).trusted).toBe(true);
    expect(assess(provenance({ labeled, edited: [edit("description", mallory, 25)] }), { triggerLabels }).trusted).toBe(false);
  });

  it("lets the creator decide when tickets.labels is empty", () => {
    expect(assess(provenance({ created: by(me, 0) }), { triggerLabels: [] })).toEqual({ trusted: true, basis: "created by you" });
    const verdict = assess(provenance({ created: by(mallory, 0) }), { triggerLabels: [] });
    expect(!verdict.trusted && verdict.reason).toMatch(/^it was created by mallory, who is not in tickets.trustedActors/);
    expect(assess(provenance({ created: by(me, 0), edited: [edit("title", mallory, 3)] }), { triggerLabels: [] }).trusted).toBe(false);
  });

  it("refuses a trigger older than the history read, and a trigger label it cannot attribute", () => {
    expect(assess(provenance({ labeled: { "agent-ready": by(me, 10) }, completeSince: 50 }))).toMatchObject({ trusted: false, distrust: { kind: "history-incomplete" } });
    expect(assess(provenance({ labeled: { "agent-ready": by(me, 50) }, completeSince: 50 })).trusted).toBe(true);
    expect(assess(provenance())).toMatchObject({ trusted: false, distrust: { kind: "trigger-unattributed", label: "agent-ready" } });
  });

  it("refuses a ticket that no longer carries a trigger label, whoever applied it once", () => {
    const verdict = assess(provenance({ labeled: { "agent-ready": by(me, 10) } }), { ticketLabels: ["in-progress"] });
    expect(verdict).toMatchObject({ trusted: false, distrust: { kind: "label-missing", label: "agent-ready" } });
  });

  it("ignores labels that are not triggers, such as the started-state label drovr adds", () => {
    const p = provenance({ labeled: { "agent-ready": by(me, 10), "in-progress": by(mallory, 30) } });
    expect(assess(p, { ticketLabels: ["agent-ready", "in-progress"] }).trusted).toBe(true);
  });

  it("matches label names case-insensitively", () => {
    expect(assess(provenance({ labeled: { "agent-ready": by(me, 10) } }), { triggerLabels: ["Agent-Ready"], ticketLabels: ["AGENT-READY"] }).trusted).toBe(true);
  });

  it("trusts everything when off, and refuses everything with its detail when unavailable", () => {
    expect(assess(undefined, { policy: { kind: "off" } }).trusted).toBe(true);
    const verdict = assess(provenance({ labeled: { "agent-ready": by(me, 10) } }), { policy: { kind: "unavailable", detail: "no provenance" } });
    expect(verdict).toMatchObject({ trusted: false, reason: "no provenance" });
  });

  it("refuses a ticket whose provenance could not be read", () => {
    expect(assess(undefined)).toMatchObject({ trusted: false, distrust: { kind: "unreadable" } });
  });
});
