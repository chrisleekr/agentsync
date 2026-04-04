import { mkdir, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { resolveAgentSyncHome } from "../config/paths";

export interface RuntimeContext {
  vaultDir: string;
  privateKeyPath: string;
  machineName: string;
}

export async function resolveRuntimeContext(): Promise<RuntimeContext> {
  const baseDir = resolveAgentSyncHome();
  await mkdir(baseDir, { recursive: true });

  return {
    vaultDir: process.env.AGENTSYNC_VAULT_DIR ?? join(baseDir, "vault"),
    privateKeyPath: process.env.AGENTSYNC_KEY_PATH ?? join(baseDir, "key.txt"),
    // AGENTSYNC_MACHINE env var > HOSTNAME env var > os.hostname() > static fallback
    machineName:
      process.env.AGENTSYNC_MACHINE ?? process.env.HOSTNAME ?? hostname() ?? "local-machine",
  };
}

export async function loadPrivateKey(path: string): Promise<string> {
  const key = await readFile(path, "utf8");
  return key.trim();
}
