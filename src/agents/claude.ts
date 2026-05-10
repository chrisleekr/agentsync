import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import {
  redactSecretLiterals,
  sanitizeClaudeHooks,
  sanitizeClaudeMcp,
  sanitizeClaudePluginManifest,
  sanitizeClaudePluginMcp,
  shouldNeverSync,
} from "../core/sanitizer";
import { extractArchive } from "../core/tar";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
} from "./_utils";
import { collectClaudePlugins, InvalidPluginNameError, validatePluginName } from "./claude-plugins";
import { collectSkillArtifacts, InvalidSkillNameError, validateSkillName } from "./skills-walker";

/** Options that gate optional Claude surfaces (the marketplace catalog today). */
export interface ClaudeSyncOptions {
  /** Sync `~/.claude/.claude-plugin/marketplace.json` when the user opts in. */
  syncMarketplace?: boolean;
}

/** Snapshot payload for the Claude adapter. */
export type ClaudeSnapshotResult = SnapshotResult;

/** Collect Claude files that are safe to store in the encrypted vault. */
export async function snapshotClaude(options: ClaudeSyncOptions = {}): Promise<SnapshotResult> {
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

  // Claude Code plugin bundles (issue #31). Each discovered plugin contributes
  // a manifest plus optional commands/agents/hooks/.mcp.json/skills artifacts
  // under the `claude/plugins/<plugin-name>/...` vault namespace. Discovery
  // gates (manifest sentinel, dot-skip, symlink rejection) live in
  // `collectClaudePlugins`; everything below is purely additive collection
  // that reuses the existing encryption pipeline.
  const plugins = await collectClaudePlugins(AgentPaths.claude.pluginsDir);
  for (const plugin of plugins) {
    const ns = `claude/plugins/${plugin.name}`;

    const manifestRaw = await readIfExists(plugin.paths.manifest);
    if (manifestRaw !== null && !shouldNeverSync(plugin.paths.manifest)) {
      try {
        const manifest = sanitizeClaudePluginManifest(manifestRaw);
        artifacts.push(collect(manifest, plugin.paths.manifest, `${ns}/plugin.json.age`));
        warnings.push(...manifest.warnings);
      } catch (err) {
        warnings.push(
          `[claude] Skipping plugin '${plugin.name}' manifest — invalid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    await collectPluginMarkdownDir(plugin.paths.commandsDir, `${ns}/commands`, artifacts, warnings);
    await collectPluginMarkdownDir(plugin.paths.agentsDir, `${ns}/agents`, artifacts, warnings);
    await collectPluginHooksDir(plugin.paths.hooksDir, `${ns}/hooks`, artifacts, warnings);

    const pluginMcpRaw = await readIfExists(plugin.paths.mcpJson);
    if (pluginMcpRaw !== null && !shouldNeverSync(plugin.paths.mcpJson)) {
      try {
        const pluginMcp = sanitizeClaudePluginMcp(pluginMcpRaw);
        artifacts.push(collect(pluginMcp, plugin.paths.mcpJson, `${ns}/mcp.json.age`));
        warnings.push(...pluginMcp.warnings);
      } catch (err) {
        warnings.push(
          `[claude] Skipping plugin '${plugin.name}' .mcp.json — invalid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // Plugin-local skills inherit every gate the shared walker enforces. The
    // namespace mirrors the per-plugin layout so a vault's plugin tree is
    // self-contained and removable as a unit.
    const pluginSkills = await collectSkillArtifacts("claude", plugin.paths.skillsDir);
    for (const art of pluginSkills.artifacts) {
      // Re-namespace under the plugin so the artifact lives at
      // claude/plugins/<plugin>/skills/<skill>.tar.age instead of the global
      // claude/skills/<skill>.tar.age slot.
      const skillBase = art.vaultPath.replace(/^claude\/skills\//, "");
      artifacts.push({ ...art, vaultPath: `${ns}/skills/${skillBase}` });
    }
    warnings.push(...pluginSkills.warnings);
  }

  // Optional marketplace catalog (`~/.claude/.claude-plugin/marketplace.json`).
  // Off by default — teams have to opt in via `claudePlugins.syncMarketplace`
  // because the catalog can pin third-party sources that not every team wants
  // to standardize on through the vault.
  if (options.syncMarketplace === true) {
    const marketplaceRaw = await readIfExists(AgentPaths.claude.marketplaceJson);
    if (marketplaceRaw !== null && !shouldNeverSync(AgentPaths.claude.marketplaceJson)) {
      try {
        const parsed = JSON.parse(marketplaceRaw) as unknown;
        const redacted = redactSecretLiterals(parsed, "marketplace");
        artifacts.push({
          vaultPath: "claude/marketplace.json.age",
          sourcePath: AgentPaths.claude.marketplaceJson,
          plaintext: `${JSON.stringify(redacted.value, null, 2)}\n`,
          warnings: redacted.warnings,
        });
        warnings.push(...redacted.warnings);
      } catch (err) {
        warnings.push(
          `[claude] Skipping marketplace.json — invalid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  return { artifacts, warnings };
}

/**
 * Collect markdown files (commands or agents) from a plugin sub-directory.
 * Mirrors the top-level Claude collection loop: non-recursive, `*.md` only,
 * never-sync paths skipped, unreadable entries silently dropped.
 */
async function collectPluginMarkdownDir(
  dir: string,
  vaultPrefix: string,
  artifacts: SnapshotArtifact[],
  _warnings: string[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const sourcePath = join(dir, name);
    if (shouldNeverSync(sourcePath)) continue;
    let content: string;
    try {
      content = await readFile(sourcePath, "utf8");
    } catch {
      continue;
    }
    artifacts.push({
      vaultPath: `${vaultPrefix}/${name}.age`,
      sourcePath,
      plaintext: content,
      warnings: [],
    });
  }
}

/**
 * Collect `*.json` hook bundles from a plugin sub-directory. Each hook bundle
 * is sanitized with `redactSecretLiterals` while preserving its full shape —
 * unlike the user-level `settings.json` flow which keeps only `{ hooks }`.
 */
async function collectPluginHooksDir(
  dir: string,
  vaultPrefix: string,
  artifacts: SnapshotArtifact[],
  warnings: string[],
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const sourcePath = join(dir, name);
    if (shouldNeverSync(sourcePath)) continue;
    let raw: string;
    try {
      raw = await readFile(sourcePath, "utf8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const redacted = redactSecretLiterals(parsed, "pluginHook");
      artifacts.push({
        vaultPath: `${vaultPrefix}/${name}.age`,
        sourcePath,
        plaintext: `${JSON.stringify(redacted.value, null, 2)}\n`,
        warnings: redacted.warnings,
      });
      warnings.push(...redacted.warnings);
    } catch (err) {
      warnings.push(
        `[claude] Skipping plugin hook ${sourcePath} — invalid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
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
  validateSkillName(skillName);
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

// ─── Claude plugin apply helpers (issue #31) ─────────────────────────────────

/**
 * Build the absolute plugin root path after validating the plugin name.
 * Centralised so every plugin apply helper goes through the same trust check
 * before any filesystem write.
 */
function pluginRootFor(pluginName: string): string {
  validatePluginName(pluginName);
  return join(AgentPaths.claude.pluginsDir, pluginName);
}

/** Restore one plugin's `.claude-plugin/plugin.json` manifest. */
export async function applyClaudePluginManifest(
  pluginName: string,
  content: string,
): Promise<void> {
  const root = pluginRootFor(pluginName);
  const target = join(root, ".claude-plugin", "plugin.json");
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

/** Restore one plugin-local command markdown file. */
export async function applyClaudePluginCommand(
  pluginName: string,
  fileName: string,
  content: string,
): Promise<void> {
  const root = pluginRootFor(pluginName);
  const dir = join(root, "commands");
  const target = join(dir, fileName);
  await mkdir(dir, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

/** Restore one plugin-local agent markdown file. */
export async function applyClaudePluginAgent(
  pluginName: string,
  fileName: string,
  content: string,
): Promise<void> {
  const root = pluginRootFor(pluginName);
  const dir = join(root, "agents");
  const target = join(dir, fileName);
  await mkdir(dir, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

/** Restore one plugin-local hook bundle JSON file. */
export async function applyClaudePluginHook(
  pluginName: string,
  fileName: string,
  content: string,
): Promise<void> {
  const root = pluginRootFor(pluginName);
  const dir = join(root, "hooks");
  const target = join(dir, fileName);
  await mkdir(dir, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

/** Restore one plugin's `.mcp.json`. */
export async function applyClaudePluginMcp(pluginName: string, content: string): Promise<void> {
  const root = pluginRootFor(pluginName);
  const target = join(root, ".mcp.json");
  await mkdir(root, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

/** Restore one plugin-local skill tar archive into the plugin's skills dir. */
export async function applyClaudePluginSkill(
  pluginName: string,
  skillName: string,
  base64Tar: string,
): Promise<void> {
  const root = pluginRootFor(pluginName);
  validateSkillName(skillName);
  const targetDir = join(root, "skills", skillName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

/** Restore the optional Claude marketplace catalog. */
export async function applyClaudeMarketplace(content: string): Promise<void> {
  const target = AgentPaths.claude.marketplaceJson;
  await mkdir(join(target, ".."), { recursive: true });
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
  options: ClaudeSyncOptions = {},
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
    } else if (name === "marketplace.json.age") {
      // Symmetric to the snapshot side: only apply when the user has opted in.
      // A vault that contains a marketplace.json.age is silently ignored on
      // any machine where syncMarketplace is not set, so opting out is the
      // safe default and never blocks pulls.
      if (options.syncMarketplace !== true) {
        continue;
      }
      if (dryRun) {
        log.info("[dry-run] [claude] would apply ~/.claude/.claude-plugin/marketplace.json");
        continue;
      }
      await applyClaudeMarketplace(decrypted);
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
    const skillName = basename(name, ".tar.age");
    try {
      validateSkillName(skillName);
    } catch (err) {
      if (err instanceof InvalidSkillNameError) {
        log.warn(`[claude] Skipping vault skill with invalid name '${name}': ${err.reason}`);
        continue;
      }
      throw err;
    }
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    if (dryRun) {
      log.info(`[dry-run] [claude] would extract skill: ${skillName}`);
      continue;
    }
    await applyClaudeSkill(skillName, decrypted);
  }

  // Plugins sub-tree (issue #31). Vault layout:
  //   claude/plugins/<plugin>/plugin.json.age
  //   claude/plugins/<plugin>/commands/<file>.md.age
  //   claude/plugins/<plugin>/agents/<file>.md.age
  //   claude/plugins/<plugin>/hooks/<file>.json.age
  //   claude/plugins/<plugin>/mcp.json.age
  //   claude/plugins/<plugin>/skills/<skill>.tar.age
  await applyClaudePluginsDir(join(claudeDir, "plugins"), key, dryRun);
}

/**
 * Walk the `claude/plugins/` vault sub-tree and route each artifact to the
 * matching apply helper. Plugin names from the vault are validated via
 * {@link validatePluginName} before any filesystem write so a crafted vault
 * cannot escape `~/.claude/plugins/`.
 */
async function applyClaudePluginsDir(
  pluginsVaultDir: string,
  key: string,
  dryRun: boolean,
): Promise<void> {
  let pluginEntries: string[];
  try {
    pluginEntries = await _readdir(pluginsVaultDir);
  } catch {
    return;
  }

  for (const pluginName of pluginEntries) {
    try {
      validatePluginName(pluginName);
    } catch (err) {
      if (err instanceof InvalidPluginNameError) {
        log.warn(`[claude] Skipping vault plugin with invalid name '${pluginName}': ${err.reason}`);
        continue;
      }
      throw err;
    }

    const pluginVaultRoot = join(pluginsVaultDir, pluginName);

    // Top-level plugin artifacts (manifest, mcp.json).
    const topFiles = await readAgeFiles(pluginVaultRoot);
    for (const { name, fullPath } of topFiles) {
      const encrypted = await readFile(fullPath, "utf8");
      const decrypted = await decryptString(encrypted, key);

      if (name === "plugin.json.age") {
        if (dryRun) {
          log.info(`[dry-run] [claude] would apply plugin manifest: ${pluginName}`);
        } else {
          await applyClaudePluginManifest(pluginName, decrypted);
        }
      } else if (name === "mcp.json.age") {
        if (dryRun) {
          log.info(`[dry-run] [claude] would apply plugin .mcp.json: ${pluginName}`);
        } else {
          await applyClaudePluginMcp(pluginName, decrypted);
        }
      }
    }

    // commands/*.md.age
    for (const { name, fullPath } of await readAgeFiles(join(pluginVaultRoot, "commands"))) {
      if (!name.endsWith(".md.age")) continue;
      const encrypted = await readFile(fullPath, "utf8");
      const decrypted = await decryptString(encrypted, key);
      const fileName = basename(name, ".age");
      if (dryRun) {
        log.info(`[dry-run] [claude] would write plugin command: ${pluginName}/${fileName}`);
      } else {
        await applyClaudePluginCommand(pluginName, fileName, decrypted);
      }
    }

    // agents/*.md.age
    for (const { name, fullPath } of await readAgeFiles(join(pluginVaultRoot, "agents"))) {
      if (!name.endsWith(".md.age")) continue;
      const encrypted = await readFile(fullPath, "utf8");
      const decrypted = await decryptString(encrypted, key);
      const fileName = basename(name, ".age");
      if (dryRun) {
        log.info(`[dry-run] [claude] would write plugin agent: ${pluginName}/${fileName}`);
      } else {
        await applyClaudePluginAgent(pluginName, fileName, decrypted);
      }
    }

    // hooks/*.json.age
    for (const { name, fullPath } of await readAgeFiles(join(pluginVaultRoot, "hooks"))) {
      if (!name.endsWith(".json.age")) continue;
      const encrypted = await readFile(fullPath, "utf8");
      const decrypted = await decryptString(encrypted, key);
      const fileName = basename(name, ".age");
      if (dryRun) {
        log.info(`[dry-run] [claude] would write plugin hook: ${pluginName}/${fileName}`);
      } else {
        await applyClaudePluginHook(pluginName, fileName, decrypted);
      }
    }

    // skills/<skill>.tar.age
    for (const { name, fullPath } of await readAgeFiles(join(pluginVaultRoot, "skills"))) {
      if (!name.endsWith(".tar.age")) continue;
      const skillName = basename(name, ".tar.age");
      try {
        validateSkillName(skillName);
      } catch (err) {
        if (err instanceof InvalidSkillNameError) {
          log.warn(
            `[claude] Skipping plugin '${pluginName}' skill with invalid name '${name}': ${err.reason}`,
          );
          continue;
        }
        throw err;
      }
      const encrypted = await readFile(fullPath, "utf8");
      const decrypted = await decryptString(encrypted, key);
      if (dryRun) {
        log.info(`[dry-run] [claude] would extract plugin skill: ${pluginName}/${skillName}`);
        continue;
      }
      await applyClaudePluginSkill(pluginName, skillName, decrypted);
    }
  }
}
