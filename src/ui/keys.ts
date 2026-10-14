import { emitKeypressEvents } from "node:readline";
import pc from "picocolors";

export interface KeyHandlers {
  togglePause(): void;
  pollNow(): void;
  status(): void;
  quit(): void;
}

export const KEY_HELP = `${pc.bold("p")} pause/resume · ${pc.bold("r")} poll now · ${pc.bold("s")} status · ${pc.bold("q")} quit`;

/** Single-key shortcuts on an interactive terminal. Returns a cleanup function. */
export function bindKeys(handlers: KeyHandlers, input: NodeJS.ReadStream = process.stdin): () => void {
  if (!input.isTTY) return () => {};
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  const onKey = (_: string, key: { name?: string; ctrl?: boolean } | undefined) => {
    if (!key) return;
    if (key.ctrl && key.name === "c") return handlers.quit();
    switch (key.name) {
      case "p":
      case "space":
        return handlers.togglePause();
      case "r":
        return handlers.pollNow();
      case "s":
        return handlers.status();
      case "q":
        return handlers.quit();
    }
  };
  input.on("keypress", onKey);
  return () => {
    input.off("keypress", onKey);
    if (input.isTTY) input.setRawMode(false);
    input.pause();
  };
}
