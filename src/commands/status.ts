import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import pc from "picocolors";
import type { AgentDefinition, SnapshotArtifact } from "../agents/registry";
import { Agents } from "../agents/registry";
import { machineVaultRoot } from "../config/paths";
import type { AgentSyncConfig } from "../config/schema";
import { decryptString } from "../core/encryptor";
import {
  loadPrivateKey,
  loadVaultConfigOrExit,
  type RuntimeContext,
  resolveRuntimeContext,
} from "./shared";

/** Short hash for human-readable status comparisons. */
export type SyncStatus =
  | "synced"
  | "local-changed"
  | "vault-only"
  | "local-only"
  | "unknown"
  | "error";

/** Structured row produced by computeSyncStatus and consumed by both CLI + TUI. */
export interface SyncRow {
  agent: string;
  /** Pre-formatted display label with .age / .tar.age stripped. */
  displayName: string;
  sourcePath: string | null;
  /** Relative vault path including .age / .tar.age extension. */
  vaultPath: string;
  vaultAbsPath: string;
  isSkill: boolean;
  status: SyncStatus;
  detail: string;
  localHash: string | null;
  vaultHash: string | null;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function stripAgeExt(p: string): string {
  return p.replace(/\.tar\.age$/, "").replace(/\.age$/, "");
}

let agentDefinitionsForStatus: AgentDefinition[] = Agents;

/**
 * Test hook: substitute the agent registry used by `computeSyncStatus`.
 *
 * Pass an array to inject custom agents (e.g. a single test agent that emits
 * a synthetic skill artifact). Pass `null` to restore the real registry.
 */
export function __setStatusAgentsForTesting(agents: AgentDefinition[] | null): void {
  agentDefinitionsForStatus = agents ?? Agents;
}

/** Recursively collect encrypted vault files so vault-only entries can be surfaced. */
async function collectAgeFiles(dir: string, base: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const names = await readdir(dir);
    for (const name of names) {
      const full = join(dir, name);
      const entry = await stat(full).catch(() => null);
      if (!entry) {
        continue;
      }
      if (entry.isDirectory()) {
        results.push(...(await collectAgeFiles(full, base)));
      } else if (entry.isFile() && name.endsWith(".age")) {
        results.push(relative(base, full));
      }
    }
  } catch {
    return results;
  }
  return results;
}

export interface ComputeSyncStatusOptions {
  /** Test/DI hook: override the agent registry without touching the module-level setter. */
  agentsOverride?: AgentDefinition[];
}

/**
 * Compute one SyncRow per artifact across all enabled agents plus any
 * vault-only orphans. Pure: no logging, no process.exit. CLI and TUI both
 * call this — never re-implement the diff logic.
 *
 * When `privateKey` is null we cannot decrypt, so rows whose vault file
 * exists receive `status: "unknown"` instead of the prior silent-`synced`
 * fallback. Vault-only orphan detection requires the key (we walk the
 * vault dir but can't tell whether an entry is actually owned by an
 * enabled agent without decrypt), so it is skipped on `null` key.
 */
export async function computeSyncStatus(
  runtime: RuntimeContext,
  config: AgentSyncConfig,
  privateKey: string | null,
  opts: ComputeSyncStatusOptions = {},
): Promise<SyncRow[]> {
  const registry = opts.agentsOverride ?? agentDefinitionsForStatus;
  const enabledAgents = registry.filter((a) => config.agents[a.name as keyof typeof config.agents]);
  const rows: SyncRow[] = [];
  // v2: status compares local state against THIS machine's namespace only.
  const machineRoot = machineVaultRoot(runtime.vaultDir, runtime.machineName);

  for (const agent of enabledAgents) {
    let artifacts: SnapshotArtifact[] = [];
    try {
      const result = await agent.snapshot(config);
      artifacts = result.artifacts;
    } catch (err) {
      rows.push({
        agent: agent.name,
        displayName: "(snapshot failed)",
        sourcePath: null,
        vaultPath: "",
        vaultAbsPath: "",
        isSkill: false,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
        localHash: null,
        vaultHash: null,
      });
      continue;
    }

    for (const artifact of artifacts) {
      const vaultAbsPath = join(machineRoot, artifact.vaultPath);
      const localHash = sha256(artifact.plaintext);
      const isSkill = artifact.vaultPath.endsWith(".tar.age");
      let vaultHash: string | null = null;
      let status: SyncStatus = "local-only";
      let detail = "";

      try {
        await stat(vaultAbsPath);
        if (privateKey) {
          const encrypted = await readFile(vaultAbsPath, "utf8");
          const decrypted = await decryptString(encrypted, privateKey);
          vaultHash = sha256(decrypted);
          status = localHash === vaultHash ? "synced" : "local-changed";
        } else {
          status = "unknown";
          detail = "key unavailable";
        }
      } catch {
        status = "local-only";
        detail = "not in vault";
      }

      rows.push({
        agent: agent.name,
        displayName: relative(homedir(), artifact.sourcePath),
        sourcePath: artifact.sourcePath,
        vaultPath: artifact.vaultPath,
        vaultAbsPath,
        isSkill,
        status,
        detail,
        localHash,
        vaultHash,
      });
    }
  }

  if (privateKey) {
    const knownVaultPaths = new Set(rows.map((r) => r.vaultPath));
    for (const agent of enabledAgents) {
      const agentVaultDir = join(machineRoot, agent.name);
      const ageFiles = await collectAgeFiles(agentVaultDir, machineRoot);
      for (const vaultRelPath of ageFiles) {
        if (!knownVaultPaths.has(vaultRelPath)) {
          rows.push({
            agent: agent.name,
            displayName: stripAgeExt(vaultRelPath),
            sourcePath: null,
            vaultPath: vaultRelPath,
            vaultAbsPath: join(machineRoot, vaultRelPath),
            isSkill: vaultRelPath.endsWith(".tar.age"),
            status: "vault-only",
            detail: "not on this machine",
            localHash: null,
            vaultHash: null,
          });
        }
      }
    }
  }

  return rows;
}

const STATUS_COLOUR: Record<SyncStatus, (s: string) => string> = {
  synced: pc.green,
  "local-changed": pc.yellow,
  "vault-only": pc.cyan,
  "local-only": pc.dim,
  unknown: pc.gray,
  error: pc.red,
};

/** Compare local snapshots with vault contents and print a per-artifact status table. */
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
    const config = await loadVaultConfigOrExit(runtime.vaultDir);

    log.info("AgentSync Status");
    log.info(`Vault : ${runtime.vaultDir}`);
    log.info(`Remote: ${config.remote.url} (${config.remote.branch})`);
    log.info(``);

    let key: string | null = null;
    try {
      key = await loadPrivateKey(runtime.privateKeyPath);
    } catch {
      log.warn("Warning: private key not found — cannot compare vault content.");
    }

    const rows = await computeSyncStatus(runtime, config, key);

    const tableRows = rows.map((r) => ({
      agent: r.agent,
      file: r.sourcePath ? r.displayName : r.vaultPath,
      status: r.status,
      detail: args.verbose ? `local:${r.localHash ?? "-"} vault:${r.vaultHash ?? "-"}` : r.detail,
    }));

    const colWidths = {
      agent: Math.max(5, ...tableRows.map((r) => r.agent.length)),
      file: Math.max(4, ...tableRows.map((r) => r.file.length)),
      status: Math.max(6, ...tableRows.map((r) => r.status.length)),
    };

    const header = [
      "AGENT".padEnd(colWidths.agent),
      "FILE".padEnd(colWidths.file),
      "STATUS".padEnd(colWidths.status),
      "DETAIL",
    ].join("  ");
    log.info(header);
    log.info("-".repeat(header.length));

    for (const row of tableRows) {
      log.info(
        [
          row.agent.padEnd(colWidths.agent),
          row.file.padEnd(colWidths.file),
          STATUS_COLOUR[row.status](row.status.padEnd(colWidths.status)),
          row.detail,
        ].join("  "),
      );
    }

    log.info("");
    const summary = {
      synced: rows.filter((r) => r.status === "synced").length,
      changed: rows.filter((r) => r.status === "local-changed").length,
      "local-only": rows.filter((r) => r.status === "local-only").length,
      "vault-only": rows.filter((r) => r.status === "vault-only").length,
      unknown: rows.filter((r) => r.status === "unknown").length,
      errors: rows.filter((r) => r.status === "error").length,
    };
    log.info(
      `Summary: ${summary.synced} synced, ${summary.changed} changed, ${summary["local-only"]} local-only, ${summary["vault-only"]} vault-only, ${summary.unknown} unknown, ${summary.errors} errors`,
    );
  },
});
