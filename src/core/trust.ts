import type { Config } from "../config/schema.js";
import type {
  ActorId,
  Attribution,
  AvailabilityResult,
  ContentEdit,
  Instant,
  Provenance,
  ProvenanceReader,
  ResolvedActor,
  Ticket,
  TicketRef,
  TicketSource,
} from "../plugins/types.js";

/** Whose label applications and edits make a ticket safe to hand to an agent. */
export type TrustPolicy =
  | { kind: "off" }
  | { kind: "actors"; reader: ProvenanceReader; actors: ReadonlyMap<ActorId, ResolvedActor> }
  | { kind: "unavailable"; detail: string };

/** The act that made a ticket eligible. A null label means creation itself (tickets.labels is empty). */
export interface Trigger {
  label: string | null;
  by: Attribution;
}

export type Distrust =
  | { kind: "unavailable"; detail: string }
  | { kind: "unreadable"; detail?: string }
  | { kind: "label-missing"; label: string }
  | { kind: "trigger-unattributed"; label: string }
  | { kind: "trigger-untrusted"; trigger: Trigger }
  | { kind: "history-incomplete"; completeSince: Instant; trigger: Trigger }
  | { kind: "edited-after"; edit: ContentEdit; trigger: Trigger };

export type TrustVerdict = { trusted: true; basis: string } | { trusted: false; distrust: Distrust; reason: string };
export type Refusal = Extract<TrustVerdict, { trusted: false }>;

declare const admitted: unique symbol;
/**
 * A frozen snapshot of a ticket whose content was read before the provenance that cleared it, so the
 * text rendered is the text judged. Only `TrustGate.admit` creates one.
 */
export type AdmittedTicket = Readonly<Ticket> & { readonly [admitted]: true };

export type Admission =
  | { ok: true; ticket: AdmittedTicket; verdict: Extract<TrustVerdict, { trusted: true }> }
  | { ok: false; ticket: Ticket; verdict: Refusal };

export interface TrustInput {
  /** tickets.labels */
  triggerLabels: readonly string[];
  /** The labels on the ticket as read. */
  ticketLabels: readonly string[];
  provenance: Provenance | undefined;
}

/** The whole trust rule. */
export function assessTrust(input: TrustInput, policy: TrustPolicy): TrustVerdict {
  if (policy.kind === "off") return { trusted: true, basis: "trust check off" };
  const refuse = (distrust: Distrust): Refusal => ({ trusted: false, distrust, reason: explain(distrust, policy) });
  if (policy.kind === "unavailable") return refuse({ kind: "unavailable", detail: policy.detail });
  const { provenance } = input;
  if (!provenance) return refuse({ kind: "unreadable" });

  const onTicket = new Set(input.ticketLabels.map((l) => l.toLowerCase()));
  const triggers: Trigger[] = [];
  for (const label of input.triggerLabels) {
    if (!onTicket.has(label.toLowerCase())) return refuse({ kind: "label-missing", label });
    const by = provenance.labeled.get(label.toLowerCase());
    if (!by) return refuse({ kind: "trigger-unattributed", label });
    triggers.push({ label, by });
  }
  if (triggers.length === 0) triggers.push({ label: null, by: provenance.created });

  const trusted = (attribution: Attribution) => attribution.actor !== null && policy.actors.has(attribution.actor.id);
  const untrusted = triggers.find((t) => !trusted(t.by));
  if (untrusted) return refuse({ kind: "trigger-untrusted", trigger: untrusted });

  // The latest trigger is when the operator approved the content as it stood, so re-applying the label
  // always clears earlier edits. An edit in the same instant counts as after it.
  const trigger = triggers.reduce((latest, t) => (t.by.at > latest.by.at ? t : latest));
  if (trigger.by.at < provenance.completeSince) return refuse({ kind: "history-incomplete", completeSince: provenance.completeSince, trigger });
  const edit = [...provenance.edited].sort((a, b) => a.at - b.at).find((e) => e.at >= trigger.by.at && !trusted(e));
  if (edit) return refuse({ kind: "edited-after", edit, trigger });

  return { trusted: true, basis: triggers.map((t) => describeTrigger(t, policy)).join(", ") };
}

/** One sentence per distrust: what happened, and what the operator can do about it. */
export function explain(distrust: Distrust, policy: TrustPolicy): string {
  switch (distrust.kind) {
    case "unavailable":
      return distrust.detail;
    case "unreadable":
      return `drovr could not read who labeled or edited it${distrust.detail ? ` (${distrust.detail})` : ""}`;
    case "label-missing":
      return `it no longer has the ${distrust.label} label — apply it yourself to launch it`;
    case "trigger-unattributed":
      return `drovr cannot tell who applied ${distrust.label} (its history is longer than drovr reads) — remove and re-apply ${distrust.label} yourself`;
    case "trigger-untrusted": {
      const { label, by } = distrust.trigger;
      const who = by.actor ? `${actorName(by, policy)}, who is not in tickets.trustedActors` : actorName(by, policy);
      if (label === null) return `it was created by ${who} — with no tickets.labels, only tickets created by a trusted actor launch`;
      return `${label} was applied by ${who} — apply it yourself to launch it`;
    }
    case "history-incomplete":
      return `its history is longer than drovr reads, so edits after ${triggerText(distrust.trigger)} cannot be ruled out — ${remedy(distrust.trigger)}`;
    case "edited-after": {
      const { edit, trigger } = distrust;
      return `${actorName(edit, policy)} ${edit.field === "title" ? "renamed it" : "edited the description"} at ${formatInstant(edit.at)}, after ${describeTrigger(trigger, policy)} — review it, then ${remedy(trigger)}`;
    }
  }
}

function actorName(attribution: Attribution, policy: TrustPolicy): string {
  if (!attribution.actor) return "an automation, integration, or deleted user";
  const resolved = policy.kind === "actors" ? policy.actors.get(attribution.actor.id) : undefined;
  return resolved?.ref === "@me" ? "you" : attribution.actor.name;
}

function triggerText(trigger: Trigger): string {
  return trigger.label === null ? "it was created" : `${trigger.label} was applied`;
}

function describeTrigger(trigger: Trigger, policy: TrustPolicy): string {
  return trigger.label === null ? `created by ${actorName(trigger.by, policy)}` : `${trigger.label} applied by ${actorName(trigger.by, policy)}`;
}

function remedy(trigger: Trigger): string {
  return trigger.label === null ? "recreate it yourself" : `remove and re-apply ${trigger.label} yourself`;
}

function formatInstant(at: Instant): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface Screen {
  /** Refused tickets; `fresh` when the verdict comes from provenance read in this call, not the cache. */
  refused: { ticket: Ticket; verdict: Refusal; fresh: boolean }[];
  refusedIds: ReadonlySet<string>;
  /** Why provenance could not be read; the tickets it covered are refused for now. */
  readError?: string;
}

const CACHE_TTL_MS = 15 * 60_000;

/**
 * Owns the trust policy, the provenance cache, and the order of reads: content first, provenance
 * second. Built once per config (re)load.
 */
export class TrustGate {
  private readonly cache = new Map<string, { updatedAt: string; readAt: number; provenance: Provenance }>();

  constructor(
    readonly policy: TrustPolicy,
    private readonly source: TicketSource,
    private readonly triggerLabels: readonly string[],
    private readonly now: () => number = Date.now,
  ) {}

  /** Resolves tickets.trustedActors through the ticket source. Never throws: a failure makes the policy unavailable. */
  static async create(config: Config, source: TicketSource): Promise<TrustGate> {
    const gate = (policy: TrustPolicy) => new TrustGate(policy, source, config.tickets.labels);
    const refs = config.tickets.trustedActors;
    if (refs === "any") return gate({ kind: "off" });
    if (!source.provenance) {
      return gate({
        kind: "unavailable",
        detail: `the ${source.id} ticket source cannot report who labeled or edited tickets, so drovr would launch nothing. Set tickets.trustedActors to "any" to trust every matching ticket`,
      });
    }
    try {
      const resolved = await source.provenance.resolveActors(refs);
      return gate({ kind: "actors", reader: source.provenance, actors: new Map(resolved.map((r) => [r.actor.id, r])) });
    } catch (error) {
      return gate({ kind: "unavailable", detail: `tickets.trustedActors: ${(error as Error).message}` });
    }
  }

  /** The `drovr check` line. */
  availability(): AvailabilityResult {
    const { policy, triggerLabels } = this;
    const labels = triggerLabels.join(" and ");
    switch (policy.kind) {
      case "off":
        return {
          ok: true,
          detail: 'off — tickets.trustedActors is "any"',
          warnings: [`anyone who can ${labels ? `put ${labels} on a ticket` : "create a matching ticket"} can start an agent on this machine`],
        };
      case "unavailable":
        return { ok: false, detail: policy.detail };
      case "actors": {
        const names = [...policy.actors.values()].map((r) => (r.ref === "@me" ? `${r.actor.name} (@me)` : r.ref));
        const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
        const what = labels ? `whose ${labels} label${triggerLabels.length > 1 ? "s were" : " was"} applied by ${who}` : `created by ${who}`;
        return { ok: true, detail: `launches tickets ${what}, with no title or description edits by anyone else since` };
      }
    }
  }

  /**
   * Judges listed tickets before they are claimed. Advisory: `admit` decides at launch. Provenance is
   * cached per ticket until its updatedAt changes or the cache entry expires.
   */
  async screen(tickets: readonly Ticket[]): Promise<Screen> {
    const { policy } = this;
    const refused: Screen["refused"] = [];
    if (policy.kind === "off") return { refused, refusedIds: new Set() };

    const now = this.now();
    const listed = new Set(tickets.map((t) => t.id));
    for (const id of this.cache.keys()) if (!listed.has(id)) this.cache.delete(id);
    const cached = (t: Ticket) => {
      const entry = this.cache.get(t.id);
      return entry && t.updatedAt !== undefined && entry.updatedAt === t.updatedAt && now - entry.readAt < CACHE_TTL_MS ? entry.provenance : undefined;
    };

    const stale = policy.kind === "actors" ? tickets.filter((t) => !cached(t)) : [];
    let read = new Map<string, Provenance>();
    let readError: string | undefined;
    if (policy.kind === "actors" && stale.length > 0) {
      try {
        read = await policy.reader.read(stale.map((t) => ({ id: t.id, identifier: t.identifier })));
      } catch (error) {
        readError = (error as Error).message;
      }
      for (const t of stale) {
        const provenance = read.get(t.id);
        if (provenance && t.updatedAt !== undefined) this.cache.set(t.id, { updatedAt: t.updatedAt, readAt: now, provenance });
      }
    }

    const freshIds = new Set(stale.map((t) => t.id));
    for (const ticket of tickets) {
      const provenance = cached(ticket) ?? read.get(ticket.id);
      const verdict = assessTrust({ triggerLabels: this.triggerLabels, ticketLabels: ticket.labels, provenance }, policy);
      if (!verdict.trusted) refused.push({ ticket, verdict, fresh: policy.kind !== "actors" || freshIds.has(ticket.id) });
    }
    return { refused, refusedIds: new Set(refused.map((r) => r.ticket.id)), readError };
  }

  /**
   * The launch gate. Reads the ticket, then its provenance, so every edit behind the returned content
   * is in the provenance that judged it. Throws only when the ticket itself cannot be read.
   */
  async admit(ref: TicketRef): Promise<Admission> {
    const { policy } = this;
    const ticket = await this.source.getTicket(ref);
    let verdict: TrustVerdict;
    try {
      const provenance = policy.kind === "actors" ? (await policy.reader.read([ref])).get(ref.id) : undefined;
      verdict = assessTrust({ triggerLabels: this.triggerLabels, ticketLabels: ticket.labels, provenance }, policy);
    } catch (error) {
      const distrust: Distrust = { kind: "unreadable", detail: (error as Error).message };
      verdict = { trusted: false, distrust, reason: explain(distrust, policy) };
    }
    if (!verdict.trusted) return { ok: false, ticket, verdict };
    return { ok: true, ticket: freeze(structuredClone(ticket)) as AdmittedTicket, verdict };
  }
}
