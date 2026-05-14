import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import type { AgentSyncConfig } from "../config/schema";
import { decryptString } from "../core/encryptor";
import { denormalizeStringFromVault } from "../core/path-portability";
import { sanitizeAndNormalizeJson } from "../core/sanitizer";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
} from "./_utils";

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

/** Read encrypted files from a vault subdirectory, ignoring missing directories. */
async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith(".age"))
      .map((name) => ({
        name,
        fullPath: join(dir, name),
      }));
  } catch {
    return [];
  }
}

/** Decrypt and apply all VS Code vault artifacts to the local machine. */
export async function applyVsCodeVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
  _config?: AgentSyncConfig,
): Promise<void> {
  const vsCodeDir = join(vaultDir, "vscode");
  const files = await readAgeFiles(vsCodeDir);

  for (const { name, fullPath } of files) {
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);

    if (name === "mcp.json.age") {
      if (dryRun) {
        log.info("[dry-run] [vscode] would apply mcp.json");
        continue;
      }
      await applyVsCodeMcp(decrypted);
    }
  }
}
