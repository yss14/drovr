import { describeFailure, type ExecResult, which } from "../../core/exec.js";
import { type ProviderContext, UserActionRequired, type VcsProvider } from "../types.js";

/** Long-running pre-start hooks (installs, builds) get the same budget as drovr's own setup commands. */
const HOOK_TIMEOUT_MS = 30 * 60_000;

/**
 * Creates worktrees with worktrunk (`wt`), so the repository's worktrunk hooks run. `wt switch`
 * blocks until pre-start hooks finish, so the agent only starts on a fully set-up worktree.
 * post-start hooks run in the background as usual. Everything else is plain git.
 */
export function createWorktrunkProvider(ctx: ProviderContext, git: VcsProvider): VcsProvider {
  const wt = (args: string[]) => ctx.exec("wt", args, { timeoutMs: HOOK_TIMEOUT_MS, env: { NO_COLOR: "1", CLICOLOR_FORCE: "0" } });

  function fail(action: string, result: ExecResult, where: string): never {
    const output = result.stderr + result.stdout;
    if (/Cannot prompt for approval/i.test(output)) {
      throw new UserActionRequired(
        `worktrunk hooks in ${where} need your approval, and drovr does not approve them for you. ` +
          `Run \`wt config approvals add\` in that repository (or create one worktree there with \`wt switch --create\` interactively)`,
      );
    }
    throw new Error(`${action} failed: ${describeFailure(result)}`);
  }

  return {
    ...git,
    kind: "vcs",
    id: "worktrunk",

    async checkAvailability() {
      if (!(await which(ctx.exec, "wt"))) return { ok: false, detail: "wt (worktrunk) not found on PATH" };
      const version = await ctx.exec("wt", ["--version"]);
      return { ok: version.code === 0, detail: version.stdout.trim() };
    },

    async checkRepository(repoPath) {
      const base = await git.checkRepository(repoPath);
      if (!base.ok) return base;
      // Unapproved project hooks make every non-interactive `wt switch` fail, so catch it up front.
      const result = await ctx.exec("wt", ["-C", repoPath, "config", "approvals", "list"], { env: { NO_COLOR: "1" } });
      const text = (result.stdout + result.stderr).replace(/\x1b\[[0-9;]*m/g, "");
      const unapproved = text.split(/^UNAPPROVED\s*$/m)[1];
      if (result.code !== 0 || unapproved === undefined) {
        return { ...base, warnings: ["could not read worktrunk hook approvals (`wt config approvals list`)"] };
      }
      const pending = [...unapproved.matchAll(/^\S+\s+(\S+ \S+?):/gm)].map((m) => m[1]);
      if (pending.length > 0) {
        return { ok: false, detail: `worktrunk hooks not approved yet (${pending.join(", ")}); run \`wt config approvals add\` in ${repoPath}` };
      }
      const approved = [...(text.split(/^UNAPPROVED\s*$/m)[0] ?? "").matchAll(/^\S+\s+(pre-start \S+?):/gm)].map((m) => m[1]);
      return { ...base, detail: `${base.detail}; worktrunk ${approved.length > 0 ? `hooks approved: ${approved.join(", ")}` : "has no pre-start hooks"}` };
    },

    async addWorktree({ repoPath, path, branch, base, createBranch }) {
      const target = createBranch ? ["--create", branch, "--base", base] : [branch];
      // Pin the path so drovr can find the worktree again after an interruption.
      const args = ["-C", repoPath, "switch", ...target, "--no-cd", "--format", "json", "--config-set", `worktree-path = ${JSON.stringify(path)}`];
      const result = await wt(args);
      if (result.code !== 0) fail("wt switch", result, repoPath);
      const line = result.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      let actual = path;
      try {
        if (line) actual = String((JSON.parse(line) as { path?: string }).path ?? path);
      } catch {}
      return { path: actual, ranSetupHooks: true };
    },

    async runSetupHooks(worktreePath) {
      const result = await wt(["-C", worktreePath, "hook", "pre-start", "--foreground"]);
      if (result.code !== 0) fail("wt hook pre-start", result, worktreePath);
    },
  };
}
