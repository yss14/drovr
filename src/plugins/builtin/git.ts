import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execOk, which } from "../../core/exec.js";
import type { AvailabilityResult, ProviderContext, VcsProvider, WorktreeInfo } from "../types.js";

export function createGitProvider(ctx: ProviderContext): VcsProvider {
  const git = (repoPath: string, args: string[], timeoutMs = 120_000) => execOk(ctx.exec, "git", ["-C", repoPath, ...args], { timeoutMs });

  return {
    kind: "vcs",
    id: "git",

    async checkAvailability(): Promise<AvailabilityResult> {
      if (!(await which(ctx.exec, "git"))) return { ok: false, detail: "git not found on PATH" };
      const version = await ctx.exec("git", ["--version"]);
      return { ok: version.code === 0, detail: version.stdout.trim() };
    },

    async checkRepository(repoPath) {
      const result = await ctx.exec("git", ["-C", repoPath, "rev-parse", "--show-toplevel"]);
      if (result.code !== 0) return { ok: false, detail: `${repoPath} is not a git repository` };
      return { ok: true, detail: result.stdout.trim() };
    },

    async defaultBranch(repoPath, remote) {
      const result = await ctx.exec("git", ["-C", repoPath, "symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
      const ref = result.stdout.trim();
      if (result.code !== 0 || !ref.startsWith(`${remote}/`)) {
        throw new Error(`Cannot determine ${remote}'s default branch in ${repoPath}; set repositories[].baseBranch (or run \`git remote set-head ${remote} --auto\`)`);
      }
      return ref.slice(remote.length + 1);
    },

    async listWorktrees(repoPath): Promise<WorktreeInfo[]> {
      const { stdout } = await git(repoPath, ["worktree", "list", "--porcelain"]);
      const worktrees: WorktreeInfo[] = [];
      for (const block of stdout.split("\n\n")) {
        const path = block.match(/^worktree (.+)$/m)?.[1];
        if (!path) continue;
        const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
        worktrees.push({ path, branch });
      }
      return worktrees;
    },

    async branchExists(repoPath, branch) {
      const result = await ctx.exec("git", ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return result.code === 0;
    },

    async fetch(repoPath, remote, branch) {
      await git(repoPath, ["fetch", remote, branch], 300_000);
    },

    async excludeLocally(repoPath, pattern) {
      // info/exclude lives in the common git dir and applies to every worktree of the repo.
      const { stdout } = await git(repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const file = resolve(stdout.trim(), "info", "exclude");
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (current.split("\n").includes(pattern)) return;
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}# added by drovr\n${pattern}\n`);
    },

    async addWorktree({ repoPath, path, branch, base, createBranch }) {
      const args = createBranch ? ["worktree", "add", "-b", branch, path, base] : ["worktree", "add", path, branch];
      await git(repoPath, args, 300_000);
      return { path, ranSetupHooks: false };
    },
  };
}
