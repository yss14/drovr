import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, mergeConfig } from "../src/config/load.js";
import { evaluateTicket, routeTicket } from "../src/core/eligibility.js";
import { configSchema } from "../src/config/schema.js";
import { ticket } from "./fakes.js";

function configFile(content: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "drovr-test-"));
  const file = join(dir, "drovr.config.json");
  writeFileSync(file, JSON.stringify(content));
  return { dir, file };
}

describe("config", () => {
  it("applies documented defaults", () => {
    const config = configSchema.parse({});
    expect(config).toMatchObject({
      pollIntervalSeconds: 60,
      maxConcurrent: 1,
      firstRun: "dispatch",
      tickets: { provider: "linear", labels: ["agent-ready"], states: ["Todo"], assignee: "any" },
      terminal: { provider: "herdr", focus: false },
      agent: { provider: "codex" },
    });
  });

  it("lets CLI overrides win over the file, replacing arrays", () => {
    const { file, dir } = configFile({ maxConcurrent: 3, tickets: { team: "PQ", labels: ["a", "b"] }, repositories: [{ path: "./repo" }] });
    const { config } = loadConfig({ file, overrides: { maxConcurrent: 2, tickets: { labels: ["c"], team: undefined } } });
    expect(config.maxConcurrent).toBe(2);
    expect(config.tickets.labels).toEqual(["c"]);
    expect(config.tickets.team).toBe("PQ");
    expect(config.repositories[0]!.path).toBe(join(dir, "repo"));
  });

  it("expands ~ in the default database path", () => {
    const { file } = configFile({});
    expect(loadConfig({ file }).config.database).toMatch(/^\/.*\.local\/state\/drovr\/drovr\.db$/);
  });

  it("expands ~ in agent env values only", () => {
    const { file } = configFile({ agent: { env: { CLAUDE_CONFIG_DIR: "~/.claude-team", MODE: "a~b" } } });
    const { env } = loadConfig({ file }).config.agent;
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(homedir(), ".claude-team"));
    expect(env.MODE).toBe("a~b");
  });

  it("rejects invalid agent env names", () => {
    const { file } = configFile({ agent: { env: { "BAD-NAME": "x" } } });
    expect(() => loadConfig({ file })).toThrow(/agent\.env/);
  });

  it("reports invalid values with their path", () => {
    const { file } = configFile({ maxConcurrent: 0 });
    expect(() => loadConfig({ file })).toThrow(ConfigError);
    expect(() => loadConfig({ file })).toThrow(/maxConcurrent/);
  });

  it("merges nested objects", () => {
    expect(mergeConfig({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });
});

describe("eligibility", () => {
  const criteria = { labels: ["agent-ready"], excludeLabels: ["blocked"], states: ["Todo"], assignee: "any" };

  it("explains why a ticket matches or not", () => {
    expect(evaluateTicket(ticket(1), criteria)).toEqual({ eligible: true, reasons: ["labels agent-ready", "state Todo"] });
    const result = evaluateTicket(ticket(1, { labels: ["blocked"], state: { name: "Done", type: "completed" } }), criteria);
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["missing label agent-ready", "has excluded label blocked", "state Done not in Todo"]);
  });

  it("matches state names or types case-insensitively", () => {
    expect(evaluateTicket(ticket(1), { ...criteria, states: ["unstarted"] }).eligible).toBe(true);
    expect(evaluateTicket(ticket(1), { ...criteria, states: ["todo"] }).eligible).toBe(true);
  });

  it("routes by label, falling back to a single catch-all", () => {
    const repos = configSchema.parse({ repositories: [{ path: "/a", routeLabels: ["frontend"] }, { path: "/b" }] }).repositories;
    expect(routeTicket(ticket(1, { labels: ["frontend"] }), repos)).toMatchObject({ ok: true, repo: { path: "/a" } });
    expect(routeTicket(ticket(1), repos)).toMatchObject({ ok: true, repo: { path: "/b" } });
  });
});
