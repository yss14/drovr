import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pc from "picocolors";
import { detectRepository, workflowNameFor } from "../config/detect.js";
import { globalConfigPath } from "../config/load.js";
import { type Exec, describeFailure, which } from "../core/exec.js";
import { silentLogger } from "../core/log.js";
import { createGitProvider } from "../plugins/builtin/git.js";
import type { Choice, Prompter } from "./prompter.js";

const CONFIG_NAME = "drovr.config.json";
const AGENTS = ["codex", "claude"] as const;

interface LinearTeam {
  key: string;
  name: string;
}

interface LinearState {
  name: string;
  type: string;
}

export interface Discovery {
  repo?: { path: string; workflow: string; baseBranch?: string; worktrunk: boolean; setup?: string };
  linear: { ok: boolean; detail: string; teams: LinearTeam[] };
  sessions: { name: string; status: string }[];
  agents: string[];
}

/** Suggested setup command for a fresh worktree, from the repository's lockfile. */
function setupFromLockfile(repo: string): string | undefined {
  const lockfiles: [string, string][] = [
    ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
    ["package-lock.json", "npm ci"],
    ["yarn.lock", "yarn install --immutable"],
    ["bun.lock", "bun install --frozen-lockfile"],
    ["bun.lockb", "bun install --frozen-lockfile"],
  ];
  return lockfiles.find(([file]) => existsSync(join(repo, file)))?.[1];
}

async function linearJson(exec: Exec, args: string[]): Promise<unknown> {
  const result = await exec("linear", [...args, "--no-input"], { timeoutMs: 60_000, env: { NO_COLOR: "1" } });
  if (result.code !== 0) throw new Error(describeFailure(result));
  return JSON.parse(result.stdout);
}

/** Looks at the current repository and the installed tools; every probe tolerates failure. */
export async function discover(exec: Exec, cwd: string): Promise<Discovery> {
  const path = detectRepository(cwd);
  const repo = path
    ? {
        path,
        workflow: workflowNameFor(path),
        baseBranch: (await exec("git", ["-C", path, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).stdout.trim().replace(/^origin\//, "") || undefined,
        worktrunk: existsSync(join(path, ".config", "wt.toml")),
        setup: setupFromLockfile(path),
      }
    : undefined;

  const linear = async (): Promise<Discovery["linear"]> => {
    if (!(await which(exec, "linear"))) return { ok: false, detail: "linear CLI not found on PATH", teams: [] };
    const whoami = await exec("linear", ["auth", "whoami", "--no-input"], { timeoutMs: 30_000, env: { NO_COLOR: "1" } });
    if (whoami.code !== 0) return { ok: false, detail: "linear CLI is not authenticated (run `linear auth login`)", teams: [] };
    try {
      const teams = (await linearJson(exec, ["team", "list", "--json"])) as { key: string; name: string }[];
      return { ok: true, detail: whoami.stdout.trim().split("\n")[0] ?? "", teams: teams.map(({ key, name }) => ({ key, name })) };
    } catch (error) {
      return { ok: false, detail: `cannot list Linear teams: ${(error as Error).message}`, teams: [] };
    }
  };

  const sessions = async (): Promise<Discovery["sessions"]> => {
    const result = await exec("herdr", ["session", "list"], { timeoutMs: 15_000 });
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([name, status]) => name && status && name !== "name")
      .map(([name, status]) => ({ name: name!, status: status! }));
  };

  const agents = async () => (await Promise.all(AGENTS.map(async (a) => ((await which(exec, a)) ? a : undefined)))).filter((a) => a !== undefined);

  const [linearResult, sessionList, agentList] = await Promise.all([linear(), sessions(), agents()]);
  return { repo, linear: linearResult, sessions: sessionList, agents: agentList };
}

const indexWhere = <T>(items: T[], pred: (item: T) => boolean) => items.flatMap((item, i) => (pred(item) ? [i] : []));
const splitList = (value: string) => value.split(",").map((s) => s.trim()).filter(Boolean);

/** Asks for the ticket criteria, offering the team's real states and labels when Linear is reachable. */
async function askTickets(exec: Exec, prompter: Prompter, linear: Discovery["linear"], say: (line: string) => void) {
  let team: string | undefined;
  if (linear.teams.length > 0) {
    team = await prompter.select("Linear team", linear.teams.map((t) => ({ value: t.key, hint: t.name })));
  } else {
    say(pc.yellow(`! ${linear.detail} — enter the ticket filters by hand`));
    team = (await prompter.text("Linear team key (empty: the Linear CLI's default team)")) || undefined;
  }

  let states: LinearState[] = [];
  let labels: string[] = [];
  if (linear.ok && team) {
    try {
      [states, labels] = await Promise.all([
        linearJson(exec, ["team", "states", team, "--json"]) as Promise<LinearState[]>,
        (linearJson(exec, ["label", "list", "--json", "--team", team]) as Promise<{ name: string }[]>).then((ls) => [...new Set(ls.map((l) => l.name))]),
      ]);
    } catch (error) {
      say(pc.yellow(`! cannot read states and labels of ${team}: ${(error as Error).message}`));
    }
  }

  // agent-ready is always offered and preselected, so the default never makes every ticket eligible.
  const labelChoices: Choice[] = labels.map((value) => ({ value }));
  if (!labels.some((l) => l.toLowerCase() === "agent-ready")) labelChoices.unshift({ value: "agent-ready", hint: "not in Linear yet" });
  const requiredLabels =
    labels.length > 0
      ? await prompter.multiselect("Labels a ticket must have (all of them)", labelChoices, {
          defaults: indexWhere(labelChoices, (c) => c.value.toLowerCase() === "agent-ready"),
          custom: true,
        })
      : splitList(await prompter.text("Labels a ticket must have (comma-separated)", { default: "agent-ready" }));
  const missing = requiredLabels.filter((l) => labels.length > 0 && !labels.some((known) => known.toLowerCase() === l.toLowerCase()));
  if (missing.length > 0) say(pc.yellow(`! ${missing.join(", ")} does not exist in ${team} yet; create it in Linear before running drovr`));
  if (requiredLabels.length === 0) say(pc.yellow("! no required labels: every ticket in the chosen states is eligible"));

  const stateChoices: Choice[] = states.map((s) => ({ value: s.name, hint: s.type }));
  const eligibleStates =
    stateChoices.length > 0
      ? await prompter.multiselect("States a ticket may be in (any of them)", stateChoices, { defaults: indexWhere(states, (s) => s.type === "unstarted") })
      : splitList(await prompter.text("States a ticket may be in (comma-separated names or types)", { default: "Todo" }));

  const assignee = await prompter.select("Whose tickets", [
    { value: "any", hint: "anyone's or unassigned" },
    { value: "@me", hint: "assigned to you" },
    { value: "none", hint: "unassigned only" },
  ]);

  const started = states.filter((s) => s.type === "started");
  const startedChoices: Choice[] = [...started.map((s) => ({ value: s.name })), { value: "none", hint: "leave the ticket's state alone" }];
  const inProgress = started.findIndex((s) => s.name.toLowerCase() === "in progress");
  const startedState =
    started.length > 0
      ? await prompter.select("Move a ticket to this state once its agent has it", startedChoices, { default: inProgress >= 0 ? inProgress : 0 })
      : (await prompter.text('State to move a ticket to once its agent has it ("none" to leave it alone)', { default: "In Progress" })) || "none";

  const reviewCandidates = started.filter((s) => s.name !== startedState);
  const completionStates =
    reviewCandidates.length > 0
      ? await prompter.multiselect(
          "Also count a ticket as done in these states (besides completed and canceled)",
          reviewCandidates.map((s) => ({ value: s.name })),
          { defaults: indexWhere(reviewCandidates, (s) => /review/i.test(s.name)) },
        )
      : [];

  return {
    tickets: { provider: "linear", ...(team ? { team } : {}), labels: requiredLabels, states: eligibleStates, assignee, startedState: startedState === "none" ? null : startedState },
    completion: { stateTypes: ["completed", "canceled"], states: completionStates },
  };
}

export interface InitOptions {
  exec: Exec;
  prompter: Prompter;
  cwd: string;
  /** Write ~/.config/drovr/config.json without asking where. */
  global?: boolean;
  force?: boolean;
  say?: (line: string) => void;
}

export interface InitResult {
  path: string;
  config: Record<string, unknown>;
}

/** Asks for the settings drovr needs, offering what it finds on this machine, and writes the config file. */
export async function runInit(opts: InitOptions): Promise<InitResult | undefined> {
  const { exec, prompter, cwd } = opts;
  const say = opts.say ?? ((line: string) => console.log(line));
  say(pc.dim("Looking at this repository, Linear, Herdr, and installed agents…"));
  const found = await discover(exec, cwd);
  const repo = found.repo;

  const repoFile = repo ? join(repo.path, CONFIG_NAME) : resolve(cwd, CONFIG_NAME);
  const globalFile = globalConfigPath();
  let path = globalFile;
  if (!opts.global) {
    path = await prompter.select(
      "Where should the config live?",
      [
        { value: repoFile, hint: repo ? "this repository only; kept out of git" : "this directory" },
        { value: globalFile, hint: "every repository without its own config; drovr uses the repository you run it in" },
      ],
      { default: repo ? 0 : 1 },
    );
  }
  const scope = path === globalFile ? "global" : "repo";
  if (existsSync(path) && !opts.force && !(await prompter.confirm(`${path} exists. Overwrite it?`, false))) {
    say(`${path} already exists; nothing written${prompter.interactive ? "" : " (use --force to overwrite)"}`);
    return undefined;
  }

  if (repo && scope === "repo") say(`${pc.green("✓")} repository ${repo.path} (workflow "${repo.workflow}")`);
  const { tickets, completion } = await askTickets(exec, prompter, found.linear, say);

  let repositories: Record<string, unknown>[] | undefined;
  if (repo && scope === "repo") {
    const entry: Record<string, unknown> = { path: "." };
    const base = await prompter.text("Base branch for new worktrees", { default: repo.baseBranch ?? "main" });
    if (base !== repo.baseBranch) entry.baseBranch = base;
    if (repo.worktrunk) {
      say(pc.dim("  worktrunk config found: its pre-start hooks set up new worktrees"));
      entry.setup = [];
    } else {
      const setup = await prompter.text('Setup command for a new worktree ("none" for no setup)', { default: repo.setup ?? "none" });
      entry.setup = setup && setup !== "none" ? [setup] : [];
    }
    repositories = [entry];
  }

  const running = found.sessions.findIndex((s) => s.status === "running");
  const session =
    found.sessions.length > 0
      ? await prompter.select("Herdr session for the agent workspaces", found.sessions.map((s) => ({ value: s.name, hint: s.status })), {
          default: Math.max(running, 0),
          custom: true,
        })
      : await prompter.text("Herdr session for the agent workspaces (start it with `herdr --session <name>`)", { default: "main" });

  const installed = new Set(found.agents);
  const agent = await prompter.select(
    "Coding agent",
    AGENTS.map((value) => ({ value, hint: installed.has(value) ? "installed" : "not found on PATH" })),
    { default: Math.max(AGENTS.findIndex((a) => installed.has(a)), 0) },
  );

  const maxConcurrent = Number(
    await prompter.text("Maximum agents working at once", { default: "1", validate: (v) => (/^[1-9]\d*$/.test(v) ? undefined : "enter a positive whole number") }),
  );
  const firstRun = await prompter.select("Tickets that already match on the first run", [
    { value: "dispatch", hint: "launch them" },
    { value: "baseline", hint: "skip them; only launch tickets that start matching later" },
  ]);

  const config: Record<string, unknown> = {
    ...(scope === "repo" && repo ? { workflow: repo.workflow } : {}),
    maxConcurrent,
    firstRun,
    tickets,
    completion,
    ...(repositories ? { repositories } : {}),
    terminal: { provider: "herdr", session },
    agent: { provider: agent, args: [] },
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  say(`${pc.green("✓")} wrote ${path}`);
  if (scope === "repo" && repo) {
    await createGitProvider({ exec, log: silentLogger }).excludeLocally(repo.path, `/${CONFIG_NAME}`);
    say(pc.dim(`  added /${CONFIG_NAME} to the repository's .git/info/exclude`));
  }
  if (scope === "global") say(pc.dim("  drovr uses the git repository you run it in, and names the workflow after it"));
  return { path, config };
}
