# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0]

First release.

- `drovr run` watches Linear for eligible tickets and launches one Codex or Claude Code agent per ticket in its own git worktree and Herdr workspace.
- worktrunk support: blocking `pre-start` hooks before the agent starts.
- Startup-dialog detection, prompt confirmation, and crash-safe reconciliation of interrupted launches.
- Hot config reload (`r` while running).
- `agent.env` sets environment variables in the agent's workspace.
- Commands: `run`, `check`, `config`, `init`, `history`, `retry`, `done`, `forget`, `prompt`, `plugins`.
- Plugin interface for ticket sources, terminals, agents, and VCS providers.

[Unreleased]: https://github.com/yss14/drovr/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yss14/drovr/releases/tag/v1.0.0
