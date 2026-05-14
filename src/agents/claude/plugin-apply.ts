/**
 * src/agents/claude-plugin-apply.ts
 *
 * Plugin-side apply functions for Claude. Split from `claude.ts` because the
 * plugin subsystem (manifest, command, agent, hook, mcp, skill, and the
 * vault-dir dispatcher) has no analogue in any other adapter — keeping it
 * adjacent to but separate from the general adapter shrinks `claude.ts`
 * and makes plugin changes reviewable in isolation.
 *
 * Push-side plugin discovery lives in `claude-plugins.ts`. Push-side
 * snapshot helpers (`collectPluginMarkdownDir` / `collectPluginHooksDir`)
 * stay inline inside `snapshotClaude` because they read from `artifacts`
 * and `warnings` arrays bound to the snapshot's closure.
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../../config/paths";
import { decryptString } from "../../core/encryptor";
import { denormalizeStringFromVault } from "../../core/path-portability";
import { extractArchive } from "../../core/tar";
import { atomicWrite, ensureCommandBackup } from "../_utils";
import { InvalidSkillNameError, validateSkillName } from "../skills-walker";
import { InvalidPluginNameError, validatePluginName } from "./plugins";

async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.endsWith(".age"))
      .map((name) => ({ name, fullPath: join(dir, name) }));
  } catch {
    return [];
  }
}

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
  await atomicWrite(target, denormalizeStringFromVault(content, homedir()));
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
  await atomicWrite(target, denormalizeStringFromVault(content, homedir()));
}

/** Restore one plugin's `.mcp.json`. */
export async function applyClaudePluginMcp(pluginName: string, content: string): Promise<void> {
  const root = pluginRootFor(pluginName);
  const target = join(root, ".mcp.json");
  await mkdir(root, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, denormalizeStringFromVault(content, homedir()));
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

/**
 * Walk the `claude/plugins/` vault sub-tree and route each artifact to the
 * matching apply helper. Plugin names from the vault are validated via
 * {@link validatePluginName} before any filesystem write so a crafted vault
 * cannot escape `~/.claude/plugins/`.
 */
export async function applyClaudePluginsDir(
  pluginsVaultDir: string,
  key: string,
  dryRun: boolean,
): Promise<void> {
  let pluginEntries: string[];
  try {
    pluginEntries = await readdir(pluginsVaultDir);
  } catch {
    return;
  }

  for (const pluginName of pluginEntries) {
    // Symmetric with the push-side walker (claude-plugins.ts): dot-prefixed
    // entries are ignorable noise (.gitkeep, .DS_Store), not adversarial. Skip
    // silently before validation so the warning channel stays reserved for
    // genuinely hostile names like `..`.
    if (pluginName.startsWith(".")) continue;
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
