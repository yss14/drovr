import { describeFailure, which } from "../../core/exec.js";
import type { AgentProvider, AvailabilityResult, ProviderContext } from "../types.js";

interface CliAgentSpec {
  id: string;
  displayName: string;
  binary: string;
  /** Agent kind per terminal provider. */
  terminalKinds: Record<string, string>;
  /** Screen patterns that mean the agent is waiting on a startup dialog, with a description. */
  blockers: [RegExp, string][];
}

/** Interactive coding agents that a terminal provider launches by kind (Herdr runs the canonical executable). */
export function createCliAgent(ctx: ProviderContext, spec: CliAgentSpec): AgentProvider {
  return {
    kind: "agent",
    id: spec.id,
    displayName: spec.displayName,

    async checkAvailability(): Promise<AvailabilityResult> {
      const path = await which(ctx.exec, spec.binary);
      if (!path) return { ok: false, detail: `${spec.binary} not found on PATH` };
      const version = await ctx.exec(spec.binary, ["--version"], { timeoutMs: 20_000 });
      if (version.code !== 0) return { ok: false, detail: `${spec.binary} --version failed: ${describeFailure(version)}` };
      return { ok: true, detail: `${version.stdout.trim().split("\n")[0]} (${path})` };
    },

    launchSpec(terminalId, extraArgs) {
      const kind = spec.terminalKinds[terminalId];
      if (!kind) throw new Error(`${spec.displayName} has no launch mapping for terminal provider "${terminalId}"`);
      return { kind, args: extraArgs };
    },

    detectBlocker(screen) {
      // Terminal output wraps long lines; match on whitespace-collapsed text.
      const flat = screen.replace(/\s+/g, " ");
      return spec.blockers.find(([pattern]) => pattern.test(flat))?.[1];
    },
  };
}

// Verified against codex-cli 0.162.1 and Claude Code 2.1.296. Dialog wording can change between versions.
export const codexSpec: CliAgentSpec = {
  id: "codex",
  displayName: "Codex",
  binary: "codex",
  terminalKinds: { herdr: "codex" },
  blockers: [
    [/Trust this folder\?|Do you trust the contents of this directory/i, "folder trust prompt"],
    [/Sign in with ChatGPT|Provide your own API key/i, "login prompt"],
  ],
};

export const claudeSpec: CliAgentSpec = {
  id: "claude",
  displayName: "Claude Code",
  binary: "claude",
  terminalKinds: { herdr: "claude" },
  blockers: [
    [/Quick safety check|Is this a project you created or one you trust|Do you trust the files in this folder/i, "folder trust prompt"],
    [/Select login method|Choose the text style that looks best/i, "login or onboarding prompt"],
    [/Enter to confirm · Esc to cancel/, "confirmation dialog"],
  ],
};
