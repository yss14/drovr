#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { Command, InvalidArgumentError, Option } from "commander";
import pc from "picocolors";
import { ConfigError, globalConfigPath, type LoadedConfig, loadConfig } from "./config/load.js";
import type { Config } from "./config/schema.js";
import { Dispatcher } from "./core/dispatcher.js";
import { dryRunPoll } from "./core/dryrun.js";
import { exec } from "./core/exec.js";
import { createConsoleLogger, type Logger } from "./core/log.js";
import { reportPreflight, runPreflight } from "./core/preflight.js";
import { type DispatchRecord, Store } from "./core/store.js";
import { DEFAULT_PROMPT, loadPromptTemplate, PROMPT_VARIABLES, renderPrompt, unknownPlaceholders } from "./core/template.js";
import { Watcher } from "./core/watcher.js";
import { builtinRegistry, resolveProviders } from "./plugins/registry.js";
import { runInit } from "./setup/init.js";
import { defaultsPrompter, readlinePrompter } from "./setup/prompter.js";
import { bindKeys, KEY_HELP } from "./ui/keys.js";

// ── Option plumbing ────────────────────────────────────────────────────────

const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];
const positiveInt = (value: string) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a positive integer");
  return n;
};

interface SharedOptions {
  config?: string;
  workflow?: string;
  db?: string;
  interval?: number;
  maxConcurrent?: number;
  firstRun?: "baseline" | "dispatch";
  team?: string;
  label?: string[];
  excludeLabel?: string[];
  state?: string[];
  assignee?: string;
  project?: string;
  repo?: string;
  baseBranch?: string;
  session?: string;
  focus?: boolean;
  agent?: string;
  agentArg?: string[];
  startedState?: string;
  promptFile?: string;
  promptMessage?: string;
  promptDelivery?: "file" | "inline";
  verbose?: boolean;
}

function withConfigOptions(command: Command): Command {
  return command
    .option("-c, --config <path>", "config file (default: ./drovr.config.json, then the repository root's, then ~/.config/drovr/config.json)")
    .option("--workflow <name>", "workflow name that scopes dispatch state")
    .option("--db <path>", "SQLite database path")
    .option("-v, --verbose", "also log skipped tickets and why");
}

function withRunOptions(command: Command): Command {
  return withConfigOptions(command)
    .option("--interval <seconds>", "poll interval in seconds", positiveInt)
    .option("--max-concurrent <n>", "maximum active dispatches", positiveInt)
    .addOption(new Option("--first-run <mode>", "first poll behaviour").choices(["baseline", "dispatch"]))
    .option("--team <team>", "ticket team (key, name, or ID)")
    .option("--label <label>", "required label (repeatable; replaces configured labels)", collect)
    .option("--exclude-label <label>", "excluded label (repeatable)", collect)
    .option("--state <state>", "eligible state name or type (repeatable)", collect)
    .option("--assignee <who>", 'assignee filter: "any", "none", "@me", or a user')
    .option("--project <project>", "project filter")
    .option("--started-state <state>", 'state to move tickets to once their agent has them ("none" to disable)')
    .option("--repo <path>", "single repository to work in (replaces configured repositories)")
    .option("--base-branch <branch>", "base branch for new worktrees (applies to all repositories)")
    .option("--session <name>", "Herdr session")
    .option("--focus", "focus new workspaces")
    .option("--no-focus", "create workspaces without focusing them")
    .option("--agent <provider>", "agent provider (codex, claude, or a plugin)")
    .option("--agent-arg <arg>", "extra agent argument (repeatable; replaces configured args)", collect)
    .option("--prompt-file <path>", "ticket brief template file (see `drovr prompt --variables`)")
    .option("--prompt-message <text>", "one-line message sent with file delivery")
    .addOption(new Option("--prompt-delivery <mode>", "send the brief as a file reference or inline").choices(["file", "inline"]));
}

/** Maps CLI flags onto the config shape; only flags that were given override the file. */
function overridesFrom(opts: SharedOptions, fileConfig?: Config): Record<string, unknown> {
  let repositories: unknown;
  if (opts.repo) repositories = [{ path: opts.repo, baseBranch: opts.baseBranch }];
  else if (opts.baseBranch && fileConfig) repositories = fileConfig.repositories.map((repo) => ({ ...repo, baseBranch: opts.baseBranch }));
  return {
    workflow: opts.workflow,
    database: opts.db,
    pollIntervalSeconds: opts.interval,
    maxConcurrent: opts.maxConcurrent,
    firstRun: opts.firstRun,
    tickets: { team: opts.team, labels: opts.label, excludeLabels: opts.excludeLabel, states: opts.state, assignee: opts.assignee, project: opts.project,
      startedState: opts.startedState === undefined ? undefined : opts.startedState.toLowerCase() === "none" ? null : opts.startedState,
    },
    repositories,
    terminal: { session: opts.session, focus: opts.focus },
    agent: { provider: opts.agent, args: opts.agentArg },
    prompt: { templateFile: opts.promptFile, message: opts.promptMessage, delivery: opts.promptDelivery },
  };
}

function resolveConfig(opts: SharedOptions): LoadedConfig {
  // Load once without overrides so --base-branch can be applied to the file's repositories.
  const base = loadConfig({ file: opts.config });
  return loadConfig({ file: opts.config, overrides: overridesFrom(opts, base.config) });
}

function logConfigSummary(log: Logger, { config, file, detected }: LoadedConfig): void {
  log.log("config", file ? `using ${file}` : "no config file found — using defaults and flags");
  if (detected.repository) log.detail(`repository ${detected.repository} (the current git repository)`);
  const t = config.tickets;
  log.detail(`workflow "${config.workflow}"${detected.workflow ? " (from the repository)" : ""}, poll every ${config.pollIntervalSeconds}s, max ${config.maxConcurrent} active, first run: ${config.firstRun}`);
  log.detail(`tickets: ${t.provider} team ${t.team ?? "(default)"}, labels [${t.labels.join(", ")}], states [${t.states.join(", ") || "any"}], assignee ${t.assignee}`);
  log.detail(`launch: ${config.agent.provider} in ${config.terminal.provider} session ${config.terminal.session ?? "(unset)"}, ${config.repositories.length} repo(s)`);
  log.detail(`state: ${config.database}`);
}

function openStore(config: Config, opts: { readonly?: boolean } = {}): Store {
  if (opts.readonly) return existsSync(config.database) ? new Store(config.database, { readonly: true }) : new Store(":memory:");
  return new Store(config.database);
}

async function setup(opts: SharedOptions & { dryRun?: boolean }) {
  const log = createConsoleLogger({ verbose: opts.verbose });
  const loaded = resolveConfig(opts);
  // A dry run never writes state: it reads the database if present, else uses an empty in-memory one.
  const store = openStore(loaded.config, { readonly: Boolean(opts.dryRun || loaded.config.dryRun) });
  return { log, store, ...(await buildRuntime(loaded, store, log)) };
}

/** Providers and dispatcher for a resolved config; rebuilt around the same store on a config reload. */
async function buildRuntime(loaded: LoadedConfig, store: Store, log: Logger) {
  const providers = await resolveProviders(loaded.config, { exec, log });
  const dispatcher = new Dispatcher({ config: loaded.config, store, providers, log, exec, promptTemplate: loadPromptTemplate(loaded.config) });
  return { loaded, config: loaded.config, providers, dispatcher };
}

type Runtime = Awaited<ReturnType<typeof buildRuntime>>;

/**
 * Re-reads the config file (flags still win) and checks it before `apply` swaps it in. On any error the
 * current config stays. Settings that pick the run mode or the state it is kept in need a restart.
 */
function configReloader(opts: SharedOptions & { dryRun?: boolean }, current: () => Config, store: Store, log: Logger, apply: (next: Runtime) => Promise<void> | void) {
  let reloading = false;
  return async () => {
    if (reloading) return log.log("config", "already reloading");
    reloading = true;
    log.log("config", "reloading…");
    try {
      const next = await buildRuntime(resolveConfig(opts), store, log);
      const dryRun = (c: Config) => Boolean(opts.dryRun || c.dryRun);
      const fixed = [
        next.config.workflow !== current().workflow ? "workflow" : undefined,
        next.config.database !== current().database ? "database" : undefined,
        dryRun(next.config) !== dryRun(current()) ? "dryRun" : undefined,
      ].filter(Boolean);
      if (fixed.length > 0) throw new Error(`${fixed.join(", ")} cannot change while running; restart drovr to apply`);
      if (!reportPreflight(log, await runPreflight(next.config, next.providers, { requireLaunch: !dryRun(next.config) }))) {
        throw new Error("some checks failed");
      }
      await apply(next);
      logConfigSummary(log, next.loaded);
      log.log("config", "reloaded");
    } catch (error) {
      log.log("error", `config not reloaded, keeping the current one: ${(error as Error).message}`);
    } finally {
      reloading = false;
    }
  };
}

// ── Commands ───────────────────────────────────────────────────────────────

const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const program = new Command()
  .name("drovr")
  .description("Watches Linear for eligible tickets and launches interactive coding agents in Herdr workspaces.")
  .version(VERSION)
  .showHelpAfterError();

withRunOptions(program.command("run", { isDefault: true }).description("watch for eligible tickets and launch agents"))
  .option("--dry-run", "show which tickets would launch without launching or recording anything")
  .option("--once", "poll once and exit")
  .action(async (opts: SharedOptions & { dryRun?: boolean; once?: boolean }) => {
    const { log, loaded, config, providers, store, dispatcher } = await setup(opts);
    const dryRun = Boolean(opts.dryRun || config.dryRun);
    log.log("drovr", dryRun ? pc.yellow("DRY RUN — nothing will be launched or recorded") : "starting");
    logConfigSummary(log, loaded);

    const ok = reportPreflight(log, await runPreflight(config, providers, { requireLaunch: !dryRun }));
    if (!ok) {
      log.log("error", dryRun ? "some checks failed; dry run continues with what is available" : "fix the failed checks above and try again");
      if (!dryRun) return void (process.exitCode = 1);
    }

    if (dryRun) {
      let runtime: Runtime = { loaded, config, providers, dispatcher };
      const pollOnce = () => dryRunPoll({ ...runtime, store, log }).catch((error: Error) => log.log("error", error.message));
      await pollOnce();
      if (opts.once || !process.stdin.isTTY) return store.close();
      const every = () => `dry run repeats every ${runtime.config.pollIntervalSeconds}s`;
      log.log("drovr", `${every()} · ${pc.bold("p")} poll now · ${pc.bold("r")} reload config · ${pc.bold("q")} quit`);
      let timer = setInterval(pollOnce, config.pollIntervalSeconds * 1000);
      const reload = configReloader(opts, () => runtime.config, store, log, (next) => {
        runtime = next;
        clearInterval(timer);
        timer = setInterval(pollOnce, next.config.pollIntervalSeconds * 1000);
        log.log("drovr", every());
        void pollOnce();
      });
      await new Promise<void>((resolveQuit) => {
        const unbind = bindKeys({
          togglePause() {},
          status() {},
          pollNow: () => void pollOnce(),
          reload: () => void reload(),
          quit: () => (clearInterval(timer), unbind(), resolveQuit()),
        });
      });
      return store.close();
    }

    const watcher = new Watcher({ config, store, providers, dispatcher, log });
    let current = config;
    const reload = configReloader(opts, () => current, store, log, async (next) => {
      if (watcher.phase === "launching") log.log("config", "applies once the launch in progress finishes");
      await watcher.reload(next);
      current = next.config;
    });
    let unbind = () => {};
    const quit = async () => {
      log.log("drovr", "stopping…");
      unbind();
      await watcher.stop();
    };
    process.once("SIGTERM", () => void quit());
    if (!opts.once) {
      process.once("SIGINT", () => void quit());
      if (process.stdin.isTTY) {
        unbind = bindKeys({
          togglePause: () => watcher.togglePause(),
          pollNow: () => {
            log.log("drovr", "polling now");
            watcher.pollNow();
          },
          status: () => printStatus(log, watcher.statusLine(), watcher.activeRecords()),
          reload: () => void reload(),
          quit: () => void quit(),
        });
        log.log("drovr", `keys: ${KEY_HELP}`);
      }
    }
    try {
      await watcher.start({ once: opts.once });
    } catch (error) {
      log.log("error", (error as Error).message);
      process.exitCode = 1;
      unbind();
      return store.close();
    }
    await watcher.done;
    store.close();
    process.exit(process.exitCode ?? 0);
  });

function printStatus(log: Logger, line: string, records: DispatchRecord[]): void {
  log.log("drovr", line);
  if (records.length === 0) log.detail("no active, failed, or pending-retry dispatches");
  for (const r of records) log.detail(describeRecord(r));
}

function describeRecord(r: DispatchRecord): string {
  const parts = [
    `${r.identifier.padEnd(10)} ${r.state}${r.step ? `@${r.step}` : ""}`,
    r.agentStatus ? `agent ${r.agentStatus}` : undefined,
    r.workspaceId ? `ws ${r.workspaceId}` : undefined,
    r.reason ? pc.dim(r.reason.length > 100 ? `${r.reason.slice(0, 100)}…` : r.reason) : undefined,
  ];
  return parts.filter(Boolean).join(" · ");
}

async function check(opts: SharedOptions): Promise<void> {
  const log = createConsoleLogger({ verbose: opts.verbose });
  const loaded = resolveConfig(opts);
  logConfigSummary(log, loaded);
  const providers = await resolveProviders(loaded.config, { exec, log });
  const ok = reportPreflight(log, await runPreflight(loaded.config, providers, { requireLaunch: true }));
  process.exitCode = ok ? 0 : 1;
}

withRunOptions(program.command("check").description("check that configured providers are available")).action(check);

withRunOptions(program.command("config").description("print the resolved configuration (defaults ← file ← flags)"))
  .action((opts: SharedOptions) => {
    const loaded = resolveConfig(opts);
    process.stderr.write(pc.dim(`# ${loaded.file ?? "no config file; defaults and flags only"}\n`));
    process.stdout.write(`${JSON.stringify(loaded.config, null, 2)}\n`);
  });

withRunOptions(program.command("prompt [ticket]").description("preview exactly what would be sent to the agent for a ticket"))
  .option("--default", "print the built-in brief template (a starting point for --prompt-file)")
  .option("--variables", "list the template variables")
  .action(async (ref: string | undefined, opts: SharedOptions & { default?: boolean; variables?: boolean }) => {
    if (opts.default) return void process.stdout.write(DEFAULT_PROMPT);
    if (opts.variables) {
      for (const [name, description] of Object.entries(PROMPT_VARIABLES)) console.log(`${pc.bold(`{${name}}`.padEnd(18))} ${description}`);
      return;
    }
    if (!ref) {
      console.error("Pass a ticket (e.g. drovr prompt PQ-1234), --default, or --variables");
      return void (process.exitCode = 1);
    }
    const { providers, config, dispatcher, store } = await setup({ ...opts, dryRun: true });
    store.close();
    const ticket = await providers.tickets.getTicket({ id: ref, identifier: ref });
    const plan = await dispatcher.plan(ticket).catch(() => undefined);
    const rendered = renderPrompt(config, loadPromptTemplate(config), ticket, {
      worktreePath: plan?.worktreePath,
      branch: plan?.branch,
      baseBranch: plan?.baseBranch,
      repo: plan?.repo.path,
      agent: providers.agent.displayName,
    });
    const rule = (title: string) => console.log(pc.dim(`── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`));
    rule(rendered.briefPath ? `sent to the agent (${config.prompt.delivery} delivery)` : "sent to the agent (inline delivery)");
    console.log(rendered.text);
    if (rendered.briefPath) {
      rule(`brief written to <worktree>/${rendered.briefPath}`);
      console.log(rendered.brief);
    }
    const unknown = [...unknownPlaceholders(loadPromptTemplate(config)), ...(rendered.briefPath ? unknownPlaceholders(config.prompt.message) : [])];
    if (unknown.length > 0) console.error(pc.yellow(`warning: unknown placeholders left verbatim: ${unknown.map((u) => `{${u}}`).join(", ")}`));
  });

program
  .command("init")
  .description("set up a config file, offering the Linear teams, Herdr sessions, and agents found on this machine")
  .option("-g, --global", `write the per-user config (${globalConfigPath()}) instead of asking`)
  .option("-y, --yes", "take every suggested answer without asking")
  .option("--force", "overwrite an existing file")
  .action(async (opts: { global?: boolean; yes?: boolean; force?: boolean }) => {
    const prompter = opts.yes || !process.stdin.isTTY ? defaultsPrompter() : readlinePrompter();
    try {
      const result = await runInit({ exec, prompter, cwd: process.cwd(), global: opts.global, force: opts.force });
      if (!result) return void (process.exitCode = 1);
      if (prompter.interactive && (await prompter.confirm("Run `drovr check` now?", true))) {
        prompter.close();
        console.log();
        return check({ config: result.path });
      }
      console.log(`next: \`drovr check\`, then \`drovr run --dry-run --once\``);
    } finally {
      prompter.close();
    }
  });

withConfigOptions(program.command("history [ticket]").description("list dispatch records, or the event log of one ticket"))
  .option("-a, --all", "include baseline and completed records")
  .option("-n, --limit <n>", "maximum records", positiveInt, 50)
  .option("--json", "print JSON")
  .action((ticket: string | undefined, opts: SharedOptions & { all?: boolean; limit: number; json?: boolean }) => {
    const { config } = resolveConfig(opts);
    const store = openStore(config, { readonly: true });
    if (ticket) {
      const record = requireRecord(store, config, ticket);
      const events = store.events(config.workflow, record.issueId);
      if (opts.json) return void console.log(JSON.stringify({ record, events }, null, 2));
      console.log(`${pc.bold(record.identifier)} ${record.title}\n${record.url ?? ""}`);
      console.log(
        [
          `state      ${record.state}${record.step ? ` (step ${record.step})` : ""}${record.reason ? ` — ${record.reason}` : ""}`,
          `worktree   ${record.worktreePath ?? "-"}${record.branch ? ` (${record.branch})` : ""}`,
          `workspace  ${record.workspaceId ?? "-"} pane ${record.paneId ?? "-"}`,
          `agent      ${record.agentName ?? "-"} (${record.agentKind ?? "-"}) ${record.agentStatus ?? ""}`,
          `created    ${record.createdAt}  launched ${record.launchedAt ?? "-"}  completed ${record.completedAt ?? "-"}  attempts ${record.attempts}`,
        ].join("\n"),
      );
      console.log(pc.bold("\nevents"));
      for (const e of events) console.log(`${pc.dim(e.at)} ${e.kind.padEnd(16)} ${e.message}`);
      return store.close();
    }
    const states = opts.all ? undefined : (["launching", "running", "needs_attention", "failed", "retry"] as const);
    const records = store.list(config.workflow, { states: states ? [...states] : undefined, limit: opts.limit });
    if (opts.json) return void console.log(JSON.stringify(records, null, 2));
    const lease = store.getLease(config.workflow);
    console.log(pc.dim(`workflow ${config.workflow} · ${store.countActive(config.workflow)}/${config.maxConcurrent} active · watcher ${lease ? `pid ${lease.pid}, heartbeat ${lease.heartbeatAt}` : "not running"}`));
    if (records.length === 0) console.log(opts.all ? "no dispatch records" : "no open dispatches (use --all to include baseline and completed)");
    for (const r of records) console.log(`${describeRecord(r)} ${pc.dim(r.updatedAt)}`);
    store.close();
  });

withConfigOptions(program.command("retry <ticket>").description("resume a failed, stuck, or baseline ticket on the next poll"))
  .option("--resend-prompt", "submit the ticket prompt again even if it may have been delivered")
  .action((ticket: string, opts: SharedOptions & { resendPrompt?: boolean }) => {
    const { config } = resolveConfig(opts);
    const store = openStore(config);
    const record = requireRecord(store, config, ticket);
    if (record.state === "launching") {
      console.error(`${record.identifier} is launching right now; wait for it to finish or fail`);
      return void (process.exitCode = 1);
    }
    store.update(config.workflow, record.issueId, {
      state: "retry",
      reason: null,
      autoResume: false,
      completedAt: null,
      ...(opts.resendPrompt ? { promptIntentAt: null, promptedAt: null } : {}),
    });
    store.addEvent(config.workflow, record, "retry", `Retry requested from ${record.state}${opts.resendPrompt ? " (resend prompt)" : ""}`);
    console.log(`${record.identifier}: ${record.state} → retry. A running watcher picks it up on its next poll (press p to poll now) once a slot is free.`);
    store.close();
  });

withConfigOptions(program.command("done <ticket>").description("mark a dispatch completed and free its slot"))
  .action((ticket: string, opts: SharedOptions) => {
    const { config } = resolveConfig(opts);
    const store = openStore(config);
    const record = requireRecord(store, config, ticket);
    store.update(config.workflow, record.issueId, { state: "completed", step: null, autoResume: false, reason: "marked done by user", completedAt: new Date().toISOString() });
    store.addEvent(config.workflow, record, "completed", "Marked done by user");
    console.log(`${record.identifier}: ${record.state} → completed. The worktree and Herdr workspace are left as they are.`);
    store.close();
  });

withConfigOptions(program.command("forget <ticket>").description("delete a dispatch record so the ticket can launch again when it matches"))
  .action((ticket: string, opts: SharedOptions) => {
    const { config } = resolveConfig(opts);
    const store = openStore(config);
    const record = requireRecord(store, config, ticket);
    store.addEvent(config.workflow, record, "forgotten", `Record deleted (was ${record.state})`);
    store.delete(config.workflow, record.issueId);
    console.log(`${record.identifier}: record deleted. It launches again the next time it matches. The worktree and workspace are untouched.`);
    store.close();
  });

program
  .command("plugins")
  .description("list available providers")
  .option("-c, --config <path>", "config file, to include its plugins")
  .action(async (opts: { config?: string }) => {
    const registry = builtinRegistry();
    let plugins: string[] = [];
    try {
      plugins = loadConfig({ file: opts.config }).config.plugins;
    } catch {}
    for (const plugin of plugins) await registry.load(plugin);
    for (const def of registry.list()) console.log(`${def.kind.padEnd(9)} ${def.id.padEnd(10)} ${def.description}`);
  });

function requireRecord(store: Store, config: Config, ref: string): DispatchRecord {
  const record = store.find(config.workflow, ref);
  if (!record) {
    console.error(`No dispatch record for ${ref} in workflow "${config.workflow}"`);
    process.exit(1);
  }
  return record;
}

program.parseAsync().catch((error: unknown) => {
  if (error instanceof ConfigError) console.error(pc.red(error.message));
  else console.error(pc.red((error as Error).stack ?? String(error)));
  process.exit(1);
});
