import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { migrateCommand } from "../migrate";

const mutableAgentPaths = AgentPaths as unknown as {
  copilot: { agentsDir: string };
  vscode: { agentsDir: string };
};

describe("migrate command execution", () => {
  test("rejects a direct shared-store agents migration before performing writes", async () => {
    const previousExitCode = process.exitCode;
    const previousCopilotAgentsDir = AgentPaths.copilot.agentsDir;
    const previousVsCodeAgentsDir = AgentPaths.vscode.agentsDir;
    const root = await mkdtemp(join(tmpdir(), "migrate-run-agents-"));
    const agentsDir = join(root, "agents");
    const target = join(agentsDir, "reviewer.agent.md");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(target, "existing", "utf8");
    mutableAgentPaths.copilot.agentsDir = agentsDir;
    mutableAgentPaths.vscode.agentsDir = agentsDir;
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
      expect(await Bun.file(target).text()).toBe("existing");
    } finally {
      mutableAgentPaths.copilot.agentsDir = previousCopilotAgentsDir;
      mutableAgentPaths.vscode.agentsDir = previousVsCodeAgentsDir;
      process.exitCode = previousExitCode;
      await rm(root, { recursive: true, force: true });
    }
  });
});
