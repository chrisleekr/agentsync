#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { daemonCommand } from "./commands/daemon";
import { destroyCommand } from "./commands/destroy";
import { doctorCommand } from "./commands/doctor";
import { initCommand } from "./commands/init";
import { keyCommand } from "./commands/key";
import { migrateCommand } from "./commands/migrate";
import { pullCommand } from "./commands/pull";
import { pushCommand } from "./commands/push";
import { skillCommand } from "./commands/skill";
import { statusCommand } from "./commands/status";
import { tuiCommand } from "./commands/tui";

/** Root CLI command that wires every user-facing subcommand into a single entry point. */
const main = defineCommand({
  meta: {
    name: "agentsync",
    description: "Sync agent configurations through an encrypted vault",
    version: "0.1.9", // x-release-please-version
  },
  subCommands: {
    init: initCommand,
    push: pushCommand,
    pull: pullCommand,
    status: statusCommand,
    doctor: doctorCommand,
    daemon: daemonCommand,
    key: keyCommand,
    migrate: migrateCommand,
    skill: skillCommand,
    destroy: destroyCommand,
    tui: tuiCommand,
  },
});

const userArgs = process.argv.slice(2);

if (userArgs.length === 0) {
  // Bare `agentsync` opens the TUI on a real terminal. In a pipe, redirect to
  // a non-interactive context, or in CI, we deliberately fall back to the
  // existing `status` text output so scripts that depend on the previous
  // no-args behaviour are not broken.
  if (process.stdout.isTTY) {
    const { runTui } = await import("./commands/tui");
    await runTui();
  } else {
    await statusCommand.run?.({
      args: { verbose: false },
      rawArgs: [],
      cmd: {} as never,
    } as never);
  }
} else {
  await runMain(main);
}
