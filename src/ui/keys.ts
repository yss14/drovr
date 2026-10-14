import { emitKeypressEvents } from "node:readline";
import pc from "picocolors";

export interface KeyHandlers {
  togglePause(): void;
  pollNow(): void;
  status(): void;
  reload(): void;
  quit(): void;
}

export const KEY_HELP = `${pc.bold("space")} pause/resume · ${pc.bold("p")} poll now · ${pc.bold("r")} reload config · ${pc.bold("s")} status · ${pc.bold("q")} quit`;

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
      case "space":
        return handlers.togglePause();
      case "p":
        return handlers.pollNow();
      case "r":
        return handlers.reload();
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
