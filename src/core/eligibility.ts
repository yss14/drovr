import type { Config, RepositoryConfig } from "../config/schema.js";
import type { Ticket, TicketCriteria } from "../plugins/types.js";

export function criteriaFromConfig(config: Config): TicketCriteria {
  const { team, labels, excludeLabels, states, assignee, project } = config.tickets;
  return { team, labels, excludeLabels, states, assignee, project };
}

const norm = (value: string) => value.trim().toLowerCase();

export interface Evaluation {
  eligible: boolean;
  /** Why it matches, or why not. */
  reasons: string[];
}

/**
 * Re-checks a ticket against the criteria locally. Providers may filter server-side, but
 * drovr does not rely on that: this is the authoritative eligibility decision.
 */
export function evaluateTicket(ticket: Ticket, criteria: TicketCriteria): Evaluation {
  const labels = new Set(ticket.labels.map(norm));
  const failures: string[] = [];
  const matches: string[] = [];

  const missing = criteria.labels.filter((label) => !labels.has(norm(label)));
  if (missing.length > 0) failures.push(`missing label${missing.length > 1 ? "s" : ""} ${missing.join(", ")}`);
  else if (criteria.labels.length > 0) matches.push(`labels ${criteria.labels.join(", ")}`);

  const excluded = criteria.excludeLabels.filter((label) => labels.has(norm(label)));
  if (excluded.length > 0) failures.push(`has excluded label ${excluded.join(", ")}`);

  if (criteria.states.length > 0) {
    const wanted = criteria.states.map(norm);
    if (wanted.includes(norm(ticket.state.name)) || wanted.includes(norm(ticket.state.type))) {
      matches.push(`state ${ticket.state.name}`);
    } else {
      failures.push(`state ${ticket.state.name} not in ${criteria.states.join(", ")}`);
    }
  }

  if (criteria.assignee === "none" && ticket.assignee) failures.push(`assigned to ${ticket.assignee}`);

  return failures.length > 0 ? { eligible: false, reasons: failures } : { eligible: true, reasons: matches };
}

export function isCompleted(ticket: Pick<Ticket, "state">, completion: Config["completion"]): boolean {
  const type = norm(ticket.state.type);
  const name = norm(ticket.state.name);
  return completion.stateTypes.some((t) => norm(t) === type) || completion.states.some((s) => norm(s) === name);
}

export type RouteResult = { ok: true; repo: RepositoryConfig } | { ok: false; reason: string };

/** Picks the repository for a ticket: first repo whose routeLabels intersect the ticket's labels, else the catch-all. */
export function routeTicket(ticket: Ticket, repositories: RepositoryConfig[]): RouteResult {
  if (repositories.length === 0) return { ok: false, reason: "no repositories configured" };
  const labels = new Set(ticket.labels.map(norm));
  const routed = repositories.find((repo) => repo.routeLabels.some((label) => labels.has(norm(label))));
  if (routed) return { ok: true, repo: routed };
  const catchAll = repositories.filter((repo) => repo.routeLabels.length === 0);
  if (catchAll.length === 1) return { ok: true, repo: catchAll[0]! };
  if (catchAll.length > 1) {
    return { ok: false, reason: "several catch-all repositories configured; add routeLabels to disambiguate" };
  }
  const known = repositories.flatMap((repo) => repo.routeLabels).join(", ");
  return { ok: false, reason: `no repository route matches its labels (routes: ${known})` };
}

/** Dispatch order: priority (1 = urgent … 4 = low, 0 = none last), then oldest first. */
export function compareTickets(a: Ticket, b: Ticket): number {
  const rank = (p?: number) => (p === undefined || p === 0 ? 99 : p);
  return rank(a.priority) - rank(b.priority) || (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
}
