import { realpathSync } from "node:fs";
import { describeFailure, which } from "../../core/exec.js";
import type {
  AgentActivity,
  AgentState,
  AvailabilityResult,
  PaneState,
  ProviderContext,
  StartAgentResult,
  TerminalProvider,
  WorkspaceRef,
} from "../types.js";

/** Version drovr's Herdr integration was verified against. */
const TESTED_VERSION = "0.7.5";
/** How long to wait for a new pane's shell to reach its prompt. */
const SHELL_STARTUP_GRACE_MS = 20_000;

const HERDR_AGENT_KINDS = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode",
  "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "maki",
];

export class HerdrError extends Error {
  override name = "HerdrError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface HerdrOptions {
  session: string;
  binary?: string;
}

type Json = Record<string, unknown>;

export function createHerdrProvider(ctx: ProviderContext, options: HerdrOptions): TerminalProvider {
  const binary = options.binary ?? "herdr";
  const env = { HERDR_SESSION: options.session };

  /** Runs a herdr command that answers with a JSON envelope and returns `result`. */
  async function call(args: string[], timeoutMs = 30_000): Promise<Json> {
    const result = await ctx.exec(binary, args, { env, timeoutMs });
    const envelope = parseEnvelope(result.stdout) ?? parseEnvelope(result.stderr);
    if (envelope?.error) {
      const error = envelope.error as { code?: string; message?: string };
      throw new HerdrError(error.code ?? "unknown", error.message ?? describeFailure(result));
    }
    if (result.code !== 0 || !envelope) {
      const missingSession = /No such file or directory/.test(result.stderr + result.stdout);
      throw new HerdrError(
        missingSession ? "session_unreachable" : result.timedOut ? "timeout" : "command_failed",
        missingSession ? `Herdr session "${options.session}" is not running (no socket)` : describeFailure(result),
      );
    }
    return (envelope.result ?? {}) as Json;
  }

  async function orUndefined<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof HerdrError && error.code.endsWith("not_found")) return undefined;
      throw error;
    }
  }

  return {
    kind: "terminal",
    id: "herdr",

    async checkAvailability(): Promise<AvailabilityResult> {
      const path = await which(ctx.exec, binary);
      if (!path) return { ok: false, detail: `${binary} not found on PATH` };
      const versionOut = (await ctx.exec(binary, ["--version"])).stdout.trim();
      const version = versionOut.match(/(\d+\.\d+\.\d+)/)?.[1];
      const warnings: string[] = [];
      if (version && version !== TESTED_VERSION) {
        warnings.push(`herdr ${version} differs from the tested ${TESTED_VERSION}; response shapes may differ`);
      }
      const sessions = await ctx.exec(binary, ["session", "list"]);
      const line = sessions.stdout.split("\n").find((l) => l.trim().split(/\s+/)[0] === options.session);
      if (!line) {
        return { ok: false, detail: `herdr ${version ?? "?"}: session "${options.session}" does not exist (create it with \`herdr --session ${options.session}\`)` };
      }
      const status = line.trim().split(/\s+/)[1];
      if (status !== "running") {
        return { ok: false, detail: `herdr ${version ?? "?"}: session "${options.session}" is ${status}; attach with \`herdr session attach ${options.session}\`` };
      }
      try {
        await call(["workspace", "list"]);
      } catch (error) {
        return { ok: false, detail: `herdr session "${options.session}" is not responding: ${(error as Error).message}` };
      }
      return { ok: true, detail: `herdr ${version ?? "?"}, session "${options.session}" running`, warnings };
    },

    supportedAgentKinds: () => HERDR_AGENT_KINDS,

    async createWorkspace({ cwd, label, focus, env: vars }): Promise<WorkspaceRef> {
      const args = ["workspace", "create", "--cwd", cwd, "--label", label, focus ? "--focus" : "--no-focus"];
      for (const [key, value] of Object.entries(vars)) args.push("--env", `${key}=${value}`);
      const result = await call(args);
      const workspaceId = (result.workspace as Json | undefined)?.workspace_id;
      const paneId = (result.root_pane as Json | undefined)?.pane_id;
      if (typeof workspaceId !== "string" || typeof paneId !== "string") {
        throw new HerdrError("unexpected_response", `workspace create returned no workspace/root pane IDs: ${JSON.stringify(result).slice(0, 300)}`);
      }
      return { workspaceId, paneId };
    },

    async findWorkspace({ label, cwd }): Promise<WorkspaceRef | undefined> {
      const list = await call(["workspace", "list"]);
      const workspaces = ((list.workspaces as Json[] | undefined) ?? []).filter((w) => w.label === label);
      const target = canonical(cwd);
      for (const workspace of workspaces) {
        const panes = await call(["pane", "list", "--workspace", String(workspace.workspace_id)]);
        const pane = ((panes.panes as Json[] | undefined) ?? []).find((p) => typeof p.cwd === "string" && canonical(p.cwd) === target);
        if (pane) return { workspaceId: String(workspace.workspace_id), paneId: String(pane.pane_id) };
      }
      return undefined;
    },

    async workspaceExists(workspaceId) {
      return (await orUndefined(() => call(["workspace", "get", workspaceId]))) !== undefined;
    },

    async listWorkspaceIds() {
      const list = await call(["workspace", "list"]);
      return new Set(((list.workspaces as Json[] | undefined) ?? []).map((w) => String(w.workspace_id)));
    },

    async getPane(paneId): Promise<PaneState | undefined> {
      const result = await orUndefined(() => call(["pane", "get", paneId]));
      const pane = result?.pane as Json | undefined;
      return pane ? toPane(pane) : undefined;
    },

    async startAgent({ name, paneId, launch, timeoutMs }): Promise<StartAgentResult> {
      const args = ["agent", "start", name, "--kind", launch.kind, "--pane", paneId, "--timeout", String(timeoutMs)];
      if (launch.args.length > 0) args.push("--", ...launch.args);
      try {
        // A fresh workspace's shell may still be starting (rc files), which herdr reports as
        // agent_pane_busy. Retry for a while before treating it as a real failure.
        const deadline = Date.now() + SHELL_STARTUP_GRACE_MS;
        for (;;) {
          try {
            const result = await call(args, timeoutMs + 15_000);
            return { status: "ready", agent: toAgent(result.agent as Json) };
          } catch (error) {
            if (!(error instanceof HerdrError && error.code === "agent_pane_busy") || Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        }
      } catch (error) {
        // A launch that timed out waiting for readiness typically sits at a trust, login, or
        // update dialog. If an agent process is visible in the pane, hand it to the user.
        const pane = await orUndefined(async () => (await call(["pane", "get", paneId])).pane as Json);
        if (pane && typeof pane.agent === "string") {
          return { status: "not_ready", detail: `${(error as Error).message} (pane shows ${pane.agent}, status ${String(pane.agent_status)})` };
        }
        throw error;
      }
    },

    async getAgent(name) {
      const result = await orUndefined(() => call(["agent", "get", name]));
      return result?.agent ? toAgent(result.agent as Json) : undefined;
    },

    async listAgents() {
      const result = await call(["agent", "list"]);
      return ((result.agents as Json[] | undefined) ?? []).map(toAgent);
    },

    async renameAgent(target, name) {
      await call(["agent", "rename", target, name]);
    },

    async submitPrompt(agentName, text) {
      // --wait requires an observed state change within 5s (else agent_prompt_stalled); matching
      // every state makes it return as soon as the agent reacts instead of when the turn ends.
      const untils = ["working", "blocked", "idle", "done"].flatMap((state) => ["--until", state]);
      try {
        await call(["agent", "prompt", agentName, text, "--wait", ...untils, "--timeout", "30000"], 60_000);
        return { confirmed: true };
      } catch (error) {
        if (error instanceof HerdrError && (error.code === "agent_prompt_stalled" || error.code === "timeout")) {
          return { confirmed: false, detail: error.message };
        }
        throw error;
      }
    },

    async readAgentOutput(agentName, lines, source = "recent") {
      const herdrSource = source === "visible" ? "visible" : "recent-unwrapped";
      const result = await ctx.exec(binary, ["agent", "read", agentName, "--source", herdrSource, "--lines", String(lines), "--format", "text"], {
        env,
        timeoutMs: 15_000,
      });
      if (result.code !== 0) throw new HerdrError("read_failed", describeFailure(result));
      return result.stdout;
    },
  };
}

function parseEnvelope(text: string): Json | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as Json;
  } catch {
    return undefined;
  }
}

function activity(value: unknown): AgentActivity {
  return value === "idle" || value === "working" || value === "blocked" || value === "done" ? value : "unknown";
}

function toPane(pane: Json): PaneState {
  return {
    paneId: String(pane.pane_id),
    workspaceId: String(pane.workspace_id),
    cwd: typeof pane.cwd === "string" ? pane.cwd : undefined,
    agent: typeof pane.agent === "string" ? pane.agent : undefined,
    activity: activity(pane.agent_status),
    interactiveReady: typeof pane.interactive_ready === "boolean" ? pane.interactive_ready : undefined,
  };
}

function toAgent(agent: Json): AgentState {
  return {
    name: typeof agent.name === "string" ? agent.name : undefined,
    paneId: String(agent.pane_id),
    workspaceId: String(agent.workspace_id),
    agent: typeof agent.agent === "string" ? agent.agent : undefined,
    activity: activity(agent.agent_status),
    interactiveReady: typeof agent.interactive_ready === "boolean" ? agent.interactive_ready : undefined,
  };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path.replace(/\/+$/, "");
  }
}

