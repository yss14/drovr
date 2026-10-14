import pc from "picocolors";
import type { Config } from "../config/schema.js";
import type { Providers } from "../plugins/registry.js";
import type { AvailabilityResult } from "../plugins/types.js";
import { criteriaFromConfig } from "./eligibility.js";
import { loadPromptTemplate, unknownPlaceholders } from "./template.js";
import type { Logger } from "./log.js";

export interface CheckResult {
  name: string;
  result: AvailabilityResult;
}

/**
 * Checks that every configured provider is usable: binaries present, authenticated, Herdr
 * session running, repositories valid, agent kind supported by the terminal.
 */
export async function runPreflight(config: Config, providers: Providers, opts: { requireLaunch: boolean }): Promise<CheckResult[]> {
  const settle = async (name: string, fn: () => Promise<AvailabilityResult>): Promise<CheckResult> => {
    try {
      return { name, result: await fn() };
    } catch (error) {
      return { name, result: { ok: false, detail: (error as Error).message } };
    }
  };

  const tickets = providers.tickets;
  const checks: Promise<CheckResult>[] = [
    settle(`tickets: ${tickets.id}`, async () => {
      const availability = await tickets.checkAvailability();
      if (!availability.ok || !tickets.validateCriteria) return availability;
      const results = [availability, await tickets.validateCriteria(criteriaFromConfig(config))];
      const target = config.tickets.startedState;
      if (target) {
        if (!tickets.moveTicket) results.push({ ok: false, detail: `${tickets.id} cannot update tickets; set tickets.startedState to null` });
        else if (tickets.checkState) results.push(await tickets.checkState(target, config.tickets.team));
      }
      return {
        ok: results.every((r) => r.ok),
        detail: results.map((r) => r.detail).join("; "),
        warnings: results.flatMap((r) => r.warnings ?? []),
      };
    }),
  ];

  if (opts.requireLaunch || config.terminal.session) {
    checks.push(
      settle(`terminal: ${providers.terminal.id}`, async () => {
        if (!config.terminal.session) return { ok: false, detail: "no session configured (set terminal.session or pass --session)" };
        return providers.terminal.checkAvailability();
      }),
    );
  }
  checks.push(
    settle(`agent: ${providers.agent.id}`, async () => {
      const result = await providers.agent.checkAvailability();
      const kinds = providers.terminal.supportedAgentKinds();
      const kind = providers.agent.launchSpec(providers.terminal.id, []).kind;
      if (kinds && !kinds.includes(kind)) return { ok: false, detail: `${providers.terminal.id} cannot launch agent kind "${kind}"` };
      return result;
    }),
  );
  if (config.repositories.length === 0) {
    checks.push(Promise.resolve({ name: "repositories", result: { ok: !opts.requireLaunch, detail: "none configured (add repositories[] or pass --repo)" } }));
  }
  checks.push(settle("prompt", async () => checkPrompt(config)));
  const vcsIds = new Set<string>();
  for (const repo of config.repositories) {
    const vcs = providers.vcsFor(repo);
    vcsIds.add(vcs.id);
    checks.push(
      settle(`repo: ${repo.name ?? repo.path}`, async () => {
        const result = await vcs.checkRepository(repo.path);
        if (!result.ok) return result;
        const base = repo.baseBranch ?? (await vcs.defaultBranch(repo.path, repo.remote));
        const how = `worktrees via ${vcs.id}${repo.vcs === "auto" ? " (auto)" : ""}`;
        return { ...result, detail: `base ${base}${repo.baseBranch ? "" : " (remote HEAD)"}, ${how} — ${result.detail}` };
      }),
    );
  }
  for (const id of vcsIds) {
    const vcs = providers.vcsFor(config.repositories.find((r) => providers.vcsFor(r).id === id)!);
    checks.push(settle(`vcs: ${id}`, () => vcs.checkAvailability()));
  }
  return Promise.all(checks);
}

export function reportPreflight(log: Logger, results: CheckResult[]): boolean {
  for (const { name, result } of results) {
    log.log(result.ok ? "check" : "error", `${result.ok ? pc.green("✓") : pc.red("✗")} ${name} — ${result.detail}`);
    for (const warning of result.warnings ?? []) log.detail(`warning: ${warning}`);
  }
  return results.every((r) => r.result.ok);
}

/** Loads the prompt templates and rejects placeholders drovr would not fill in. */
export function checkPrompt(config: Config): AvailabilityResult {
  let template: string;
  try {
    template = loadPromptTemplate(config);
  } catch (error) {
    return { ok: false, detail: `cannot read prompt template: ${(error as Error).message}` };
  }
  const parts: [string, string][] = [["template", template]];
  if (config.prompt.delivery === "file") parts.push(["message", config.prompt.message], ["briefPath", config.prompt.briefPath]);
  if (config.prompt.delivery === "file") {
    const message = config.prompt.message.trim();
    // The message is typed to the agent verbatim; a bare path means the template file went into the wrong key.
    if (/^[~/.][^\s]*$/.test(message)) {
      return { ok: false, detail: `prompt.message is the text typed to the agent, but it is a path (${message}). To use a brief template file, set prompt.templateFile instead` };
    }
    if (!message.includes("{briefPath}")) {
      return { ok: false, detail: "prompt.message must contain {briefPath}, otherwise the agent is never told where its brief is" };
    }
  }
  const problems = parts.flatMap(([name, text]) => unknownPlaceholders(text).map((v) => `{${v}} in ${name}`));
  if (problems.length > 0) {
    return { ok: false, detail: `unknown placeholder${problems.length > 1 ? "s" : ""} ${problems.join(", ")} (see \`drovr prompt --variables\`)` };
  }
  const source = config.prompt.templateFile ?? (config.prompt.template ? "prompt.template" : "built-in template");
  return { ok: true, detail: `${source}, ${config.prompt.delivery} delivery${config.prompt.delivery === "file" ? ` to ${config.prompt.briefPath}` : ""}` };
}
