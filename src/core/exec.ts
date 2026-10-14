import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Text written to the child's stdin. */
  input?: string;
}

export interface ExecResult {
  command: string;
  args: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export class ExecError extends Error {
  constructor(
    message: string,
    readonly result: ExecResult,
  ) {
    super(message);
    this.name = "ExecError";
  }
}

/** Runs a command without a shell and collects its output. Never rejects for non-zero exits. */
export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : undefined;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ command, args, code: null, stdout, stderr: stderr + String(error.message), timedOut });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ command, args, code, stdout, stderr, timedOut });
    });
    child.stdin.end(options.input ?? "");
  });

export function describeFailure(result: ExecResult): string {
  const output = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-5).join("\n");
  const status = result.timedOut ? "timed out" : `exited with ${result.code ?? "spawn error"}`;
  return `\`${[result.command, ...result.args.map(quoteArg)].join(" ").slice(0, 200)}\` ${status}${output ? `: ${output}` : ""}`;
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg.length > 60 ? `${arg.slice(0, 60)}…` : arg);
}

/** Runs a command and returns its result, throwing ExecError on non-zero exit. */
export async function execOk(execFn: Exec, command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
  const result = await execFn(command, args, options);
  if (result.code !== 0) throw new ExecError(describeFailure(result), result);
  return result;
}

/** Resolves the absolute path of a binary on PATH, or undefined. */
export async function which(execFn: Exec, binary: string): Promise<string | undefined> {
  const result = await execFn("/bin/sh", ["-c", 'command -v "$1"', "sh", binary]);
  const path = result.stdout.trim();
  return result.code === 0 && path ? path : undefined;
}
