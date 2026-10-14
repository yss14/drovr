import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/load.js";
import { configSchema } from "../src/config/schema.js";
import { checkPrompt } from "../src/core/preflight.js";
import { DEFAULT_PROMPT, render, renderPrompt, safeName, ticketVars, truncateWords, unknownPlaceholders } from "../src/core/template.js";
import { ticket } from "./fakes.js";

const context = { worktreePath: "/wt", branch: "feature/pq-1", baseBranch: "main", repo: "/repo", agent: "Codex" };

describe("renderPrompt", () => {
  it("sends a one-line message pointing at the brief with file delivery", () => {
    const config = configSchema.parse({});
    const result = renderPrompt(config, DEFAULT_PROMPT, ticket(1), context);
    expect(result.briefPath).toBe(".drovr/PQ-1.md");
    expect(result.text).not.toContain("\n");
    expect(result.text).toMatch(/^\[drovr:PQ-1\] .*\.drovr\/PQ-1\.md/);
    expect(result.brief).toContain("Do thing 1");
    expect(result.brief).toContain("/wt");
  });

  it("sends the custom template itself with inline delivery", () => {
    const config = configSchema.parse({ prompt: { delivery: "inline" } });
    const result = renderPrompt(config, "{marker} Fix {identifier} ({labels}) for {agent}.\n{description}", ticket(1), context);
    expect(result.briefPath).toBeUndefined();
    expect(result.text).toBe("[drovr:PQ-1] Fix PQ-1 (agent-ready) for Codex.\nDo thing 1");
  });

  it("adds the delivery marker when a custom template leaves it out", () => {
    const config = configSchema.parse({ prompt: { delivery: "inline" } });
    expect(renderPrompt(config, "Work on {identifier}", ticket(1), context).text).toBe("[drovr:PQ-1] Work on PQ-1");
    const fileConfig = configSchema.parse({ prompt: { message: "Read {briefPath}" } });
    expect(renderPrompt(fileConfig, "x", ticket(1), context).text).toBe("[drovr:PQ-1] Read .drovr/PQ-1.md");
  });

  it("flags placeholders it does not know", () => {
    expect(unknownPlaceholders(DEFAULT_PROMPT)).toEqual([]);
    expect(unknownPlaceholders("{identifier} {descripton} {descripton}")).toEqual(["descripton"]);
  });

  it("lets CLI flags override the prompt config", () => {
    const { config } = loadConfig({ file: undefined, cwd: "/nonexistent", overrides: { prompt: { delivery: "inline", templateFile: "brief.md" } } });
    expect(config.prompt.delivery).toBe("inline");
    expect(config.prompt.templateFile).toBe("/nonexistent/brief.md");
  });
});

describe("checkPrompt", () => {
  const check = (prompt: Record<string, unknown>) => checkPrompt(configSchema.parse({ prompt }));

  it("rejects a template path put into prompt.message", () => {
    const result = check({ message: "/Users/me/.config/drovr/brief.md" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/set prompt.templateFile instead/);
  });

  it("rejects a file-delivery message that never mentions the brief", () => {
    expect(check({ message: "Work on {identifier}" }).ok).toBe(false);
    expect(check({ message: "Work on {identifier}", delivery: "inline" }).ok).toBe(true);
  });

  it("accepts the defaults", () => {
    expect(check({}).ok).toBe(true);
  });
});

describe("names", () => {
  it("labels Herdr workspaces and agents with a shortened title", () => {
    const vars = ticketVars(ticket(7859, { title: "Show price and CTA in the standalone mobile person picker" }));
    const config = configSchema.parse({});
    expect(render(config.terminal.workspaceLabel, vars)).toBe("PQ-7859 Show price and CTA in the standalone mobile…");
    expect(safeName(render(config.agent.name, vars))).toBe("pq-7859-show-price-and-cta-in");
  });

  it("keeps short titles intact and cuts long words without a dangling separator", () => {
    expect(truncateWords("Fix login", 48)).toBe("Fix login");
    expect(truncateWords("Fix the login, and more stuff here", 16)).toBe("Fix the login…");
    expect(truncateWords("x".repeat(60), 20)).toBe(`${"x".repeat(19)}…`);
  });
});
