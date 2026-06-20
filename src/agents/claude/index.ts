import { homedir } from "node:os";
import { AgentPaths } from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import { denormalizeFromVault } from "../../core/path-portability";
import { securityToPolicy } from "../../core/sanitizer";
import {
  type ApplyPlan,
  defineFileArtifact,
  dirWriteApplier,
  makeApplyVault,
  skillNameFilter,
} from "../_apply";
import { collectMarkdownDir, collectSingleFile } from "../_snapshot";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
  setJsoncTopLevelKey,
} from "../_utils";
import { applySkillArchive, collectSkillArtifacts } from "../skills-walker";
import { buildPluginManifest, serializeManifest } from "./plugin-manifest";
import { sanitizeClaudeHooks, sanitizeClaudeMcp } from "./sanitize";

/** Snapshot payload for the Claude adapter. */
export type ClaudeSnapshotResult = SnapshotResult;

/** Collect Claude files that are safe to store in the encrypted vault. */
export async function snapshotClaude(config: AgentSyncConfig): Promise<SnapshotResult> {
  const syncPlugins = config.claudePlugins?.syncPlugins ?? false;
  const policy = securityToPolicy(config.security);
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  artifacts.push(
    ...(await collectSingleFile({
      sourcePath: AgentPaths.claude.claudeMd,
      vaultPath: "claude/CLAUDE.md.age",
    })),
  );

  const settingsJson = await readIfExists(AgentPaths.claude.settingsJson);
  if (settingsJson !== null) {
    const hooks = sanitizeClaudeHooks(settingsJson, homedir(), policy);
    artifacts.push(
      collect(hooks, AgentPaths.claude.settingsJson, "claude/settings.hooks.json.age"),
    );
    warnings.push(...hooks.warnings);
  }

  const mcpJson = await readIfExists(AgentPaths.claude.mcpJson);
  if (mcpJson !== null) {
    const mcp = sanitizeClaudeMcp(mcpJson, homedir(), policy);
    artifacts.push(collect(mcp, AgentPaths.claude.mcpJson, "claude/claude.json.age"));
    warnings.push(...mcp.warnings);
  }

  artifacts.push(
    ...(await collectMarkdownDir({
      dir: AgentPaths.claude.commandsDir,
      vaultPath: (name) => `claude/commands/${name}.age`,
    })),
    ...(await collectMarkdownDir({
      dir: AgentPaths.claude.agentsDir,
      vaultPath: (name) => `claude/agents/${name}.age`,
    })),
    // Rules at ~/.claude/rules/*.md are referenced from CLAUDE.md via include
    // directives, so they must travel with the config or the includes break on
    // the destination machine. collectMarkdownDir rejects symlinked entries so a
    // `rules/secret.md -> /etc/passwd` link cannot smuggle content past
    // shouldNeverSync (readFile would follow the link; the gate only sees it).
    ...(await collectMarkdownDir({
      dir: AgentPaths.claude.rulesDir,
      vaultPath: (name) => `claude/rules/${name}.age`,
    })),
  );

  // Skills — delegated to the shared walker. The walker handles dot-skip,
  // symlink rejection, sentinel verification, the never-sync interior scan, and
  // the symlink-filtered tar archival in one place so every skill-bearing agent
  // inherits identical rules.
  const claudeSkills = await collectSkillArtifacts("claude", AgentPaths.claude.skillsDir);
  artifacts.push(...claudeSkills.artifacts);
  warnings.push(...claudeSkills.warnings);

  // Claude Code plugins. We do NOT encrypt the plugin tree; the marketplace is
  // the source of truth. Instead we distil ~/.claude/plugins/installed_plugins
  // .json + known_marketplaces.json into a single reinstall manifest that
  // `agentsync plugin install` consumes. Off by default because the manifest
  // can reference third-party marketplaces. The manifest has no apply directive
  // (see buildClaudePlan) — it is never restored to disk on pull, only read by
  // the plugin command, so a `copy claude/` sweep skips it like any unowned file.
  if (syncPlugins) {
    try {
      const built = await buildPluginManifest(AgentPaths.claude.pluginsDir);
      if (built) {
        artifacts.push({
          vaultPath: "claude/plugins.manifest.json.age",
          sourcePath: AgentPaths.claude.installedPluginsJson,
          plaintext: serializeManifest(built.manifest),
          warnings: built.warnings,
        });
        warnings.push(...built.warnings);
      }
    } catch (err) {
      warnings.push(
        `[claude] Skipping plugin manifest — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { artifacts, warnings };
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

/**
 * Restore one Claude skill directory from the vault by extracting its encrypted
 * tar archive into `~/.claude/skills/<name>/`. Thin wrapper over
 * {@link applySkillArchive}, which validates the name and preserves the tar's
 * interior layout bit-for-bit.
 */
export async function applyClaudeSkill(skillName: string, base64Tar: string): Promise<void> {
  await applySkillArchive(AgentPaths.claude.skillsDir, skillName, base64Tar);
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
export function applyClaudeCommand(commandName: string, content: string): Promise<void> {
  return dirWriteApplier({ dir: AgentPaths.claude.commandsDir, backup: true })(
    commandName,
    content,
  );
}

/** Restore one Claude agent definition markdown file from the vault. */
export function applyClaudeAgent(agentName: string, content: string): Promise<void> {
  return dirWriteApplier({ dir: AgentPaths.claude.agentsDir, backup: true })(agentName, content);
}

/** Restore one Claude rule markdown file from the vault. */
export function applyClaudeRule(ruleName: string, content: string): Promise<void> {
  return dirWriteApplier({ dir: AgentPaths.claude.rulesDir, backup: true })(ruleName, content);
}

/**
 * Build the Claude apply plan. Exposed so `copy` can apply a single artifact.
 * Note: `claude/plugins.manifest.json.age` is deliberately NOT a directive —
 * the manifest drives `agentsync plugin install`, it is never written to disk
 * on pull. `_config` is unused now that nothing in the plan gates on it; the
 * param is kept to satisfy the shared `AgentDefinition.buildPlan` contract.
 */
export function buildClaudePlan(_config?: AgentSyncConfig): ApplyPlan {
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
        filter: skillNameFilter(),
      },
    ],
  };
}

/** Decrypt and apply all Claude vault artifacts to the local machine. */
export const applyClaudeVault = makeApplyVault(buildClaudePlan);
