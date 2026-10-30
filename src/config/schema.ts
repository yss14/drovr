import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

export const repositorySchema = z.object({
  /** Display name; defaults to the directory name. */
  name: nonEmpty.optional(),
  /**
   * How worktrees are created: "git", "worktrunk" (runs the repo's wt pre-start hooks and waits for
   * them), or "auto" (worktrunk when the repo has .config/wt.toml, else git).
   */
  vcs: nonEmpty.default("auto"),
  /** Absolute or ~-relative path to the main checkout. */
  path: nonEmpty,
  /** Branch new worktrees start from. Default: the remote's default branch (origin/HEAD). */
  baseBranch: nonEmpty.optional(),
  remote: nonEmpty.default("origin"),
  /** Fetch the base branch before creating a worktree. */
  fetch: z.boolean().default(true),
  /** Worktree location template. Variables: {repo}, {branchSlug}, {identifier}, {identifierLower}. */
  worktreePath: nonEmpty.default("{repo}/.worktrees/{branchSlug}"),
  /** Branch name template. {ticketBranch} is the tracker's suggested branch name when available. */
  branch: nonEmpty.default("{ticketBranch}"),
  /** Fallback branch template when the tracker suggests no branch name. */
  fallbackBranch: nonEmpty.default("drovr/{identifierLower}-{titleSlug}"),
  /** Shell commands run inside a fresh worktree before the agent starts (e.g. "pnpm install"). */
  setup: z.array(nonEmpty).default([]),
  /** Route tickets carrying any of these labels to this repository. Empty = catch-all. */
  routeLabels: z.array(nonEmpty).default([]),
});

export const configSchema = z.object({
  /** Names the dispatch scope. Records and the first-run baseline are kept per workflow. */
  workflow: nonEmpty.default("default"),
  pollIntervalSeconds: z.number().int().min(10).default(60),
  /** How often to check agent and workspace state between polls. */
  monitorIntervalSeconds: z.number().int().min(2).default(10),
  /** Maximum number of active (launching, running, or needs-attention) dispatches. */
  maxConcurrent: z.number().int().min(1).default(1),
  /**
   * What the first poll of a workflow does with tickets that already match:
   * "baseline" records them as seen without launching; "dispatch" launches them.
   */
  firstRun: z.enum(["baseline", "dispatch"]).default("dispatch"),
  dryRun: z.boolean().default(false),
  /** SQLite database path. */
  database: nonEmpty.default("~/.local/state/drovr/drovr.db"),
  /** Extra plugin modules to load (paths or package names). */
  plugins: z.array(nonEmpty).default([]),

  tickets: z
    .object({
      provider: nonEmpty.default("linear"),
      team: nonEmpty.optional(),
      labels: z.array(nonEmpty).default(["agent-ready"]),
      excludeLabels: z.array(nonEmpty).default([]),
      states: z.array(nonEmpty).default(["Todo"]),
      assignee: nonEmpty.default("any"),
      project: nonEmpty.optional(),
      /**
       * Workflow state (name or type) a ticket is moved to once its agent has acknowledged the
       * ticket. Only tickets not yet started (triage, backlog, unstarted) are moved. null disables it.
       * GitHub issues have no workflow states, so the github provider adds this as a label instead.
       */
      startedState: nonEmpty.nullable().default("In Progress"),
      /**
       * Provider-specific options, e.g. { "workspace": "<linear workspace slug>" } for linear or
       * { "repo": "OWNER/REPO" } for github.
       */
      options: z.record(z.string(), z.unknown()).default({}),
    })
    .prefault({}),

  completion: z
    .object({
      /** A dispatch completes when its ticket reaches one of these state types... */
      stateTypes: z.array(nonEmpty).default(["completed", "canceled"]),
      /** ...or one of these state names (e.g. "In Review"). */
      states: z.array(nonEmpty).default([]),
      /** Treat closing the ticket's terminal workspace as completion. */
      whenWorkspaceClosed: z.boolean().default(true),
      /**
       * Release the slot once the agent finishes its first run: after the prompt was acknowledged,
       * the agent is idle/done on two consecutive monitor checks. The ticket itself may still need work.
       */
      whenAgentFinished: z.boolean().default(true),
    })
    .prefault({}),

  repositories: z.array(repositorySchema).default([]),

  terminal: z
    .object({
      provider: nonEmpty.default("herdr"),
      /** Named Herdr session that receives workspaces. Required. */
      session: nonEmpty.optional(),
      focus: z.boolean().default(false),
      /** Workspace label template. */
      workspaceLabel: nonEmpty.default("{identifier} {titleShort}"),
      options: z.record(z.string(), z.unknown()).default({}),
    })
    .prefault({}),

  agent: z
    .object({
      provider: nonEmpty.default("codex"),
      /** Extra arguments passed to the agent executable. */
      args: z.array(z.string()).default([]),
      /**
       * Environment variables set in the agent's Herdr workspace, e.g. { "CLAUDE_CONFIG_DIR": "~/.claude-team" }.
       * A leading ~ expands to the home directory. DROVR_TICKET and DROVR_WORKFLOW cannot be overridden.
       */
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid environment variable name"), z.string()).default({}),
      /** Agent name template (must be unique within the Herdr session). */
      name: nonEmpty.default("{identifierLower}-{titleSlugShort}"),
      /** How long to wait for the agent to become interactive before flagging it. */
      startTimeoutSeconds: z.number().int().min(5).max(300).default(90),
    })
    .prefault({}),

  prompt: z
    .object({
      /**
       * "file": write the brief into the worktree and send a one-line message pointing at it.
       * "inline": send the brief itself. Multi-line text arrives as a paste, which Claude Code
       * may decline to act on without confirmation.
       */
      delivery: z.enum(["file", "inline"]).default("file"),
      /** Brief template. Overrides the built-in default. */
      template: z.string().optional(),
      /** Path to a brief template file. Overrides `template`. */
      templateFile: nonEmpty.optional(),
      /** Brief location inside the worktree (file delivery). Excluded from git via info/exclude. */
      briefPath: nonEmpty.default(".drovr/{identifier}.md"),
      /** One-line message sent with file delivery. Newlines are collapsed to spaces. */
      message: nonEmpty.default(
        "{marker} You are assigned ticket {identifier}: {title}. Read the brief in {briefPath} (ticket description and instructions) and work on the ticket as it describes.",
      ),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type ConfigInput = z.input<typeof configSchema>;
