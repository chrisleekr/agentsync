import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import { decryptString } from "../core/encryptor";
import { redactSecretLiterals } from "../core/sanitizer";
import { atomicWrite, collect, readIfExists, type SnapshotArtifact } from "./_utils";

export interface VsCodeSnapshotResult {
  artifacts: SnapshotArtifact[];
  warnings: string[];
}

export async function snapshotVsCode(): Promise<VsCodeSnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  const mcpRaw = await readIfExists(AgentPaths.vscode.mcpJson);
  if (mcpRaw !== null) {
    const redacted = redactSecretLiterals(
      JSON.parse(mcpRaw) as Record<string, unknown>,
      "vscode_mcp",
    );
    const artifact = collect(
      {
        value: `${JSON.stringify(redacted.value, null, 2)}\n`,
        warnings: redacted.warnings,
      },
      AgentPaths.vscode.mcpJson,
      "vscode/mcp.json.age",
    );
    artifacts.push(artifact);
    warnings.push(...redacted.warnings);
  }

  return { artifacts, warnings };
}

export async function applyVsCodeMcp(mcpJsonContent: string): Promise<void> {
  await atomicWrite(AgentPaths.vscode.mcpJson, mcpJsonContent);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".age"))
      .map((e) => ({ name: e.name, fullPath: join(dir, e.name) }));
  } catch {
    return [];
  }
}

/**
 * Decrypt and apply all VS Code vault artifacts to the local machine.
 */
export async function applyVsCodeVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
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
