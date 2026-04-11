import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import { redactSecretLiterals, shouldNeverSync } from "../core/sanitizer";
import { extractArchive } from "../core/tar";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
} from "./_utils";
import { collectSkillArtifacts } from "./skills-walker";

/** Snapshot payload for the Cursor adapter. */
export type CursorSnapshotResult = SnapshotResult;

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

/** Collect Cursor rules, MCP config, and commands that are safe to sync. */
export async function snapshotCursor(): Promise<SnapshotResult> {
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
    const names = await readdir(AgentPaths.cursor.commandsDir);
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const sourcePath = join(AgentPaths.cursor.commandsDir, name);
      if (shouldNeverSync(sourcePath)) continue;
      let content: string;
      try {
        content = await readFile(sourcePath, "utf8");
      } catch {
        continue; // skip directories or unreadable entries
      }
      artifacts.push({
        vaultPath: `cursor/commands/${name}.age`,
        sourcePath,
        plaintext: content,
        warnings: [],
      });
    }
  } catch {
    // commands dir may not exist yet.
  }

  // Skills — delegated to the shared walker. The walker is pointed at
  // `AgentPaths.cursor.skillsDir` which resolves to `~/.cursor/skills/` —
  // the FR-010 canonical path. The bundled `~/.cursor/skills-cursor/`
  // directory is NEVER read because `paths.ts` does not expose it and the
  // walker is not given a pointer to it, so there is no code path through
  // which vendor bundles can leak into the vault.
  const cursorSkills = await collectSkillArtifacts("cursor", AgentPaths.cursor.skillsDir);
  artifacts.push(...cursorSkills.artifacts);
  warnings.push(...cursorSkills.warnings);

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

/** Restore one Cursor command markdown file from the vault. */
export async function applyCursorCommand(commandName: string, content: string): Promise<void> {
  const target = join(AgentPaths.cursor.commandsDir, commandName);
  await mkdir(AgentPaths.cursor.commandsDir, { recursive: true });
  await atomicWrite(target, content);
}

/**
 * Restore one Cursor skill directory from the vault by extracting its
 * encrypted tar archive into `~/.cursor/skills/<name>/` — NEVER into the
 * bundled `~/.cursor/skills-cursor/` path (FR-010).
 *
 * Mirrors {@link applyClaudeSkill}: parents are created on demand and the
 * tar's interior layout is preserved bit-for-bit.
 *
 * @param skillName  Basename of the skill (no extension).
 * @param base64Tar  Base64-encoded `.tar.gz` payload that the walker
 *                   produced on the source machine.
 */
export async function applyCursorSkill(skillName: string, base64Tar: string): Promise<void> {
  const targetDir = join(AgentPaths.cursor.skillsDir, skillName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { decryptString } from "../core/encryptor";

/** Read encrypted files from a vault subdirectory, ignoring missing directories. */
async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
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

/** Decrypt and apply all Cursor vault artifacts to the local machine. */
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
    } else {
      log.warn(`[cursor] Unrecognised vault file skipped: ${name}`);
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

  // Skills sub-directory — stored as <name>.tar.age (FR-005). Mirrors the
  // Claude/Codex/Copilot apply path: each entry is decrypted, then the inner
  // base64 tar is extracted into ~/.cursor/skills/<name>/ via applyCursorSkill.
  // The top-level unrecognised-file warning above is inspecting only top-level
  // cursor/*.age files, so cursor/skills/*.tar.age never triggers it.
  const skillFiles = await readAgeFiles(join(cursorDir, "skills"));
  for (const { name, fullPath } of skillFiles) {
    if (!name.endsWith(".tar.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const skillName = basename(name, ".tar.age");
    if (dryRun) {
      log.info(`[dry-run] [cursor] would extract skill: ${skillName}`);
      continue;
    }
    await applyCursorSkill(skillName, decrypted);
  }
}
