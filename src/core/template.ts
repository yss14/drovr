import { readFileSync } from "node:fs";
import type { Config } from "../config/schema.js";
import type { Ticket } from "../plugins/types.js";

export type TemplateVars = Record<string, string | undefined>;

/** Replaces {name} placeholders. Unknown placeholders are left intact so typos stay visible. */
export function render(template: string, vars: TemplateVars): string {
  return template.replace(/\{([A-Za-z][\w]*)\}/g, (match, name: string) => vars[name] ?? match);
}

/** Shortens text to at most maxLength characters at a word boundary, adding an ellipsis. */
export function truncateWords(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxLength / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

export function slugify(value: string, maxLength = 60): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) return slug;
  // Prefer ending on a whole word; fall back to a hard cut for one long word.
  const cut = slug.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > maxLength / 2 ? cut.slice(0, boundary) : slug.slice(0, maxLength)).replace(/-+$/, "");
}

export function ticketVars(ticket: Ticket): TemplateVars {
  return {
    identifier: ticket.identifier,
    identifierLower: ticket.identifier.toLowerCase(),
    title: ticket.title,
    titleSlug: slugify(ticket.title, 40),
    titleShort: truncateWords(ticket.title, 48),
    titleSlugShort: slugify(ticket.title, 24),
    url: ticket.url,
    ticketBranch: ticket.branchName,
    state: ticket.state.name,
    team: ticket.team,
    labels: ticket.labels.join(", "),
    priority: ticket.priority !== undefined ? String(ticket.priority) : undefined,
    project: ticket.project,
    assignee: ticket.assignee,
  };
}

/** Herdr agent names and similar identifiers: lowercase, [a-z0-9-]. */
export function safeName(value: string): string {
  return slugify(value, 64) || "agent";
}

export const PROMPT_MARKER = (identifier: string) => `[drovr:${identifier}]`;

export const DEFAULT_PROMPT = `{marker} Linear ticket {identifier}: {title}
Ticket URL: {url}

You are working in a dedicated git worktree at {worktreePath} on branch {branch} (based on {baseBranch}).

## Ticket description

{description}

## How to proceed

1. Read the ticket carefully and explore the relevant code before changing anything.
2. If the requirements are ambiguous or a decision has significant trade-offs, ask me before implementing.
3. Implement the change with focused commits on this branch and run the relevant tests, linters, and type checks.
4. When you are done, summarise what you changed, how you verified it, and anything left open.
`;

/** Variables available in the prompt brief and message, with descriptions (shown by `drovr prompt --variables`). */
export const PROMPT_VARIABLES: Record<string, string> = {
  marker: "delivery marker [drovr:<ID>]; added to the front of the sent text if missing",
  identifier: "ticket key, e.g. PQ-1234",
  identifierLower: "ticket key in lowercase",
  title: "ticket title",
  titleSlug: "ticket title as a slug",
  titleShort: "ticket title shortened to 48 characters at a word boundary",
  titleSlugShort: "ticket title as a slug of at most 24 characters",
  url: "ticket URL",
  description: "ticket description (Markdown), or \"(no description)\"",
  state: "ticket state name",
  labels: "comma-separated label names",
  priority: "priority number (1 urgent … 4 low, 0 none)",
  project: "project name",
  assignee: "assignee display name",
  team: "team key",
  ticketBranch: "branch name suggested by the tracker",
  branch: "branch the agent works on",
  baseBranch: "branch the worktree started from",
  worktreePath: "absolute worktree path",
  repo: "absolute path of the main checkout",
  agent: "agent display name, e.g. Claude Code",
  briefPath: "brief path relative to the worktree (file delivery; message only)",
};

/** Placeholders in a template that drovr does not know; these would reach the agent verbatim. */
export function unknownPlaceholders(template: string): string[] {
  const names = [...template.matchAll(/\{([A-Za-z][\w]*)\}/g)].map((m) => m[1]!);
  return [...new Set(names.filter((name) => !(name in PROMPT_VARIABLES)))];
}

export interface PromptContext {
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  repo?: string;
  agent?: string;
}

export interface RenderedPrompt {
  /** The ticket brief (file content with file delivery; the sent text with inline delivery). */
  brief: string;
  /** Brief location relative to the worktree, with file delivery. */
  briefPath?: string;
  /** Exactly what is submitted to the agent. */
  text: string;
}

/** Renders what drovr sends for a ticket. Pure, so `drovr prompt` previews exactly what a launch sends. */
export function renderPrompt(config: Config, template: string, ticket: Ticket, context: PromptContext): RenderedPrompt {
  const marker = PROMPT_MARKER(ticket.identifier);
  const vars: TemplateVars = {
    ...ticketVars(ticket),
    ...context,
    marker,
    description: ticket.description?.trim() || "(no description)",
  };
  const brief = render(template, vars);
  let text = brief;
  let briefPath: string | undefined;
  if (config.prompt.delivery === "file") {
    briefPath = render(config.prompt.briefPath, vars);
    // A single line is typed rather than pasted, which agents treat as a direct instruction.
    text = render(config.prompt.message, { ...vars, briefPath }).replace(/\s*\n\s*/g, " ").trim();
  }
  // The marker lets drovr recognise a delivered prompt after an interruption.
  if (!text.includes(marker)) text = `${marker} ${text}`;
  return { brief, briefPath, text };
}

export function loadPromptTemplate(config: Config): string {
  if (config.prompt.templateFile) return readFileSync(config.prompt.templateFile, "utf8");
  return config.prompt.template ?? DEFAULT_PROMPT;
}
