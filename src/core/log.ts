import pc from "picocolors";

export type LogTopic = "drovr" | "config" | "check" | "poll" | "match" | "skip" | "queue" | "launch" | "agent" | "done" | "warn" | "error" | "dry-run";

const TOPIC_COLOR: Record<LogTopic, (s: string) => string> = {
  drovr: pc.cyan,
  config: pc.dim,
  check: pc.blue,
  poll: pc.blue,
  match: pc.green,
  skip: pc.dim,
  queue: pc.yellow,
  launch: pc.magenta,
  agent: pc.cyan,
  done: pc.green,
  warn: pc.yellow,
  error: pc.red,
  "dry-run": pc.yellow,
};

export interface Logger {
  log(topic: LogTopic, message: string): void;
  /** Indented detail line under the previous message. */
  detail(message: string): void;
}

export interface ConsoleLoggerOptions {
  verbose?: boolean;
  write?: (line: string) => void;
}

export function createConsoleLogger(opts: ConsoleLoggerOptions = {}): Logger {
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  return {
    log(topic, message) {
      if (topic === "skip" && !opts.verbose) return;
      const time = pc.dim(new Date().toTimeString().slice(0, 8));
      write(`${time} ${TOPIC_COLOR[topic](topic.padEnd(7))} ${message}`);
    },
    detail(message) {
      write(`${" ".repeat(17)}${pc.dim(message)}`);
    },
  };
}

export const silentLogger: Logger = { log() {}, detail() {} };
