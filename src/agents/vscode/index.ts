import { homedir } from "node:os";
import { AgentPaths } from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import { denormalizeStringFromVault } from "../../core/path-portability";
import { sanitizeAndNormalizeJson, securityToPolicy } from "../../core/sanitizer";
import { mergePreservingSecrets } from "../../core/secret-merge";
import { type ApplyPlan, defineFileArtifact, makeApplyVault } from "../_apply";
import {
  atomicWrite,
  collect,
  parseJsoncObject,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
} from "../_utils";

/** Snapshot payload for the VS Code adapter. */
export type VsCodeSnapshotResult = SnapshotResult;

/** Collect the VS Code MCP configuration that AgentSync manages. */
export async function snapshotVsCode(config?: AgentSyncConfig): Promise<SnapshotResult> {
  const policy = securityToPolicy(config?.security);
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  const mcpRaw = await readIfExists(AgentPaths.vscode.mcpJson);
  if (mcpRaw !== null) {
    const sanitized = sanitizeAndNormalizeJson(mcpRaw, "vscode_mcp", homedir(), policy);
    const artifact = collect(sanitized, AgentPaths.vscode.mcpJson, "vscode/mcp.json.age");
    artifacts.push(artifact);
    warnings.push(...sanitized.warnings);
  }

  return { artifacts, warnings };
}

/** Restore the synced VS Code MCP configuration file. */
export async function applyVsCodeMcp(mcpJsonContent: string): Promise<void> {
  const restored = denormalizeStringFromVault(mcpJsonContent, homedir());
  const existingRaw = await readIfExists(AgentPaths.vscode.mcpJson);
  if (existingRaw === null) {
    await atomicWrite(AgentPaths.vscode.mcpJson, restored);
    return;
  }
  // Merge so a redacted placeholder (`redact` mode) never overwrites a real
  // local key and local-only servers survive. Fall back to the restored
  // content on any parse failure rather than lose the sync.
  try {
    const incoming = JSON.parse(restored);
    const { merged } = mergePreservingSecrets(parseJsoncObject(existingRaw) ?? {}, incoming);
    await atomicWrite(AgentPaths.vscode.mcpJson, `${JSON.stringify(merged, null, 2)}\n`);
  } catch {
    await atomicWrite(AgentPaths.vscode.mcpJson, restored);
  }
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

/** Build the VS Code apply plan. Exposed so `copy` can apply a single artifact. */
export function buildVsCodePlan(_config?: AgentSyncConfig): ApplyPlan {
  return {
    agent: "vscode",
    directives: [
      defineFileArtifact({
        vaultName: "mcp.json.age",
        dryRunLabel: "[dry-run] [vscode] would apply mcp.json",
        apply: applyVsCodeMcp,
      }),
    ],
  };
}

/** Decrypt and apply all VS Code vault artifacts to the local machine. */
export const applyVsCodeVault = makeApplyVault(buildVsCodePlan);
