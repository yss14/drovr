import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { type Exec, exec as realExec } from "../src/core/exec.js";
import { runInit } from "../src/setup/init.js";
import { defaultsPrompter, type Prompter } from "../src/setup/prompter.js";
import { gitRepo } from "./fakes.js";

const HERDR_SESSIONS = `name      status   directory              socket
default   stopped  /home/u/.config/herdr  /home/u/.config/herdr/herdr.sock
work      running  /home/u/.config/herdr/sessions/work  /home/u/.config/herdr/sessions/work/herdr.sock
`;

/** Linear, Herdr, and PATH lookups answered from fixtures; git runs for real against the temp repository. */
function fakeMachine(opts: { linear?: boolean; labels?: string[] } = {}): Exec {
  const linear: Record<string, unknown> = {
    "team list": [{ key: "ENG", name: "Engineering" }, { key: "OPS", name: "Operations" }],
    "team states": [
      { name: "Backlog", type: "backlog" },
      { name: "Todo", type: "unstarted" },
      { name: "In Progress", type: "started" },
      { name: "In Review", type: "started" },
      { name: "Done", type: "completed" },
    ],
    "label list": (opts.labels ?? ["agent-ready", "Bug"]).map((name) => ({ name })),
  };
  return async (command, args, options) => {
    const ok = (stdout: string) => ({ command, args, code: 0, stdout, stderr: "", timedOut: false });
    const fail = { command, args, code: 1, stdout: "", stderr: "nope", timedOut: false };
    if (command === "git") return realExec(command, args, options);
    if (command === "/bin/sh") return ["linear", "codex"].includes(args[3]!) && opts.linear !== false ? ok(`/usr/bin/${args[3]}`) : fail;
    if (command === "herdr") return ok(HERDR_SESSIONS);
    if (command === "linear" && args[0] === "auth") return ok("me@example.com");
    const body = linear[args.slice(0, 2).join(" ")];
    return command === "linear" && body ? ok(JSON.stringify(body)) : fail;
  };
}

/** Takes the default for every question except those whose text starts with a key of `answers`. */
function scripted(answers: Record<string, string | string[] | boolean>): Prompter {
  const base = defaultsPrompter();
  const find = (question: string) => Object.entries(answers).find(([prefix]) => question.startsWith(prefix))?.[1];
  return {
    ...base,
    interactive: true,
    text: async (q, o) => (find(q) as string | undefined) ?? base.text(q, o),
    select: async (q, c, o) => (find(q) as string | undefined) ?? base.select(q, c, o),
    multiselect: async (q, c, o) => (find(q) as string[] | undefined) ?? base.multiselect(q, c, o),
    confirm: async (q, d) => (find(q) as boolean | undefined) ?? d,
  };
}

const quiet = () => {};

beforeEach(() => void vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "drovr-xdg-"))));

describe("drovr init", () => {
  it("writes a repository config from what it finds, and keeps it out of git", async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "pnpm-lock.yaml"), "");
    const result = await runInit({ exec: fakeMachine(), prompter: defaultsPrompter(), cwd: repo, say: quiet });

    expect(result?.path).toBe(join(repo, "drovr.config.json"));
    expect(JSON.parse(readFileSync(result!.path, "utf8"))).toEqual({
      workflow: "acme-web-app",
      maxConcurrent: 1,
      firstRun: "dispatch",
      tickets: { provider: "linear", team: "ENG", labels: ["agent-ready"], states: ["Todo"], assignee: "any", startedState: "In Progress" },
      completion: { stateTypes: ["completed", "canceled"], states: ["In Review"] },
      repositories: [{ path: ".", baseBranch: "main", setup: ["pnpm install --frozen-lockfile"] }],
      terminal: { provider: "herdr", session: "work" },
      agent: { provider: "codex", args: [] },
    });
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain("/drovr.config.json");
    expect(loadConfig({ cwd: repo }).config.repositories[0]!.path).toBe(repo);
  });

  it("uses the answers given", async () => {
    const repo = gitRepo();
    const result = await runInit({
      exec: fakeMachine(),
      cwd: repo,
      say: quiet,
      prompter: scripted({
        "Linear team": "OPS",
        "Labels": ["Bug", "agent-ready"],
        "Whose": "@me",
        "Move a ticket": "none",
        "Also count": [],
        "Setup command": "none",
        "Herdr session": "fresh-session",
        "Coding agent": "claude",
        "Maximum": "3",
        "Tickets that already match": "baseline",
      }),
    });
    expect(result?.config).toMatchObject({
      maxConcurrent: 3,
      firstRun: "baseline",
      tickets: { team: "OPS", labels: ["Bug", "agent-ready"], assignee: "@me", startedState: null },
      completion: { states: [] },
      repositories: [{ path: ".", setup: [] }],
      terminal: { session: "fresh-session" },
      agent: { provider: "claude" },
    });
  });

  it("offers agent-ready even when the team does not have it, so the default never matches every ticket", async () => {
    const result = await runInit({ exec: fakeMachine({ labels: ["Bug"] }), prompter: defaultsPrompter(), cwd: gitRepo(), say: quiet });
    expect(result?.config).toMatchObject({ tickets: { labels: ["agent-ready"] } });
  });

  it("writes a global config without repository or workflow, and falls back to typed filters without Linear", async () => {
    const result = await runInit({ exec: fakeMachine({ linear: false }), prompter: defaultsPrompter(), cwd: gitRepo(), global: true, say: quiet });
    expect(result?.path).toBe(join(process.env.XDG_CONFIG_HOME!, "drovr", "config.json"));
    expect(result?.config).not.toHaveProperty("workflow");
    expect(result?.config).not.toHaveProperty("repositories");
    expect(result?.config).toMatchObject({ tickets: { labels: ["agent-ready"], states: ["Todo"], startedState: "In Progress" } });
    expect(result?.config.tickets).not.toHaveProperty("team");
  });

  it("does not overwrite an existing file unless forced", async () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "drovr.config.json"), "{}");
    expect(await runInit({ exec: fakeMachine(), prompter: defaultsPrompter(), cwd: repo, say: quiet })).toBeUndefined();
    expect(readFileSync(join(repo, "drovr.config.json"), "utf8")).toBe("{}");
    expect(await runInit({ exec: fakeMachine(), prompter: defaultsPrompter(), cwd: repo, force: true, say: quiet })).toBeDefined();
  });

  it("writes to the current directory outside a repository only when chosen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drovr-plain-"));
    const result = await runInit({ exec: fakeMachine(), prompter: defaultsPrompter(), cwd: dir, say: quiet });
    expect(result?.path).toBe(join(process.env.XDG_CONFIG_HOME!, "drovr", "config.json"));
    expect(existsSync(join(dir, "drovr.config.json"))).toBe(false);
  });
});
