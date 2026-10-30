import { createInterface } from "node:readline/promises";
import pc from "picocolors";

export interface Choice {
  value: string;
  /** Shown after the value, dimmed. */
  hint?: string;
}

export interface Prompter {
  /** False when every question takes its default without asking. */
  readonly interactive: boolean;
  text(question: string, opts?: { default?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  /** One of `choices`; with `custom`, any typed value is accepted too. */
  select(question: string, choices: Choice[], opts?: { default?: number; custom?: boolean }): Promise<string>;
  /** Several of `choices`, given as numbers or names separated by commas. "none" selects nothing. */
  multiselect(question: string, choices: Choice[], opts?: { defaults?: number[]; custom?: boolean }): Promise<string[]>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  close(): void;
}

/** Answers every question with its default. Used for `drovr init --yes` and without a terminal. */
export function defaultsPrompter(): Prompter {
  return {
    interactive: false,
    text: async (_q, opts) => opts?.default ?? "",
    select: async (_q, choices, opts) => choices[opts?.default ?? 0]?.value ?? "",
    multiselect: async (_q, choices, opts) => (opts?.defaults ?? []).map((i) => choices[i]!.value),
    confirm: async (_q, defaultValue) => defaultValue,
    close: () => {},
  };
}

export function readlinePrompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter {
  const rl = createInterface({ input, output });
  rl.on("SIGINT", () => {
    output.write("\n");
    rl.close();
    process.exit(130);
  });
  const say = (line: string) => output.write(`${line}\n`);
  const list = (choices: Choice[]) =>
    choices.forEach((c, i) => say(`  ${pc.dim(`${String(i + 1).padStart(2)})`)} ${c.value}${c.hint ? `  ${pc.dim(c.hint)}` : ""}`));
  const pick = (choices: Choice[], token: string, custom?: boolean): string | undefined => {
    const n = Number(token);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1]!.value;
    const named = choices.find((c) => c.value.toLowerCase() === token.toLowerCase());
    return named?.value ?? (custom ? token : undefined);
  };

  return {
    interactive: true,

    async text(question, opts = {}) {
      for (;;) {
        const answer = (await rl.question(`${pc.cyan("?")} ${question}${opts.default ? pc.dim(` [${opts.default}]`) : ""}: `)).trim() || opts.default || "";
        const error = opts.validate?.(answer);
        if (!error) return answer;
        say(pc.red(`  ${error}`));
      }
    },

    async select(question, choices, opts = {}) {
      const def = opts.default ?? 0;
      say(`${pc.cyan("?")} ${question}`);
      list(choices);
      for (;;) {
        const hint = choices[def] ? ` [${def + 1}]` : "";
        const answer = (await rl.question(`  ${opts.custom ? "number or name" : "number"}${pc.dim(hint)}: `)).trim();
        const value = answer ? pick(choices, answer, opts.custom) : choices[def]?.value;
        if (value) return value;
        say(pc.red(`  enter 1–${choices.length}${opts.custom ? " or a name" : ""}`));
      }
    },

    async multiselect(question, choices, opts = {}) {
      const defs = opts.defaults ?? [];
      say(`${pc.cyan("?")} ${question}`);
      list(choices);
      for (;;) {
        const hint = defs.length > 0 ? defs.map((i) => i + 1).join(",") : "none";
        const answer = (await rl.question(`  numbers${opts.custom ? " or names" : ""}, comma-separated, or "none"${pc.dim(` [${hint}]`)}: `)).trim();
        if (!answer) return defs.map((i) => choices[i]!.value);
        if (answer.toLowerCase() === "none") return [];
        const tokens = answer.split(",").map((t) => t.trim()).filter(Boolean);
        const values = tokens.map((t) => pick(choices, t, opts.custom));
        if (values.every((v) => v !== undefined)) return [...new Set(values as string[])];
        say(pc.red(`  unknown: ${tokens.filter((_, i) => values[i] === undefined).join(", ")}`));
      }
    },

    async confirm(question, defaultValue) {
      const answer = (await rl.question(`${pc.cyan("?")} ${question} ${pc.dim(defaultValue ? "[Y/n]" : "[y/N]")}: `)).trim().toLowerCase();
      return answer ? answer.startsWith("y") : defaultValue;
    },

    close: () => rl.close(),
  };
}
