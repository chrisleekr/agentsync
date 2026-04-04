import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import { sanitizeClaudeHooks, sanitizeClaudeMcp, shouldNeverSync } from "../core/sanitizer";
import { atomicWrite, collect, readIfExists, type SnapshotArtifact } from "./_utils";

export interface ClaudeSnapshotResult {
  artifacts: SnapshotArtifact[];
  warnings: string[];
}

export async function snapshotClaude(): Promise<ClaudeSnapshotResult> {
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

  return { artifacts, warnings };
}

export async function applyClaudeMd(content: string): Promise<void> {
  await atomicWrite(AgentPaths.claude.claudeMd, content);
}

export async function applyClaudeHooks(hooksJsonContent: string): Promise<void> {
  const existingRaw = await readIfExists(AgentPaths.claude.settingsJson);
  const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : {};
  const incoming = JSON.parse(hooksJsonContent) as Record<string, unknown>;
  existing.hooks = incoming.hooks ?? {};
  await atomicWrite(AgentPaths.claude.settingsJson, `${JSON.stringify(existing, null, 2)}\n`);
}

export async function applyClaudeMcp(claudeJsonContent: string): Promise<void> {
  const existingRaw = await readIfExists(AgentPaths.claude.mcpJson);
  const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : {};
  const incoming = JSON.parse(claudeJsonContent) as Record<string, unknown>;
  existing.mcpServers = incoming.mcpServers ?? {};
  await atomicWrite(AgentPaths.claude.mcpJson, `${JSON.stringify(existing, null, 2)}\n`);
}

export async function ensureCommandBackup(path: string): Promise<void> {
  try {
    await stat(path);
    await writeFile(`${path}.bak`, await readFile(path, "utf8"), "utf8");
  } catch {
    // No existing file to backup.
  }
}

export async function applyClaudeCommand(commandName: string, content: string): Promise<void> {
  const target = join(AgentPaths.claude.commandsDir, commandName);
  await mkdir(AgentPaths.claude.commandsDir, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

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

async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const entries = await _readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".age"))
      .map((e) => ({ name: e.name, fullPath: join(dir, e.name) }));
  } catch {
    return [];
  }
}

/**
 * Decrypt and apply all Claude vault artifacts to the local machine.
 * This is the counterpart to `snapshotClaude()` and drives the pull pipeline.
 */
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
}
