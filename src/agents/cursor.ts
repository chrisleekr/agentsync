import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import { redactSecretLiterals, shouldNeverSync } from "../core/sanitizer";
import { type SnapshotArtifact, atomicWrite, collect, readIfExists } from "./_utils";

export interface CursorSnapshotResult {
  artifacts: SnapshotArtifact[];
  warnings: string[];
}

/**
 * Read the Cursor global `rules` field from its Electron settings.json.
 * Only the `rules` string is synced — the full settings.json is never written to the vault.
 */
async function readCursorRules(): Promise<string | null> {
  const raw = await readIfExists(AgentPaths.cursor.settingsJson);
  if (raw === null) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rules = parsed.rules;
    if (typeof rules !== "string") return null;
    return rules;
  } catch {
    return null;
  }
}

export async function snapshotCursor(): Promise<CursorSnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  const rules = await readCursorRules();
  if (rules !== null) {
    artifacts.push({
      vaultPath: "cursor/user-rules.md.age",
      sourcePath: AgentPaths.cursor.settingsJson,
      plaintext: rules,
      warnings: [],
    });
  }

  const mcpRaw = await readIfExists(AgentPaths.cursor.mcpGlobal);
  if (mcpRaw !== null) {
    const redacted = redactSecretLiterals(
      JSON.parse(mcpRaw) as Record<string, unknown>,
      "cursor_mcp",
    );
    const artifact = collect(
      {
        value: `${JSON.stringify(redacted.value, null, 2)}\n`,
        warnings: redacted.warnings,
      },
      AgentPaths.cursor.mcpGlobal,
      "cursor/mcp.json.age",
    );
    artifacts.push(artifact);
    warnings.push(...redacted.warnings);
  }

  try {
    const entries = await readdir(AgentPaths.cursor.commandsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const sourcePath = join(AgentPaths.cursor.commandsDir, entry.name);
      if (shouldNeverSync(sourcePath)) {
        continue;
      }
      const content = await readFile(sourcePath, "utf8");
      artifacts.push({
        vaultPath: `cursor/commands/${entry.name}.age`,
        sourcePath,
        plaintext: content,
        warnings: [],
      });
    }
  } catch {
    // commands dir may not exist yet.
  }

  return { artifacts, warnings };
}

/**
 * Apply the synced `rules` value back into Cursor's settings.json.
 * Only the `rules` field is merged — the rest of the settings are preserved.
 * Atomic write ensures a partial write never corrupts the file.
 */
export async function applyCursorRules(rulesContent: string): Promise<void> {
  const raw = await readIfExists(AgentPaths.cursor.settingsJson);
  const settings: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  settings.rules = rulesContent;
  await atomicWrite(AgentPaths.cursor.settingsJson, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Apply the synced Cursor MCP config back to ~/.cursor/mcp.json.
 */
export async function applyCursorMcp(mcpJsonContent: string): Promise<void> {
  await atomicWrite(AgentPaths.cursor.mcpGlobal, mcpJsonContent);
}

export async function applyCursorCommand(commandName: string, content: string): Promise<void> {
  const target = join(AgentPaths.cursor.commandsDir, commandName);
  await mkdir(AgentPaths.cursor.commandsDir, { recursive: true });
  await atomicWrite(target, content);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { decryptString } from "../core/encryptor";

async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".age"))
      .map((e) => ({ name: e.name, fullPath: join(dir, e.name) }));
  } catch {
    return [];
  }
}

/**
 * Decrypt and apply all Cursor vault artifacts to the local machine.
 */
export async function applyCursorVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
): Promise<void> {
  const cursorDir = join(vaultDir, "cursor");
  const files = await readAgeFiles(cursorDir);

  for (const { name, fullPath } of files) {
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);

    if (name === "user-rules.md.age") {
      if (dryRun) {
        log.info("[dry-run] [cursor] would apply user-rules");
        continue;
      }
      await applyCursorRules(decrypted);
    } else if (name === "mcp.json.age") {
      if (dryRun) {
        log.info("[dry-run] [cursor] would apply mcp.json");
        continue;
      }
      await applyCursorMcp(decrypted);
    }
  }

  // Commands sub-directory
  const commandFiles = await readAgeFiles(join(cursorDir, "commands"));
  for (const { name, fullPath } of commandFiles) {
    if (!name.endsWith(".md.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const commandName = basename(name, ".age");
    if (dryRun) {
      log.info(`[dry-run] [cursor] would write command: ${commandName}`);
    } else {
      await applyCursorCommand(commandName, decrypted);
    }
  }
}
