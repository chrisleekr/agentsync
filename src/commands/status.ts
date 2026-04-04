import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import type { SnapshotArtifact } from "../agents/registry";
import { Agents } from "../agents/registry";
import { loadConfig, resolveConfigPath } from "../config/loader";
import { decryptString } from "../core/encryptor";
import { loadPrivateKey, resolveRuntimeContext } from "./shared";

type SyncStatus = "synced" | "local-changed" | "vault-only" | "local-only" | "error";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

/** Recursively collect all .age file paths under `dir`, returning paths relative to `base`. */
async function collectAgeFiles(dir: string, base: string): Promise<string[]> {
  const results: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectAgeFiles(full, base)));
    } else if (entry.isFile() && entry.name.endsWith(".age")) {
      results.push(relative(base, full));
    }
  }
  return results;
}

interface StatusRow {
  agent: string;
  file: string;
  vaultPath: string;
  status: SyncStatus;
  detail: string;
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show per-file sync status between local configs and vault",
  },
  args: {
    verbose: {
      type: "boolean",
      description: "Show file hashes",
      default: false,
    },
  },
  async run({ args }) {
    const runtime = await resolveRuntimeContext();
    const config = await loadConfig(resolveConfigPath(runtime.vaultDir));

    log.info("AgentSync Status");
    log.info(`Vault : ${runtime.vaultDir}`);
    log.info(`Remote: ${config.remote.url} (${config.remote.branch})`);
    log.info(``);

    const enabledAgents = Agents.filter((a) => config.agents[a.name as keyof typeof config.agents]);

    let key: string | null = null;
    try {
      key = await loadPrivateKey(runtime.privateKeyPath);
    } catch {
      log.warn("Warning: private key not found — cannot compare vault content.");
    }

    const rows: StatusRow[] = [];

    for (const agent of enabledAgents) {
      let artifacts: SnapshotArtifact[] = [];
      try {
        const result = await agent.snapshot();
        artifacts = result.artifacts;
      } catch (err) {
        rows.push({
          agent: agent.name,
          file: "(snapshot failed)",
          vaultPath: "",
          status: "error",
          detail: String(err),
        });
        continue;
      }

      for (const artifact of artifacts) {
        const vaultFilePath = join(runtime.vaultDir, artifact.vaultPath);
        const localHash = sha256(artifact.plaintext);
        let vaultHash = "-";
        let status: SyncStatus = "local-only";
        let detail = "";

        try {
          await stat(vaultFilePath);
          if (key) {
            const encrypted = await readFile(vaultFilePath, "utf8");
            const decrypted = await decryptString(encrypted, key);
            vaultHash = sha256(decrypted);
            status = localHash === vaultHash ? "synced" : "local-changed";
          } else {
            status = "synced"; // Can't compare — assume OK
            detail = "key unavailable";
          }
        } catch {
          status = "local-only";
          detail = "not in vault";
        }

        rows.push({
          agent: agent.name,
          file: relative(homedir(), artifact.sourcePath),
          vaultPath: artifact.vaultPath,
          status,
          detail: args.verbose ? `local:${localHash} vault:${vaultHash}` : detail,
        });
      }
    }

    // Detect vault-only files: .age files in the vault not covered by any local artifact
    if (key) {
      const knownVaultPaths = new Set(rows.map((r) => r.vaultPath));

      for (const agent of enabledAgents) {
        const agentVaultDir = join(runtime.vaultDir, agent.name);
        const ageFiles = await collectAgeFiles(agentVaultDir, runtime.vaultDir);
        for (const vaultRelPath of ageFiles) {
          if (!knownVaultPaths.has(vaultRelPath)) {
            rows.push({
              agent: agent.name,
              file: vaultRelPath,
              vaultPath: vaultRelPath,
              status: "vault-only",
              detail: "not on this machine",
            });
          }
        }
      }
    }

    // Print table
    const colWidths = {
      agent: Math.max(5, ...rows.map((r) => r.agent.length)),
      file: Math.max(4, ...rows.map((r) => r.file.length)),
      status: Math.max(6, ...rows.map((r) => r.status.length)),
      detail: Math.max(6, ...rows.map((r) => r.detail.length)),
    };

    const header = [
      "AGENT".padEnd(colWidths.agent),
      "FILE".padEnd(colWidths.file),
      "STATUS".padEnd(colWidths.status),
      "DETAIL",
    ].join("  ");

    const separator = "-".repeat(header.length);
    log.info(header);
    log.info(separator);

    for (const row of rows) {
      const statusDisplay: Record<SyncStatus, string> = {
        synced: "synced",
        "local-changed": "local-changed",
        "vault-only": "vault-only",
        "local-only": "local-only",
        error: "error",
      };
      log.info(
        [
          row.agent.padEnd(colWidths.agent),
          row.file.padEnd(colWidths.file),
          statusDisplay[row.status].padEnd(colWidths.status),
          row.detail,
        ].join("  "),
      );
    }

    log.info("");
    const summary = {
      synced: rows.filter((r) => r.status === "synced").length,
      changed: rows.filter((r) => r.status === "local-changed").length,
      "local-only": rows.filter((r) => r.status === "local-only").length,
      errors: rows.filter((r) => r.status === "error").length,
    };
    log.info(
      `Summary: ${summary.synced} synced, ${summary.changed} changed, ${summary["local-only"]} local-only, ${summary.errors} errors`,
    );
  },
});
