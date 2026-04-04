import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "@iarna/toml";
import { type AgentSyncConfig, AgentSyncConfigSchema } from "./schema";

export async function loadConfig(configPath: string): Promise<AgentSyncConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = parse(raw) as unknown;
  // @iarna/toml attaches Symbol(type) and Symbol(declared) to every parsed table.
  // Zod v4 z.record() uses Reflect.ownKeys() which includes Symbol keys, causing
  // ZodError 'invalid_key'. structuredClone() strips Symbol-keyed properties.
  return AgentSyncConfigSchema.parse(structuredClone(parsed));
}

export async function writeConfig(configPath: string, config: AgentSyncConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const serialized = stringify(config as unknown as Parameters<typeof stringify>[0]);
  await writeFile(configPath, serialized, "utf8");
}

export function resolveConfigPath(vaultDir: string): string {
  return join(vaultDir, "agentsync.toml");
}
