# drovr

CLI that picks up tickets and puts your Herdr agents to work.

drovr watches Linear for tickets that match your criteria. For each newly eligible ticket it creates a git worktree, opens a workspace in your running [Herdr](https://github.com/herdrdev/herdr) session, starts an interactive Codex or Claude Code agent there, and hands it the ticket. Each ticket gets its own workspace. You can watch progress, answer questions, approve actions, interrupt, and give follow-up instructions as usual. drovr only automates the pickup.

```
Linear ──poll──▶ eligible? ──▶ already dispatched? ──▶ slot free? ──▶ worktree ─▶ setup ─▶ Herdr workspace ─▶ agent ─▶ prompt
                    │                  │                    │
                  skip (why)         skip (state)         queue
```

## Requirements

- Node.js ≥ 22 (drovr uses `better-sqlite3`, a native module; npm downloads a prebuilt binary for common platforms and otherwise compiles it, which needs a C++ toolchain such as Xcode Command Line Tools or `build-essential`)
- `linear` ([Linear CLI](https://github.com/schpet/linear-cli), authenticated: `linear auth login`)
- `herdr` ([Herdr](https://github.com/herdrdev/herdr), [herdr.dev](https://herdr.dev)) with a **running** named session (verified against 0.7.5)
- `codex` and/or `claude`
- `git`
- `wt` ([worktrunk](https://worktrunk.dev)), for repositories that use worktrunk hooks

`drovr check` verifies all of this.

## Quick start

```sh
npm install --global drovr     # or: pnpm add --global drovr

drovr init                     # writes ./drovr.config.json; edit it
drovr check                    # providers, auth, Herdr session, repo, team, labels
drovr run --dry-run --once     # what would launch, without doing anything
drovr run                      # watch
```

While `drovr run` is running in a terminal: **space** pause/resume · **p** poll now · **r** reload config · **s** status · **q** / Ctrl-C quit. Pausing stops polling and launching. A launch already in progress finishes first.

**r** re-reads the config file and prompt template (command-line flags still win), runs the checks again, and swaps in the new config, then polls right away. A launch already in progress finishes with the old config first. If the file is invalid or a check fails, drovr keeps the current config and logs why. `workflow`, `database`, and `dryRun` cannot change while running, and plugin modules are not re-imported, so changes to those need a restart.

## Configuration

drovr resolves its configuration in three layers. Later layers win:

1. built-in defaults (below)
2. the config file: `--config <path>`, else `$DROVR_CONFIG`, else `./drovr.config.json`, else `~/.config/drovr/config.json`
3. command-line flags

Objects merge key by key. Arrays (labels, states, repositories, agent args) are **replaced**, not appended. Relative paths in the file resolve against the file's directory, and `~` expands everywhere. `drovr config` prints the resolved result. See [`drovr.config.example.json`](drovr.config.example.json).

### Reference

| Key | Default | Flag | Description |
| --- | --- | --- | --- |
| `workflow` | `"default"` | `--workflow` | Names the dispatch scope. Records and the first-run baseline are kept per workflow, so different criteria can run as separate workflows. |
| `pollIntervalSeconds` | `60` | `--interval` | Linear poll interval (min 10). |
| `monitorIntervalSeconds` | `10` | | How often agent and workspace state is checked between polls. |
| `maxConcurrent` | `1` | `--max-concurrent` | Maximum active dispatches (launching, running, or needs-attention) started by drovr. |
| `firstRun` | `"dispatch"` | `--first-run` | What the first poll of a workflow does with tickets that already match. See [First run](#first-run). |
| `dryRun` | `false` | `--dry-run` | Show what would happen; launch and record nothing. |
| `database` | `~/.local/state/drovr/drovr.db` | `--db` | SQLite state. |
| `plugins` | `[]` | | Extra plugin modules. See [Plugins](#plugins). |
| `tickets.provider` | `"linear"` | | Ticket source plugin. |
| `tickets.team` | CLI default team | `--team` | Team key, name, or ID. |
| `tickets.labels` | `["agent-ready"]` | `--label` (repeatable) | The ticket must have **all** of these. |
| `tickets.excludeLabels` | `[]` | `--exclude-label` (repeatable) | The ticket must have **none** of these. |
| `tickets.states` | `["Todo"]` | `--state` (repeatable) | State names or types (`triage`, `backlog`, `unstarted`, `started`, …). Matches **any** of them. Empty means any state. |
| `tickets.assignee` | `"any"` | `--assignee` | `any`, `none` (unassigned), `@me`, or a user. |
| `tickets.project` | | `--project` | Project ID, slug, or name. |
| `tickets.startedState` | `"In Progress"` | `--started-state` (`none` disables) | State (name or type) a ticket is moved to once its agent has acknowledged the ticket. See [Moving the ticket](#moving-the-ticket). `null` disables it. |
| `tickets.options.workspace` | | | Linear workspace slug (for multiple Linear logins). |
| `completion.stateTypes` | `["completed", "canceled"]` | | A dispatch completes when its ticket reaches one of these state types… |
| `completion.states` | `[]` | | …or one of these state names (e.g. `"Review"`). |
| `completion.whenWorkspaceClosed` | `true` | | …or when you close its Herdr workspace. |
| `completion.whenAgentFinished` | `true` | | Free the slot once the agent finishes its first run on the ticket. See [Slots](#slots-finished-vs-completed). |
| `repositories[].path` | — | `--repo` | Main checkout. `--repo` replaces the list with a single repository. |
| `repositories[].vcs` | `"auto"` | | How worktrees are created: `worktrunk`, `git`, or `auto`, which picks worktrunk when the repo has `.config/wt.toml`. See [Worktree setup](#worktree-setup). |
| `repositories[].baseBranch` | remote default branch | `--base-branch` | Branch new worktrees start from. Without it, drovr uses `origin/HEAD`. |
| `repositories[].remote` | `"origin"` | | |
| `repositories[].fetch` | `true` | | Fetch the base branch first, then branch from `<remote>/<base>`. |
| `repositories[].branch` | `"{ticketBranch}"` | | Branch name template. `{ticketBranch}` is Linear's suggested branch name. |
| `repositories[].fallbackBranch` | `"drovr/{identifierLower}-{titleSlug}"` | | Used when the ticket has no suggested branch name. |
| `repositories[].worktreePath` | `"{repo}/.worktrees/{branchSlug}"` | | Worktree location template. |
| `repositories[].setup` | `[]` | | Extra shell commands run in a new worktree before the agent starts, after any worktrunk hooks. They should be safe to re-run. |
| `repositories[].routeLabels` | `[]` | | With several repositories, the first one whose route labels intersect the ticket's labels is used. Otherwise the single repository without route labels is used. |
| `terminal.provider` | `"herdr"` | | Terminal plugin. |
| `terminal.session` | — (required) | `--session` | Named Herdr session that receives the workspaces. |
| `terminal.focus` | `false` | `--focus` / `--no-focus` | Focus new workspaces. |
| `terminal.workspaceLabel` | `"{identifier} {titleShort}"` | | Workspace label template, e.g. "PQ-7859 Show price and CTA in the standalone mobile…". |
| `agent.provider` | `"codex"` | `--agent` | `codex`, `claude`, or a plugin. |
| `agent.args` | `[]` | `--agent-arg` (repeatable) | Extra arguments for the agent executable. |
| `agent.env` | `{}` | | Environment variables set in the agent's Herdr workspace, e.g. `{ "CLAUDE_CONFIG_DIR": "~/.claude-team" }` to run Claude Code against another account's config. A leading `~` expands. `DROVR_TICKET` and `DROVR_WORKFLOW` always win. |
| `agent.name` | `"{identifierLower}-{titleSlugShort}"` | | Herdr agent name template, e.g. `pq-7859-show-price-and-cta-in`. Must be unique in the session. |
| `agent.startTimeoutSeconds` | `90` | | How long to wait for the agent to become interactive. |
| `prompt.delivery` | `"file"` | `--prompt-delivery` | `file` or `inline`. See [Prompt delivery](#prompt-delivery). |
| `prompt.templateFile` | | `--prompt-file` | Ticket brief template file. Takes precedence over `prompt.template`. See [Customising the prompt](#customising-the-prompt). |
| `prompt.template` | built-in | | Ticket brief template, inline. |
| `prompt.briefPath` | `".drovr/{identifier}.md"` | | Brief location inside the worktree (file delivery). |
| `prompt.message` | `"{marker} You are assigned Linear ticket {identifier}: {title}. Read the brief in {briefPath} …"` | `--prompt-message` | The one-line text typed to the agent with file delivery. It must contain `{briefPath}`; it is not a file path (use `prompt.templateFile` for that). Newlines are collapsed to spaces. |

Name and path templates use `{identifier}`, `{identifierLower}`, `{title}`, `{titleShort}`, `{titleSlug}`, `{titleSlugShort}`, `{url}`, `{ticketBranch}`, `{state}`, and `{team}`. Paths can also use `{repo}` and `{branchSlug}`. Prompt variables are listed under [Customising the prompt](#customising-the-prompt).

## How it behaves

### Eligibility

On every poll, drovr runs `linear issue list --json --limit all` with the team, state, label, assignee, and project filters. `--limit all` follows pagination. drovr then re-checks each ticket locally (labels, excluded labels, state name or type, assignee). That local check is authoritative and produces the reasons drovr logs. Run with `-v` to also see skipped tickets and why they were skipped.

A ticket is **newly eligible** if it matches and has no dispatch record in the workflow. An old ticket that gets the label or state later becomes eligible on the next poll. Eligible tickets launch in priority order (urgent first), then oldest first.

### First run

The first poll of a workflow decides what happens to tickets that **already** match:

- `dispatch` (default): they launch like any newly eligible ticket, highest priority first and one slot at a time under `maxConcurrent`.
- `baseline`: they are recorded as seen and not launched. Only tickets that start matching afterwards launch. If a baselined ticket stops matching and matches again later, it launches then. `drovr retry <ticket>` launches one on the next poll.

`drovr run --dry-run` shows which of the two would happen.

### Dispatch states

| State | Meaning | Uses a slot |
| --- | --- | --- |
| `baseline` | Matched on the first poll; never launched. | no |
| `launching` | The launch pipeline is running (`step`: worktree → setup → workspace → agent → prompt). | yes |
| `running` | The agent acknowledged the prompt. | yes |
| `needs_attention` | Waiting on you: a startup dialog, a name or branch conflict, or a prompt that could not be confirmed. The reason is logged and shown in `drovr history`. | yes |
| `failed` | A step failed. Nothing retries it until `drovr retry`. | no |
| `retry` | You asked to resume it. It is picked up before new tickets once a slot is free. | no |
| `finished` | The agent finished its first run. The workspace stays open for review and follow-ups. | no |
| `completed` | The ticket reached a completion state, its workspace was closed, or you ran `drovr done`. | no |

Records are keyed by Linear's stable issue ID within the workflow, so a ticket is never dispatched twice. Each record stores the identifier, repo, branch, worktree path, Herdr workspace and pane, agent name and kind, last agent status, timestamps, attempts, and an event log.

### Slots: finished vs. completed

Herdr reports agent activity: `working`, `blocked`, `idle`, `done`, `unknown`. drovr logs each change. For example, `blocked` is logged as "waiting for you — approval or question in workspace …".

With `completion.whenAgentFinished` (the default), the slot is released when the agent finishes its **first run**. That means the prompt was acknowledged, and Herdr then reports the agent as `idle` or `done` on two consecutive monitor checks, `monitorIntervalSeconds` apart. Requiring two checks means a brief pause doesn't free the slot. `blocked` keeps the slot, because the agent is waiting on you. The dispatch moves to `finished`, the next queued ticket starts right away, and the workspace stays open for your review and follow-up instructions. An agent that stops to ask a clarifying question has also finished its run.

A finished agent run does not mean the ticket is implemented. With `whenAgentFinished: false`, a dispatch keeps its slot until the ticket reaches a `completion` state, its workspace is closed, or you run `drovr done <ticket>`. Those conditions also free the slot of a running dispatch in the default mode.

### Worktree setup

The agent starts only after the worktree is fully set up. For repositories using worktrunk (`vcs: "worktrunk"`, or `auto` with a `.config/wt.toml`), drovr creates the worktree with `wt switch --create <branch> --base <remote>/<base> --no-cd`. worktrunk runs the repository's `pre-start` hooks and blocks until they finish (for example `mise run setup`, then `pnpm build`). drovr waits for that before it opens the Herdr workspace. drovr pins the path to `repositories[].worktreePath`, so keep that consistent with your worktrunk `worktree-path`. The default `{repo}/.worktrees/{branchSlug}` matches `{{ repo_path }}/.worktrees/{{ branch | sanitize }}`. `post-start` hooks run in the background as worktrunk normally runs them, and drovr does not wait for them.

If a hook fails or a launch is interrupted, `drovr retry` reuses the worktree and runs `wt hook pre-start --foreground` again before starting the agent, so hooks should be safe to re-run.

**Hook approvals.** worktrunk asks you to approve project hooks, and it cannot ask without a terminal. drovr never passes `--yes`. `drovr check` lists unapproved hooks, and a launch that hits one goes to `needs_attention`. Approve them once with `wt config approvals add` in the repository, then run `drovr retry <ticket>`.

For plain git repositories, worktrees are created with `git worktree add` and only `repositories[].setup` runs.

### Startup dialogs (trust, login)

On a folder it hasn't seen before, Codex shows "Trust this folder?" and Claude Code shows "Quick safety check… Yes, I trust this folder". **Herdr 0.7.5 reports both agents as idle and interactive while these dialogs are open.** A prompt submitted at that point answers the dialog. For Codex that means trusting the folder. For Claude Code, where the default option is "No, exit", the agent quits.

After the agent starts, drovr waits briefly and reads the visible screen. If it recognises one of these dialogs (patterns per agent plugin, in `src/plugins/builtin/agents.ts`), it does **not** answer it. The dispatch goes to `needs_attention`, you answer the dialog in the Herdr workspace, and drovr notices within `monitorIntervalSeconds` and submits the ticket. The same applies when an agent does not report readiness within `agent.startTimeoutSeconds`.

### Prompt delivery

Herdr delivers multi-line text as a paste, and Claude Code may decline to act on instructions that arrive only as pasted content. So by default (`delivery: "file"`) drovr writes the ticket brief to `.drovr/<ID>.md` in the worktree and sends a single-line message telling the agent to read it. drovr adds `/.drovr` to the repository's `.git/info/exclude`, which is local and never committed. `delivery: "inline"` sends the brief directly, which works with Codex.

drovr submits with `herdr agent prompt --wait` and treats the prompt as delivered only when the agent reacts. A prompt that is swallowed leaves the dispatch in `needs_attention` instead of falsely `running`.

### Moving the ticket

Once the agent has acknowledged the ticket prompt, drovr moves the ticket to `tickets.startedState` (default "In Progress") with `linear issue update --state`. drovr only moves tickets that have not started yet (triage, backlog, or unstarted state types). A retried or adopted ticket that is already in "Review" or "Done" stays where it is. If Linear can't be reached, the launch still counts as running, and the move is retried on the next polls. `drovr check` verifies that the state exists for the team.

Moving a ticket out of `tickets.states` (e.g. out of "Todo") does not affect its dispatch. drovr tracks dispatched tickets by ID and never launches them twice.

### Customising the prompt

What the agent receives is built from two templates:

- **The brief** (`prompt.templateFile` or `prompt.template`) holds the ticket context and your instructions. With file delivery, it is written to `prompt.briefPath` in the worktree. With inline delivery, it is what gets sent.
- **The message** (`prompt.message`) is the single line sent with file delivery, pointing the agent at the brief.

Start from the built-in brief, edit it, and point drovr at it:

```sh
drovr prompt --default > ~/.config/drovr/brief.md   # the built-in brief, as a starting point
drovr prompt --variables                           # every variable and what it contains
drovr prompt PQ-1234                               # preview exactly what a launch would send
```

```json
{ "prompt": { "templateFile": "~/.config/drovr/brief.md", "message": "{marker} Pick up {identifier} ({title}) — your brief is in {briefPath}." } }
```

The same works per run with `--prompt-file`, `--prompt-message`, and `--prompt-delivery`. Variables include the ticket's `{identifier}`, `{title}`, `{url}`, `{description}`, `{labels}`, `{state}`, `{priority}`, `{project}`, and `{assignee}`. The launch context adds `{worktreePath}`, `{branch}`, `{baseBranch}`, `{repo}`, `{agent}`, and `{briefPath}`. `drovr check` fails on an unknown placeholder (e.g. a typo like `{descripton}`) rather than sending it verbatim. If the sent text lacks `{marker}`, drovr puts `[drovr:<ID>]` in front, because it uses the marker to recognise a delivered prompt after an interruption.

### Interrupted launches and overlapping watchers

- **One watcher per workflow.** `drovr run` takes a lease in SQLite and keeps it alive with a heartbeat. A second watcher for the same workflow refuses to start. A lease whose process is gone, or whose heartbeat is stale, is taken over. A watcher that loses its lease stops.
- **Atomic claims.** A ticket is claimed with an insert-if-absent before anything is created.
- **Reconciliation.** Each step records its intent before acting, and on re-run first checks whether its effect already exists. An existing worktree is reused. A workspace whose create response was lost is found by label and cwd and adopted. An agent already in the pane is adopted and renamed. A prompt whose outcome is unknown is looked up in the agent's terminal output by its `[drovr:<ID>]` marker. If the prompt can't be confirmed, drovr asks you rather than risk sending it twice (`drovr retry <ID> --resend-prompt`). On startup the watcher resumes dispatches left in `launching` before polling.

## Commands

| Command | |
| --- | --- |
| `drovr run [--dry-run] [--once] [-v] [flags]` | Watch (default command). |
| `drovr check [flags]` | Check providers: binaries, Linear auth, team and labels exist, Herdr session running, agent supported, repos valid. |
| `drovr config [flags]` | Print the resolved config. |
| `drovr init [--force]` | Write a starter `drovr.config.json`. |
| `drovr history [ticket] [-a] [--json]` | Open dispatches (`-a`: all), or one ticket's record and event log. |
| `drovr retry <ticket> [--resend-prompt]` | Resume a failed, needs-attention, baseline, or completed ticket on the next poll. |
| `drovr done <ticket>` | Mark completed and free the slot. The worktree and workspace are left alone. |
| `drovr forget <ticket>` | Delete the record so the ticket launches the next time it matches. |
| `drovr prompt <ticket> \| --default \| --variables` | Preview the prompt for a ticket, print the built-in brief, or list template variables. |
| `drovr plugins` | List providers. |

drovr never deletes worktrees, branches, or workspaces. Its only write to Linear is moving a launched ticket to `tickets.startedState`.

## Plugins

Every external system sits behind a provider interface in [`src/plugins/types.ts`](src/plugins/types.ts):

- `TicketSource`: list candidates, fetch details, optionally validate criteria (built in: `linear`)
- `TerminalProvider`: workspaces, panes, agent start, prompt, read (built in: `herdr`)
- `AgentProvider`: availability, launch spec per terminal, startup-dialog detection (built in: `codex`, `claude`)
- `VcsProvider`: worktrees and their blocking setup hooks (built in: `git`, `worktrunk`)

To add one, write an ES module whose default export registers definitions, list it in `plugins`, and select it by ID:

```js
// my-tracker.mjs
export default (registry) =>
  registry.register({
    kind: "tickets",
    id: "github",
    description: "GitHub issues via gh",
    create: (ctx, options) => ({
      kind: "tickets",
      id: "github",
      checkAvailability: async () => ({ ok: true, detail: "gh ok" }),
      describeQuery: (criteria) => `labels ${criteria.labels.join(", ")}`,
      listCandidates: async (criteria) => [/* Ticket[] */],
      getTicket: async (ref) => ({ /* Ticket */ }),
    }),
  });
```

```json
{ "plugins": ["./my-tracker.mjs"], "tickets": { "provider": "github", "options": {} } }
```

`ctx.exec` runs commands and `ctx.log` writes to drovr's output. `tickets.options` and `terminal.options` are passed to `create`.

## Development

```sh
pnpm install
pnpm dev -- run --dry-run --once   # run from source
pnpm test                          # vitest, with in-memory fake providers
pnpm typecheck
pnpm build
pnpm link --global                 # put this checkout's build on your PATH as `drovr`
```

### Releasing

1. Move the `Unreleased` entries in [`CHANGELOG.md`](CHANGELOG.md) under a new version heading.
2. `npm version <patch|minor|major>` bumps `package.json`, commits, and tags `vX.Y.Z`.
3. `npm publish`. `prepublishOnly` runs the typecheck, tests, and a clean build first.
4. `git push --follow-tags`, then create the GitHub release from the tag (`gh release create vX.Y.Z --notes-from-tag` or with the changelog section).

## Verified against

herdr 0.7.5, linear CLI 3.0.0, worktrunk 0.70.0, codex-cli 0.162.1, Claude Code 2.1.296. `drovr check` warns when the Herdr version differs. Startup-dialog patterns depend on agent wording and may need updating when agents change.
