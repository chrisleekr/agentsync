import { mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { loadConfig, resolveConfigPath } from "../config/loader";
import { resolveAgentSyncHome } from "../config/paths";
import type { AgentSyncConfig } from "../config/schema";

/** Runtime paths and machine identity resolved from the local environment. */
export interface RuntimeContext {
  vaultDir: string;
  privateKeyPath: string;
  machineName: string;
}

/**
 * Trim a candidate string and treat blank values as absent. An exported but
 * empty env var is "" (a defined string), so `??` alone would short-circuit
 * the fallback chain on it; this collapses "" and whitespace-only to undefined
 * so resolution falls through to the next source. A non-blank value is
 * returned trimmed.
 */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Resolve the working directories and machine label that all commands share. */
export async function resolveRuntimeContext(): Promise<RuntimeContext> {
  const baseDir = resolveAgentSyncHome();
  await mkdir(baseDir, { recursive: true });

  return {
    vaultDir: nonBlank(process.env.AGENTSYNC_VAULT_DIR) ?? join(baseDir, "vault"),
    privateKeyPath: nonBlank(process.env.AGENTSYNC_KEY_PATH) ?? join(baseDir, "key.txt"),
    // AGENTSYNC_MACHINE env var > HOSTNAME env var > os.hostname() > static fallback
    machineName:
      nonBlank(process.env.AGENTSYNC_MACHINE) ??
      nonBlank(process.env.HOSTNAME) ??
      nonBlank(hostname()) ??
      "local-machine",
  };
}

/** Read the local age identity and trim trailing newlines before use. */
export async function loadPrivateKey(path: string): Promise<string> {
  const key = await readFile(path, "utf8");
  return key.trim();
}

/**
 * Load the vault config; if it is missing, print a friendly "vault not
 * initialized" error and exit 1 instead of letting the raw ENOENT bubble up as
 * a Node stack trace. Other errors (e.g. schema parse failures) are re-thrown
 * unchanged so callers and test harnesses can still see them.
 */
export async function loadVaultConfigOrExit(vaultDir: string): Promise<AgentSyncConfig> {
  const configPath = resolveConfigPath(vaultDir);
  try {
    return await loadConfig(configPath);
  } catch (err) {
    if (isFileNotFoundError(err)) {
      log.error(
        `Vault not initialized at ${vaultDir}. Run \`agentsync init --remote <git-url>\` first.`,
      );
      process.exit(1);
    }
    throw err;
  }
}

export function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
