import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectRepository, repoSlugFromUrl, workflowNameFor } from "../src/config/detect.js";
import { ConfigError, loadConfig } from "../src/config/load.js";
import { gitRepo } from "./fakes.js";

const GIT_IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

// Keep a real per-user config out of these tests.
beforeEach(() => void vi.stubEnv("XDG_CONFIG_HOME", mkdtempSync(join(tmpdir(), "drovr-xdg-"))));

describe("repository detection", () => {
  it("parses owner/name from ssh, scp-like, and https remotes", () => {
    expect(repoSlugFromUrl("git@github.com:yss14/drovr.git")).toBe("yss14/drovr");
    expect(repoSlugFromUrl("https://github.com/yss14/drovr")).toBe("yss14/drovr");
    expect(repoSlugFromUrl("ssh://git@gitlab.example.com:2222/team/app.git")).toBe("team/app");
    expect(repoSlugFromUrl("not a url")).toBeUndefined();
  });

  it("finds the main checkout from a subdirectory and names the workflow after the remote", () => {
    const repo = gitRepo();
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    expect(detectRepository(join(repo, "src", "deep"))).toBe(repo);
    expect(workflowNameFor(repo)).toBe("acme-web-app");
    expect(detectRepository(tmpdir())).toBeUndefined();
  });

  it("finds the checkout of a submodule, also from its linked worktree", () => {
    const inner = gitRepo();
    execFileSync("git", ["-C", inner, "commit", "-q", "--allow-empty", "-m", "init"], { stdio: "ignore", env: { ...process.env, ...GIT_IDENTITY } });
    const outer = gitRepo();
    execFileSync("git", ["-C", outer, "-c", "protocol.file.allow=always", "submodule", "-q", "add", inner, "lib"], { stdio: "ignore" });
    expect(detectRepository(join(outer, "lib"))).toBe(join(outer, "lib"));
    const linked = join(outer, "lib-wt");
    execFileSync("git", ["-C", join(outer, "lib"), "worktree", "add", "-q", linked], { stdio: "ignore" });
    expect(detectRepository(linked)).toBe(join(outer, "lib"));
  });

  it("finds a checkout with a separate git directory, but not a bare repository", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "drovr-sep-")));
    execFileSync("git", ["init", "-q", "--separate-git-dir", join(dir, "meta.git"), join(dir, "work")], { stdio: "ignore" });
    expect(detectRepository(join(dir, "work"))).toBe(join(dir, "work"));
    execFileSync("git", ["init", "-q", "--bare", join(dir, "bare.git")], { stdio: "ignore" });
    expect(detectRepository(join(dir, "bare.git"))).toBeUndefined();
  });

  it("falls back to the directory name without a remote", () => {
    const repo = gitRepo();
    execFileSync("git", ["-C", repo, "remote", "remove", "origin"]);
    expect(workflowNameFor(repo)).toMatch(/^drovr-repo-/);
  });
});

describe("config inside a repository", () => {
  it("uses the current repository and derives the workflow when neither is configured", () => {
    const repo = gitRepo();
    const loaded = loadConfig({ cwd: repo });
    expect(loaded.config.repositories.map((r) => r.path)).toEqual([repo]);
    expect(loaded.config.workflow).toBe("acme-web-app");
    expect(loaded.detected).toEqual({ repository: repo, workflow: "acme-web-app" });
  });

  it("finds drovr.config.json at the repository root from a subdirectory", () => {
    const repo = gitRepo();
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    writeFileSync(join(repo, "drovr.config.json"), JSON.stringify({ maxConcurrent: 3 }));
    const loaded = loadConfig({ cwd: join(repo, "packages", "api") });
    expect(loaded.file).toBe(join(repo, "drovr.config.json"));
    expect(loaded.config.maxConcurrent).toBe(3);
  });

  it("keeps configured repositories and workflow", () => {
    const repo = gitRepo();
    const other = gitRepo("https://github.com/acme/other.git");
    writeFileSync(join(repo, "drovr.config.json"), JSON.stringify({ repositories: [{ path: other }] }));
    const derived = loadConfig({ cwd: repo });
    expect(derived.config.repositories.map((r) => r.path)).toEqual([other]);
    expect(derived.config.workflow).toBe("acme-other");
    expect(derived.detected).toEqual({ workflow: "acme-other" });

    writeFileSync(join(repo, "drovr.config.json"), JSON.stringify({ workflow: "mine" }));
    expect(loadConfig({ cwd: repo }).config.workflow).toBe("mine");
  });

  it("reports malformed repositories instead of replacing them with the current repository", () => {
    const repo = gitRepo();
    writeFileSync(join(repo, "drovr.config.json"), JSON.stringify({ repositories: { path: "/another/repo" } }));
    expect(() => loadConfig({ cwd: repo })).toThrow(ConfigError);
    expect(() => loadConfig({ cwd: repo })).toThrow(/repositories/);
  });

  it("detects nothing when asked not to or outside a repository", () => {
    const repo = gitRepo();
    expect(loadConfig({ cwd: repo, detect: false }).config).toMatchObject({ workflow: "default", repositories: [] });
    const outside = mkdtempSync(join(tmpdir(), "drovr-plain-"));
    expect(loadConfig({ cwd: outside, file: undefined }).detected).toEqual({});
  });
});
