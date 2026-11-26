# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Trust check: a ticket launches only if each label in `tickets.labels` was last applied by someone in `tickets.trustedActors`, and nobody else changed its title or description since. drovr checks again at every launch, retry, and resumed launch, on the same copy of the ticket the brief is written from. `drovr check`, dry runs, `-v` logs, and `drovr prompt` show the result. See "Who can start an agent" in the README.
- `tickets.trustedActors`: `"@me"`, GitHub logins, or Linear emails or user IDs. `"any"` turns the check off.
- Ticket-source plugins can implement the optional `provenance` reader to support the trust check.

### Changed

- **Tickets labeled by other people no longer launch by default.** `tickets.trustedActors` defaults to `["@me"]`, the user `gh` or `linear` is logged in as. If teammates, bots, issue templates, automations, or integrations apply your trigger label, add those people to `tickets.trustedActors`, or set it to `"any"` to keep the old behavior. Bots and automations cannot be trusted by name. Ticket-source plugins without `provenance` launch nothing until you set `"any"`.

## [1.0.0] - 2026-11-02

First release.

### Added

- `drovr run` watches for eligible tickets and launches one Codex or Claude Code agent per ticket in its own git worktree and Herdr workspace.
- Ticket sources: Linear, and GitHub Issues (`"tickets": { "provider": "github" }`) via the `gh` CLI. GitHub issues are watched in the repository's GitHub remote or `tickets.options.repo`, `tickets.startedState` is added as a label, and closing an issue completes its dispatch.
- Interactive `drovr init`: it offers the Linear teams, labels, and states, GitHub Issues when `gh` can read the repository, Herdr sessions, installed agents, and a setup command from the repository's lockfile. `--global` writes the per-user config, `--yes` takes every suggested answer.
- Repo-aware defaults: without configured `repositories`, drovr uses the git repository it runs in and finds `drovr.config.json` at its root. Without a configured `workflow`, the name is derived from the first repository's remote (e.g. `acme-web`), so each repository keeps its own records and watcher.
- worktrunk support: blocking `pre-start` hooks before the agent starts.
- Startup-dialog detection, prompt confirmation, and crash-safe reconciliation of interrupted launches.
- Hot config reload (`r` while running).
- `agent.env` sets environment variables in the agent's workspace.
- Commands: `run`, `check`, `config`, `init`, `history`, `retry`, `done`, `forget`, `prompt`, `plugins`.
- Plugin interface for ticket sources, terminals, agents, and VCS providers.

[Unreleased]: https://github.com/yss14/drovr/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yss14/drovr/releases/tag/v1.0.0
