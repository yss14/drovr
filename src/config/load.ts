import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { type Config, configSchema } from "./schema.js";

export interface LoadedConfig {
  config: Config;
  /** Config file that was read, if any. */
  file?: string;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

/** Candidate config locations, in priority order. */
export function configCandidates(cwd = process.cwd()): string[] {
  const xdg = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
  return [resolve(cwd, "drovr.config.json"), resolve(xdg, "drovr", "config.json")];
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
 */
export function loadConfig(opts: { file?: string; overrides?: Plain; cwd?: string } = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.file ?? process.env.DROVR_CONFIG;
  let file: string | undefined;
  if (explicit) {
    file = resolve(cwd, expandHome(explicit));
    if (!existsSync(file)) throw new ConfigError(`Config file not found: ${file}`);
  } else {
    file = configCandidates(cwd).find((candidate) => existsSync(candidate));
  }

  const fromFile = file ? resolvePaths(readConfigFile(file), dirname(file)) : {};
  const fromCli = resolvePaths(opts.overrides ?? {}, cwd);
  const merged = mergeConfig(fromFile, fromCli);

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration${file ? ` (${file})` : ""}:\n${z.prettifyError(result.error)}`);
  }
  // Schema defaults bypass resolvePaths, so expand ~ once more on the final values.
  const config = result.data;
  config.database = config.database === ":memory:" ? config.database : resolveFrom(cwd, config.database);
  return { config, file };
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
  if (isPlain(out.prompt) && typeof out.prompt.templateFile === "string") {
    out.prompt = { ...out.prompt, templateFile: resolveFrom(base, out.prompt.templateFile) };
  }
  return out;
}

function resolveFrom(base: string, path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}
