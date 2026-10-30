import { execFileSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Main checkout of the git repository containing `cwd`, or undefined outside a repository or in a
 * bare one. From inside a linked worktree this is the main checkout, not the worktree.
 */
export function detectRepository(cwd: string): string | undefined {
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!commonDir) return undefined;
  if (basename(commonDir) === ".git") return dirname(commonDir);
  // Submodules keep their metadata in the superproject's .git/modules/<name> and record the
  // checkout in core.worktree, relative to that directory.
  const worktree = git(cwd, ["config", "--file", join(commonDir, "config"), "core.worktree"]);
  if (worktree) return resolve(commonDir, worktree);
  // A separate git directory (`git init --separate-git-dir`); fails in a bare repository.
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

/** "owner/name" from a remote URL (scp-like, ssh, or https), or undefined. */
export function repoSlugFromUrl(url: string): string | undefined {
  const path = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match = path.match(/[:/]([^/:]+)\/([^/:]+)$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/**
 * Workflow name for a repository: "owner-name" from its remote, else the directory name. Each
 * repository then keeps its own dispatch records and watcher lease.
 */
export function workflowNameFor(repoPath: string, remote = "origin"): string {
  const url = git(repoPath, ["remote", "get-url", remote]);
  const name = (url && repoSlugFromUrl(url)) ?? basename(repoPath);
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}
