import { defineCommand } from "citty";
import { runApp } from "./app";

/** Launch the interactive TUI. Resolves when the user quits. */
export async function runTui(): Promise<void> {
  await runApp();
}

/** Explicit `agentsync tui` alias — bare `agentsync` is wired up in cli.ts. */
export const tuiCommand = defineCommand({
  meta: {
    name: "tui",
    description: "Open the interactive terminal UI",
  },
  async run() {
    await runTui();
  },
});
