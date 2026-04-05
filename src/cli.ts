#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { daemonCommand } from "./commands/daemon";
import { doctorCommand } from "./commands/doctor";
import { initCommand } from "./commands/init";
import { keyCommand } from "./commands/key";
import { pullCommand } from "./commands/pull";
import { pushCommand } from "./commands/push";
import { statusCommand } from "./commands/status";

/** Root CLI command that wires every user-facing subcommand into a single entry point. */
const main = defineCommand({
  meta: {
    name: "agentsync",
    description: "Sync agent configurations through an encrypted vault",
    version: "0.1.1", // x-release-please-version
  },
  subCommands: {
    init: initCommand,
    push: pushCommand,
    pull: pullCommand,
    status: statusCommand,
    doctor: doctorCommand,
    daemon: daemonCommand,
    key: keyCommand,
  },
});

await runMain(main);
