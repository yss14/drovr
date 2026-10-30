import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Main checkout of the git repository containing `cwd`, or undefined outside a repository.
 * From inside a linked worktree this is the main checkout, not the worktree.
 */
export function detectRepository(cwd: string): string | undefined {
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // A bare repository has no checkout to create worktrees from.
  if (!commonDir || basename(commonDir) !== ".git") return undefined;
  return dirname(commonDir);
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
