import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Config, RepositoryConfig } from "../config/schema.js";
import { claudeSpec, codexSpec, createCliAgent } from "./builtin/agents.js";
import { createGitProvider } from "./builtin/git.js";
import { createGithubProvider } from "./builtin/github.js";
import { createHerdrProvider } from "./builtin/herdr.js";
import { createLinearProvider } from "./builtin/linear.js";
import { createWorktrunkProvider } from "./builtin/worktrunk.js";
import type { AgentProvider, ProviderContext, ProviderKind, TerminalProvider, TicketSource, VcsProvider } from "./types.js";

interface KindMap {
  tickets: TicketSource;
  terminal: TerminalProvider;
  agent: AgentProvider;
  vcs: VcsProvider;
}

export interface PluginDefinition<K extends ProviderKind = ProviderKind> {
  kind: K;
  id: string;
  description: string;
  create(ctx: ProviderContext, options: Record<string, unknown>): KindMap[K];
}

/**
 * A plugin module's default export: either a function receiving the registry, or an object
 * with a `register` method. It registers one or more provider definitions.
 */
export type PluginModule = ((registry: PluginRegistry) => void) | { register(registry: PluginRegistry): void };

export class PluginRegistry {
  private readonly definitions = new Map<string, PluginDefinition>();

  register<K extends ProviderKind>(definition: PluginDefinition<K>): void {
    this.definitions.set(`${definition.kind}:${definition.id}`, definition as unknown as PluginDefinition);
  }

  get<K extends ProviderKind>(kind: K, id: string): PluginDefinition<K> {
    const definition = this.definitions.get(`${kind}:${id}`);
    if (!definition) {
      const known = this.list(kind).map((d) => d.id).join(", ");
      throw new Error(`Unknown ${kind} provider "${id}" (available: ${known || "none"})`);
    }
    return definition as unknown as PluginDefinition<K>;
  }

  list(kind?: ProviderKind): PluginDefinition[] {
    return [...this.definitions.values()].filter((d) => !kind || d.kind === kind);
  }

  async load(specifier: string): Promise<void> {
    const url = /^[./]/.test(specifier) ? pathToFileURL(specifier).href : specifier;
    const mod = (await import(url)) as { default?: PluginModule };
    const plugin = mod.default;
    if (typeof plugin === "function") plugin(this);
    else if (plugin && typeof plugin.register === "function") plugin.register(this);
    else throw new Error(`Plugin ${specifier} has no default export (function or { register })`);
  }
}

export function builtinRegistry(): PluginRegistry {
  const registry = new PluginRegistry();
  registry.register({
    kind: "tickets",
    id: "linear",
    description: "Linear via the linear CLI",
    create: (ctx, options) => createLinearProvider(ctx, { workspace: options.workspace as string | undefined, binary: options.binary as string | undefined }),
  });
  registry.register({
    kind: "tickets",
    id: "github",
    description: "GitHub issues via the gh CLI",
    create: (ctx, options) =>
      createGithubProvider(ctx, { repo: options.repo as string | undefined, cwd: options.cwd as string | undefined, binary: options.binary as string | undefined }),
  });
  registry.register({
    kind: "terminal",
    id: "herdr",
    description: "Herdr terminal workspaces",
    create: (ctx, options) => createHerdrProvider(ctx, { session: String(options.session), binary: options.binary as string | undefined }),
  });
  registry.register({ kind: "agent", id: "codex", description: "OpenAI Codex CLI", create: (ctx) => createCliAgent(ctx, codexSpec) });
  registry.register({ kind: "agent", id: "claude", description: "Claude Code", create: (ctx) => createCliAgent(ctx, claudeSpec) });
  registry.register({ kind: "vcs", id: "git", description: "git worktrees", create: (ctx) => createGitProvider(ctx) });
  registry.register({
    kind: "vcs",
    id: "worktrunk",
    description: "worktrees via worktrunk (wt), waiting for its pre-start hooks",
    create: (ctx) => createWorktrunkProvider(ctx, createGitProvider(ctx)),
  });
  return registry;
}

export interface Providers {
  tickets: TicketSource;
  terminal: TerminalProvider;
  agent: AgentProvider;
  /** The worktree provider for a repository (repositories[].vcs, with "auto" resolved). */
  vcsFor(repo: RepositoryConfig): VcsProvider;
}

/** "auto" picks worktrunk for repositories that carry a worktrunk project config. */
export function resolveVcsId(repo: RepositoryConfig): string {
  if (repo.vcs !== "auto") return repo.vcs;
  return existsSync(join(repo.path, ".config", "wt.toml")) ? "worktrunk" : "git";
}

export async function resolveProviders(config: Config, ctx: ProviderContext, registry = builtinRegistry()): Promise<Providers> {
  for (const plugin of config.plugins) await registry.load(plugin);
  const vcs = new Map<string, VcsProvider>();
  return {
    // cwd lets a source find its project from the repository (gh resolves the GitHub repository from it).
    tickets: registry.get("tickets", config.tickets.provider).create(ctx, { cwd: config.repositories[0]?.path, ...config.tickets.options }),
    terminal: registry.get("terminal", config.terminal.provider).create(ctx, { ...config.terminal.options, session: config.terminal.session }),
    agent: registry.get("agent", config.agent.provider).create(ctx, {}),
    vcsFor(repo) {
      const id = resolveVcsId(repo);
      let provider = vcs.get(id);
      if (!provider) {
        provider = registry.get("vcs", id).create(ctx, {});
        vcs.set(id, provider);
      }
      return provider;
    },
  };
}
