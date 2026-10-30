import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { detectRepository, workflowNameFor } from "./detect.js";
import { type Config, configSchema } from "./schema.js";

export interface LoadedConfig {
  config: Config;
  /** Config file that was read, if any. */
  file?: string;
  /** Values filled in from the current git repository because neither the file nor flags set them. */
  detected: { repository?: string; workflow?: string };
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/** The per-user config file, shared by every repository without its own. */
export function globalConfigPath(): string {
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "drovr", "config.json");
}

/** Candidate config locations, in priority order: cwd, the enclosing repository's root, the global file. */
export function configCandidates(cwd = process.cwd(), repo = detectRepository(cwd)): string[] {
  const candidates = [resolve(cwd, "drovr.config.json")];
  if (repo && resolve(repo) !== resolve(cwd)) candidates.push(resolve(repo, "drovr.config.json"));
  return [...candidates, globalConfigPath()];
}

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deep-merges objects; arrays and scalars from `override` replace those in `base`. Undefined is ignored. */
export function mergeConfig(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlain(value) && isPlain(out[key]) ? mergeConfig(out[key] as Plain, value) : value;
  }
  return out;
}

export function readConfigFile(path: string): Plain {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${path}: ${(error as Error).message}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlain(parsed)) throw new Error("top level must be an object");
    return parsed;
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${path}: ${(error as Error).message}`);
  }
}

/**
 * Resolves configuration: schema defaults ← config file ← CLI overrides.
 * Relative paths in the file resolve against the file's directory; CLI paths against cwd.
 * Without configured repositories, the git repository containing cwd is used, and without a
 * configured workflow, the name is derived from the first repository.
 */
export function loadConfig(opts: { file?: string; overrides?: Plain; cwd?: string; detect?: boolean } = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const repo = opts.detect === false ? undefined : detectRepository(cwd);
  const explicit = opts.file ?? process.env.DROVR_CONFIG;
  let file: string | undefined;
  if (explicit) {
    file = resolve(cwd, expandHome(explicit));
    if (!existsSync(file)) throw new ConfigError(`Config file not found: ${file}`);
  } else {
    file = configCandidates(cwd, repo).find((candidate) => existsSync(candidate));
  }

  const fromFile = file ? resolvePaths(readConfigFile(file), dirname(file)) : {};
  const fromCli = resolvePaths(opts.overrides ?? {}, cwd);
  const merged = mergeConfig(fromFile, fromCli);

  const detected: LoadedConfig["detected"] = {};
  if (opts.detect !== false) {
    // Only absent or empty repositories are inferred; anything else is left for the schema to reject.
    const noRepositories = merged.repositories === undefined || (Array.isArray(merged.repositories) && merged.repositories.length === 0);
    if (repo && noRepositories) {
      merged.repositories = [{ path: repo }];
      detected.repository = repo;
    }
    const first = Array.isArray(merged.repositories) ? merged.repositories[0] : undefined;
    if (merged.workflow === undefined && isPlain(first) && typeof first.path === "string") {
      merged.workflow = workflowNameFor(first.path, typeof first.remote === "string" ? first.remote : undefined);
      detected.workflow = merged.workflow as string;
    }
  }

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration${file ? ` (${file})` : ""}:\n${z.prettifyError(result.error)}`);
  }
  // Schema defaults bypass resolvePaths, so expand ~ once more on the final values.
  const config = result.data;
  config.database = config.database === ":memory:" ? config.database : resolveFrom(cwd, config.database);
  return { config, file, detected };
}

function resolvePaths(input: Plain, base: string): Plain {
  const out: Plain = { ...input };
  const abs = (p: unknown) => (typeof p === "string" ? resolveFrom(base, p) : p);
  if (out.database !== undefined) out.database = abs(out.database);
  if (Array.isArray(out.plugins)) {
    out.plugins = out.plugins.map((p) => (typeof p === "string" && /^[.~/]/.test(p) ? resolveFrom(base, p) : p));
  }
  if (Array.isArray(out.repositories)) {
    out.repositories = out.repositories.map((repo) =>
      isPlain(repo) && typeof repo.path === "string" ? { ...repo, path: resolveFrom(base, repo.path) } : repo,
    );
  }
  if (isPlain(out.agent) && isPlain(out.agent.env)) {
    const env = Object.entries(out.agent.env).map(([key, value]) => [key, typeof value === "string" ? expandHome(value) : value]);
    out.agent = { ...out.agent, env: Object.fromEntries(env) };
  }
  if (isPlain(out.prompt) && typeof out.prompt.templateFile === "string") {
    out.prompt = { ...out.prompt, templateFile: resolveFrom(base, out.prompt.templateFile) };
  }
  return out;
}

function resolveFrom(base: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}
