import { describe, expect, test } from "bun:test";
import { migrateCommand } from "../migrate";

describe("migrate command execution", () => {
  test("rejects a direct shared-store agents migration before performing writes", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      await migrateCommand.run?.({
        args: {
          from: "copilot",
          to: "vscode",
          type: "agents",
          dryRun: false,
        },
      } as never);

      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
