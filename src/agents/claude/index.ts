import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import { denormalizeFromVault, denormalizeStringFromVault } from "../../core/path-portability";
import { sanitizeAndNormalizeJson, shouldNeverSync } from "../../core/sanitizer";
import { extractArchive } from "../../core/tar";
import {
  atomicWrite,
  collect,
  ensureCommandBackup,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
  setJsoncTopLevelKey,
} from "../_utils";
import { collectSkillArtifacts, InvalidSkillNameError, validateSkillName } from "../skills-walker";
import { applyClaudePluginsDir } from "./plugin-apply";
import { collectClaudePlugins } from "./plugins";
import {
  sanitizeClaudeHooks,
  sanitizeClaudeMcp,
  sanitizeClaudePluginManifest,
  sanitizeClaudePluginMcp,
} from "./sanitize";

/** Snapshot payload for the Claude adapter. */
export type ClaudeSnapshotResult = SnapshotResult;

/** Collect Claude files that are safe to store in the encrypted vault. */
export async function snapshotClaude(config: AgentSyncConfig): Promise<SnapshotResult> {
  const syncMarketplace = config.claudePlugins?.syncMarketplace ?? false;
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
    const hooks = sanitizeClaudeHooks(settingsJson, homedir());
    artifacts.push(
      collect(hooks, AgentPaths.claude.settingsJson, "claude/settings.hooks.json.age"),
    );
    warnings.push(...hooks.warnings);
  }

  const mcpJson = await readIfExists(AgentPaths.claude.mcpJson);
  if (mcpJson !== null) {
    const mcp = sanitizeClaudeMcp(mcpJson, homedir());
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

  // Rules markdown at ~/.claude/rules/*.md is referenced from CLAUDE.md via
  // include directives, so the files must travel with the agent config or the
  // includes break on the destination machine. Use withFileTypes + symlink
  // rejection so a `rules/secret.md → /etc/passwd` symlink can't smuggle
  // arbitrary file content into the encrypted vault — readFile would follow
  // it and shouldNeverSync only sees the symlink path.
  try {
    const entries = await readdir(AgentPaths.claude.rulesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const name = entry.name;
      if (!name.endsWith(".md")) continue;
      const sourcePath = join(AgentPaths.claude.rulesDir, name);
      if (shouldNeverSync(sourcePath)) continue;
      let content: string;
      try {
        content = await readFile(sourcePath, "utf8");
      } catch {
        continue;
      }
      artifacts.push({
        vaultPath: `claude/rules/${name}.age`,
        sourcePath,
        plaintext: content,
        warnings: [],
      });
    }
  } catch {
    // rules dir may not exist yet.
  }

  // Skills — delegated to the shared walker.
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
        const manifest = sanitizeClaudePluginManifest(manifestRaw, homedir());
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

    await collectPluginMarkdownDir(plugin.paths.commandsDir, `${ns}/commands`, artifacts);
    await collectPluginMarkdownDir(plugin.paths.agentsDir, `${ns}/agents`, artifacts);
    await collectPluginHooksDir(plugin.paths.hooksDir, `${ns}/hooks`, artifacts, warnings);

    const pluginMcpRaw = await readIfExists(plugin.paths.mcpJson);
    if (pluginMcpRaw !== null && !shouldNeverSync(plugin.paths.mcpJson)) {
      try {
        const pluginMcp = sanitizeClaudePluginMcp(pluginMcpRaw, homedir());
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
  if (syncMarketplace) {
    const marketplaceRaw = await readIfExists(AgentPaths.claude.marketplaceJson);
    if (marketplaceRaw !== null && !shouldNeverSync(AgentPaths.claude.marketplaceJson)) {
      try {
        const sanitized = sanitizeAndNormalizeJson(marketplaceRaw, "marketplace");
        artifacts.push({
          vaultPath: "claude/marketplace.json.age",
          sourcePath: AgentPaths.claude.marketplaceJson,
          plaintext: sanitized.value,
          warnings: sanitized.warnings,
        });
        warnings.push(...sanitized.warnings);
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
      const sanitized = sanitizeAndNormalizeJson(raw, "pluginHook");
      artifacts.push({
        vaultPath: `${vaultPrefix}/${name}.age`,
        sourcePath,
        plaintext: sanitized.value,
        warnings: sanitized.warnings,
      });
      warnings.push(...sanitized.warnings);
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
  const home = homedir();
  const existingRaw = await readIfExists(AgentPaths.claude.settingsJson);
  // Vault content was re-serialized as clean JSON on snapshot, so parsing it
  // strict is safe. The local settings.json is JSONC — edit the `hooks` key in
  // place so a trailing comma elsewhere does not abort the pull.
  const incoming = JSON.parse(hooksJsonContent) as Record<string, unknown>;
  // Denormalize only the incoming subset — local-only keys must not be touched
  // because they were never normalized on snapshot and any `$` in their values
  // is literal.
  const hooks = denormalizeFromVault(incoming.hooks ?? {}, home);
  await atomicWrite(
    AgentPaths.claude.settingsJson,
    setJsoncTopLevelKey(existingRaw ?? "", "hooks", hooks),
  );
}

/** Merge synced Claude MCP servers back into the local Claude config file. */
export async function applyClaudeMcp(claudeJsonContent: string): Promise<void> {
  const home = homedir();
  const existingRaw = await readIfExists(AgentPaths.claude.mcpJson);
  const incoming = JSON.parse(claudeJsonContent) as Record<string, unknown>;
  // ~/.claude.json is large and JSONC-tolerant. Edit `mcpServers` in place so
  // the rest of Claude's config (and any trailing comma) is left untouched.
  const mcpServers = denormalizeFromVault(incoming.mcpServers ?? {}, home);
  await atomicWrite(
    AgentPaths.claude.mcpJson,
    setJsoncTopLevelKey(existingRaw ?? "", "mcpServers", mcpServers),
  );
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

/** Restore one Claude rule markdown file from the vault. */
export async function applyClaudeRule(ruleName: string, content: string): Promise<void> {
  const target = join(AgentPaths.claude.rulesDir, ruleName);
  await mkdir(AgentPaths.claude.rulesDir, { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, content);
}

// ─── Claude plugin apply helpers (issue #31) ─────────────────────────────────

/** Restore the optional Claude marketplace catalog. */
export async function applyClaudeMarketplace(content: string): Promise<void> {
  const target = AgentPaths.claude.marketplaceJson;
  await mkdir(join(target, ".."), { recursive: true });
  await ensureCommandBackup(target);
  await atomicWrite(target, denormalizeStringFromVault(content, homedir()));
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { type ApplyPlan, defineFileArtifact, runApplyPlan } from "../_apply";

/** Build the Claude apply plan. Exposed so `copy` can apply a single artifact. */
export function buildClaudePlan(config: AgentSyncConfig): ApplyPlan {
  const syncMarketplace = config.claudePlugins?.syncMarketplace ?? false;
  return {
    agent: "claude",
    directives: [
      defineFileArtifact({
        vaultName: "CLAUDE.md.age",
        dryRunLabel: "[dry-run] [claude] would apply CLAUDE.md",
        apply: applyClaudeMd,
      }),
      defineFileArtifact({
        vaultName: "settings.hooks.json.age",
        dryRunLabel: "[dry-run] [claude] would apply claude/settings.hooks.json",
        apply: applyClaudeHooks,
      }),
      defineFileArtifact({
        vaultName: "claude.json.age",
        dryRunLabel: "[dry-run] [claude] would apply ~/.claude.json mcpServers",
        apply: applyClaudeMcp,
      }),
      defineFileArtifact({
        vaultName: "marketplace.json.age",
        dryRunLabel: "[dry-run] [claude] would apply ~/.claude/.claude-plugin/marketplace.json",
        apply: applyClaudeMarketplace,
        // Symmetric to snapshot: opting out silently ignores a vault entry on
        // machines that haven't enabled syncMarketplace.
        enabled: () => syncMarketplace,
      }),
      {
        kind: "dir",
        subdir: "commands",
        suffix: ".age",
        dryRunVerb: "would write command:",
        apply: applyClaudeCommand,
      },
      {
        kind: "dir",
        subdir: "agents",
        suffix: ".age",
        dryRunVerb: "would write agent:",
        apply: applyClaudeAgent,
      },
      {
        kind: "dir",
        subdir: "rules",
        suffix: ".age",
        dryRunVerb: "would write rule:",
        apply: applyClaudeRule,
      },
      {
        kind: "dir",
        subdir: "skills",
        suffix: ".tar.age",
        dryRunVerb: "would extract skill:",
        apply: applyClaudeSkill,
        filter: (name) => {
          try {
            validateSkillName(name);
            return null;
          } catch (err) {
            if (err instanceof InvalidSkillNameError) {
              return { reason: `invalid skill name — ${err.reason}` };
            }
            throw err;
          }
        },
      },
      {
        kind: "custom",
        // Plugins live in a nested per-plugin tree (commands/, agents/, hooks/,
        // mcp.json, skills/) so they don't fit the file/dir directive shape.
        run: (agentVaultDir, decKey, dry) =>
          applyClaudePluginsDir(join(agentVaultDir, "plugins"), decKey, dry),
      },
    ],
  };
}

/** Decrypt and apply all Claude vault artifacts to the local machine. */
export async function applyClaudeVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
  config: AgentSyncConfig,
): Promise<void> {
  await runApplyPlan(buildClaudePlan(config), vaultDir, key, dryRun);
}
