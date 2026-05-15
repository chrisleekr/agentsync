import { homedir } from "node:os";
import { AgentPaths } from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import { denormalizeStringFromVault } from "../../core/path-portability";
import { sanitizeAndNormalizeJson } from "../../core/sanitizer";
import { type ApplyPlan, defineFileArtifact, runApplyPlan } from "../_apply";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
} from "../_utils";

/** Snapshot payload for the VS Code adapter. */
export type VsCodeSnapshotResult = SnapshotResult;

/** Collect the VS Code MCP configuration that AgentSync manages. */
export async function snapshotVsCode(_config?: AgentSyncConfig): Promise<SnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  const mcpRaw = await readIfExists(AgentPaths.vscode.mcpJson);
  if (mcpRaw !== null) {
    const sanitized = sanitizeAndNormalizeJson(mcpRaw, "vscode_mcp");
    const artifact = collect(sanitized, AgentPaths.vscode.mcpJson, "vscode/mcp.json.age");
    artifacts.push(artifact);
    warnings.push(...sanitized.warnings);
  }

  return { artifacts, warnings };
}

/** Restore the synced VS Code MCP configuration file. */
export async function applyVsCodeMcp(mcpJsonContent: string): Promise<void> {
  await atomicWrite(
    AgentPaths.vscode.mcpJson,
    denormalizeStringFromVault(mcpJsonContent, homedir()),
  );
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

/** Decrypt and apply all VS Code vault artifacts to the local machine. */
export async function applyVsCodeVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
  _config?: AgentSyncConfig,
): Promise<void> {
  const plan: ApplyPlan = {
    agent: "vscode",
    directives: [
      defineFileArtifact({
        vaultName: "mcp.json.age",
        dryRunLabel: "[dry-run] [vscode] would apply mcp.json",
        apply: applyVsCodeMcp,
      }),
    ],
  };
  await runApplyPlan(plan, vaultDir, key, dryRun);
}
