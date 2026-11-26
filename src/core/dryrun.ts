import type { Config } from "../config/schema.js";
import type { Providers } from "../plugins/registry.js";
import type { Dispatcher } from "./dispatcher.js";
import { compareTickets, criteriaFromConfig, evaluateTicket } from "./eligibility.js";
import type { Logger } from "./log.js";
import type { Store } from "./store.js";
import type { Admission, TrustGate } from "./trust.js";

/**
 * Shows what one poll would do — baseline, launch, queue, or skip — without writing state,
 * creating worktrees, or touching the terminal. Reads existing dispatch state if available.
 */
export async function dryRunPoll(deps: { config: Config; providers: Providers; store?: Store; dispatcher: Dispatcher; trust: TrustGate; log: Logger }): Promise<void> {
  const { config, providers, store, dispatcher, trust, log } = deps;
  const criteria = criteriaFromConfig(config);
  const tickets = await providers.tickets.listCandidates(criteria);
  log.log("dry-run", `${tickets.length} ticket(s) fetched (${providers.tickets.describeQuery(criteria)})`);

  const matching = [];
  for (const ticket of tickets) {
    const evaluation = evaluateTicket(ticket, criteria);
    if (evaluation.eligible) matching.push(ticket);
    else log.log("dry-run", `${ticket.identifier} would be skipped: ${evaluation.reasons.join("; ")}`);
  }
  const screen = await trust.screen(matching.filter((t) => !store?.get(config.workflow, t.id)));
  if (screen.readError) log.log("dry-run", `could not read who labeled or edited tickets: ${screen.readError}`);
  for (const { ticket, verdict } of screen.refused) log.log("dry-run", `${ticket.identifier} would be skipped: not trusted: ${verdict.reason}`);
  const eligible = matching.filter((t) => !screen.refusedIds.has(t.id));

  const baselineDone = store?.getMeta(config.workflow, "baseline_done_at");
  if (!baselineDone && config.firstRun === "baseline") {
    log.log("dry-run", `first run of workflow "${config.workflow}": ${eligible.length} matching ticket(s) would be recorded as a baseline and NOT launched`);
    for (const ticket of eligible) log.detail(`${ticket.identifier} [${ticket.state.name}] ${ticket.title}`);
    log.detail("pass --first-run dispatch to launch already-matching tickets instead");
    return;
  }

  let free = config.maxConcurrent - (store?.countActive(config.workflow) ?? 0);
  const fresh = eligible.filter((ticket) => {
    const existing = store?.get(config.workflow, ticket.id);
    if (existing) log.log("dry-run", `${ticket.identifier} would be skipped: already dispatched (${existing.state})`);
    return !existing;
  });
  if (fresh.length === 0) log.log("dry-run", "nothing new would launch");

  for (const ticket of fresh.sort(compareTickets)) {
    const reasons = evaluateTicket(ticket, criteria).reasons.join(", ");
    if (free <= 0) {
      log.log("dry-run", `${ticket.identifier} would be queued (no free slot): ${ticket.title}`);
      continue;
    }
    let admission: Admission;
    try {
      admission = await trust.admit(ticket);
    } catch (error) {
      log.log("dry-run", `${ticket.identifier} would fail to load: ${(error as Error).message}`);
      continue;
    }
    if (!admission.ok) {
      log.log("dry-run", `${ticket.identifier} would be refused at launch: ${admission.verdict.reason}`);
      continue;
    }
    free -= 1;
    log.log("dry-run", `${ticket.identifier} WOULD LAUNCH (${reasons}; ${admission.verdict.basis}): ${ticket.title}`);
    try {
      const plan = await dispatcher.plan(admission.ticket);
      log.detail(`repo ${plan.repo.path}, branch ${plan.branch} from ${plan.repo.remote}/${plan.baseBranch}`);
      const vcs = providers.vcsFor(plan.repo);
      log.detail(`worktree ${plan.worktreePath} via ${vcs.id}${vcs.runSetupHooks ? " (the agent starts after its pre-start hooks finish)" : ""}`);
      if (config.tickets.startedState) log.detail(`once the agent acknowledges the ticket, it moves to "${config.tickets.startedState}"`);
      log.detail(`${providers.terminal.id} workspace "${plan.workspaceLabel}" in session ${config.terminal.session ?? "(unset)"}, ${providers.agent.displayName} agent "${plan.agentName}"`);
    } catch (error) {
      log.detail(`would fail to plan: ${(error as Error).message}`);
    }
  }
}
