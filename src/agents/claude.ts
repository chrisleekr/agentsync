import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import { sanitizeClaudeHooks, sanitizeClaudeMcp, shouldNeverSync } from "../core/sanitizer";
import { extractArchive } from "../core/tar";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
} from "./_utils";
import { collectSkillArtifacts } from "./skills-walker";

/** Snapshot payload for the Claude adapter. */
export type ClaudeSnapshotResult = SnapshotResult;

/** Collect Claude files that are safe to store in the encrypted vault. */
export async function snapshotClaude(): Promise<SnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  const claudeMd = await readIfExists(AgentPaths.claude.claudeMd);
  if (claudeMd !== null) {
    artifacts.push({
      vaultPath: "claude/CLAUDE.md.age",
      sourcePath: AgentPaths.claude.claudeMd,
      plaintext: claudeMd,
      warnings: [],
    });
  }

  const settingsJson = await readIfExists(AgentPaths.claude.settingsJson);
  if (settingsJson !== null) {
    const hooks = sanitizeClaudeHooks(settingsJson);
    artifacts.push(
      collect(hooks, AgentPaths.claude.settingsJson, "claude/settings.hooks.json.age"),
    );
    warnings.push(...hooks.warnings);
  }

  const mcpJson = await readIfExists(AgentPaths.claude.mcpJson);
  if (mcpJson !== null) {
    const mcp = sanitizeClaudeMcp(mcpJson);
    artifacts.push(collect(mcp, AgentPaths.claude.mcpJson, "claude/claude.json.age"));
    warnings.push(...mcp.warnings);
  }

  try {
    const names = await readdir(AgentPaths.claude.commandsDir);
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const sourcePath = join(AgentPaths.claude.commandsDir, name);
      if (shouldNeverSync(sourcePath)) continue;
      let content: string;
      try {
        content = await readFile(sourcePath, "utf8");
      } catch {
        continue; // skip directories or unreadable entries
      }
      artifacts.push({
        vaultPath: `claude/commands/${name}.age`,
        sourcePath,
        plaintext: content,
        warnings: [],
      });
    }
  } catch {
    // commands dir may not exist yet.
  }

  try {
    const names = await readdir(AgentPaths.claude.agentsDir);
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const sourcePath = join(AgentPaths.claude.agentsDir, name);
      if (shouldNeverSync(sourcePath)) continue;
      let content: string;
      try {
        content = await readFile(sourcePath, "utf8");
      } catch {
        continue; // skip directories or unreadable entries
      }
      artifacts.push({
        vaultPath: `claude/agents/${name}.age`,
        sourcePath,
        plaintext: content,
        warnings: [],
      });
    }
  } catch {
    // agents dir may not exist yet.
  }

  // Skills — delegated to the shared walker (FR-001/FR-002/FR-006/FR-016/FR-017).
  // The walker handles dot-skip, symlink rejection, sentinel verification, the
  // never-sync interior scan, and the symlink-filtered tar archival in one
  // place so every skill-bearing agent inherits identical rules.
  const claudeSkills = await collectSkillArtifacts("claude", AgentPaths.claude.skillsDir);
  artifacts.push(...claudeSkills.artifacts);
  warnings.push(...claudeSkills.warnings);

  return { artifacts, warnings };
}

/**
 * Restore one Claude skill directory from the vault by extracting its
 * encrypted tar archive into `~/.claude/skills/<name>/`.
 *
 * Mirrors {@link applyCopilotSkill}: parents are created on demand and the
 * tar's interior layout is preserved bit-for-bit.
 *
 * @param skillName  Basename of the skill (no extension).
 * @param base64Tar  Base64-encoded `.tar.gz` payload that the walker
 *                   produced on the source machine.
 */
export async function applyClaudeSkill(skillName: string, base64Tar: string): Promise<void> {
  const targetDir = join(AgentPaths.claude.skillsDir, skillName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

/** Restore the shared CLAUDE.md prompt file from the vault. */
export async function applyClaudeMd(content: string): Promise<void> {
  await atomicWrite(AgentPaths.claude.claudeMd, content);
}

/** Merge synced Claude hooks back into the local settings file. */
export async function applyClaudeHooks(hooksJsonContent: string): Promise<void> {
  const existingRaw = await readIfExists(AgentPaths.claude.settingsJson);
  const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : {};
  const incoming = JSON.parse(hooksJsonContent) as Record<string, unknown>;
  existing.hooks = incoming.hooks ?? {};
  await atomicWrite(AgentPaths.claude.settingsJson, `${JSON.stringify(existing, null, 2)}\n`);
}

/** Merge synced Claude MCP servers back into the local Claude config file. */
export async function applyClaudeMcp(claudeJsonContent: string): Promise<void> {
  const existingRaw = await readIfExists(AgentPaths.claude.mcpJson);
  const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : {};
  const incoming = JSON.parse(claudeJsonContent) as Record<string, unknown>;
  existing.mcpServers = incoming.mcpServers ?? {};
  await atomicWrite(AgentPaths.claude.mcpJson, `${JSON.stringify(existing, null, 2)}\n`);
}

/** Preserve the previous command or agent file before overwrite during apply. */
export async function ensureCommandBackup(path: string): Promise<void> {
  try {
    await stat(path);
    await writeFile(`${path}.bak`, await readFile(path, "utf8"), "utf8");
  } catch {
    // No existing file to backup.
  }
}

/** Restore one Claude command markdown file from the vault. */
export async function applyClaudeCommand(commandName: string, content: string): Promise<void> {
  const target = join(AgentPaths.claude.commandsDir, commandName);
  await mkdir(AgentPaths.claude.commandsDir, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

/** Restore one Claude agent definition markdown file from the vault. */
export async function applyClaudeAgent(agentName: string, content: string): Promise<void> {
  const target = join(AgentPaths.claude.agentsDir, agentName);
  await mkdir(AgentPaths.claude.agentsDir, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { readdir as _readdir } from "node:fs/promises";
import { basename } from "node:path";
import { decryptString } from "../core/encryptor";

/** Read encrypted files from a vault subdirectory, ignoring missing directories. */
async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const names = await _readdir(dir);
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

/** Decrypt and apply all Claude vault artifacts to the local machine. */
export async function applyClaudeVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
): Promise<void> {
  const claudeDir = join(vaultDir, "claude");
  const files = await readAgeFiles(claudeDir);

  for (const { name, fullPath } of files) {
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);

    if (name === "CLAUDE.md.age") {
      if (dryRun) {
        log.info("[dry-run] [claude] would apply CLAUDE.md");
        continue;
      }
      await applyClaudeMd(decrypted);
    } else if (name === "settings.hooks.json.age") {
      if (dryRun) {
        log.info("[dry-run] [claude] would apply claude/settings.hooks.json");
        continue;
      }
      await applyClaudeHooks(decrypted);
    } else if (name === "claude.json.age") {
      if (dryRun) {
        log.info("[dry-run] [claude] would apply ~/.claude.json mcpServers");
        continue;
      }
      await applyClaudeMcp(decrypted);
    }
  }

  // Commands sub-directory
  const commandFiles = await readAgeFiles(join(claudeDir, "commands"));
  for (const { name, fullPath } of commandFiles) {
    if (!name.endsWith(".md.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const commandName = basename(name, ".age");
    if (dryRun) {
      log.info(`[dry-run] [claude] would write command: ${commandName}`);
    } else {
      await applyClaudeCommand(commandName, decrypted);
    }
  }

  // Agents sub-directory
  const agentFiles = await readAgeFiles(join(claudeDir, "agents"));
  for (const { name, fullPath } of agentFiles) {
    if (!name.endsWith(".md.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const agentName = basename(name, ".age");
    if (dryRun) {
      log.info(`[dry-run] [claude] would write agent: ${agentName}`);
    } else {
      await applyClaudeAgent(agentName, decrypted);
    }
  }

  // Skills sub-directory — stored as <name>.tar.age (FR-005). Mirrors the
  // Copilot apply path: each entry is decrypted, then the inner base64 tar
  // is extracted into ~/.claude/skills/<name>/ via applyClaudeSkill.
  const skillFiles = await readAgeFiles(join(claudeDir, "skills"));
  for (const { name, fullPath } of skillFiles) {
    if (!name.endsWith(".tar.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const skillName = basename(name, ".tar.age");
    if (dryRun) {
      log.info(`[dry-run] [claude] would extract skill: ${skillName}`);
      continue;
    }
    await applyClaudeSkill(skillName, decrypted);
  }
}
