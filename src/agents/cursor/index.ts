import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { AgentPaths } from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import { denormalizeStringFromVault, normalizeStringForVault } from "../../core/path-portability";
import { sanitizeAndNormalizeJson, shouldNeverSync } from "../../core/sanitizer";
import { extractArchive } from "../../core/tar";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
  setJsoncTopLevelKey,
} from "../_utils";
import { collectSkillArtifacts, InvalidSkillNameError, validateSkillName } from "../skills-walker";

/** Snapshot payload for the Cursor adapter. */
export type CursorSnapshotResult = SnapshotResult;

/**
 * Read the Cursor global `rules` field from its Electron settings.json.
 * Only the `rules` string is synced — the full settings.json is never written to the vault.
 */
async function readCursorRules(): Promise<string | null> {
  const raw = await readIfExists(AgentPaths.cursor.settingsJson);
  if (raw === null) return null;

  // Cursor's settings.json is JSONC. Parse it tolerantly so a comment or a
  // trailing comma does not silently drop the user's `rules` from the vault.
  // jsonc-parser returns a best-effort partial object for malformed input
  // instead of throwing, so reject on collected errors — otherwise a truncated
  // `rules` value from a corrupt file could be synced.
  try {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(raw, errors, { allowTrailingComma: true }) as
      | Record<string, unknown>
      | undefined;
    if (errors.length > 0) return null;
    const rules = parsed?.rules;
    if (typeof rules !== "string") return null;
    return rules;
  } catch {
    return null;
  }
}

/** Collect Cursor rules, MCP config, and commands that are safe to sync. */
export async function snapshotCursor(_config?: AgentSyncConfig): Promise<SnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  const rules = await readCursorRules();
  if (rules !== null) {
    artifacts.push({
      vaultPath: "cursor/user-rules.md.age",
      sourcePath: AgentPaths.cursor.settingsJson,
      plaintext: normalizeStringForVault(rules, homedir()),
      warnings: [],
    });
  }

  const mcpRaw = await readIfExists(AgentPaths.cursor.mcpGlobal);
  if (mcpRaw !== null) {
    const sanitized = sanitizeAndNormalizeJson(mcpRaw, "cursor_mcp");
    const artifact = collect(sanitized, AgentPaths.cursor.mcpGlobal, "cursor/mcp.json.age");
    artifacts.push(artifact);
    warnings.push(...sanitized.warnings);
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
  // the canonical user-skills path. The bundled `~/.cursor/skills-cursor/`
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
  const rules = denormalizeStringFromVault(rulesContent, homedir());
  // Cursor's settings.json is JSONC. Edit the `rules` key in place so a
  // trailing comma elsewhere does not abort the pull and the user's other
  // settings and comments survive untouched.
  await atomicWrite(AgentPaths.cursor.settingsJson, setJsoncTopLevelKey(raw ?? "", "rules", rules));
}

/**
 * Apply the synced Cursor MCP config back to ~/.cursor/mcp.json.
 * Placeholders are expanded back to this machine's HOME before write so the
 * file is immediately usable by Cursor without a separate post-process.
 */
export async function applyCursorMcp(mcpJsonContent: string): Promise<void> {
  await atomicWrite(
    AgentPaths.cursor.mcpGlobal,
    denormalizeStringFromVault(mcpJsonContent, homedir()),
  );
}

/** Restore one Cursor command markdown file from the vault. */
/**
 * Write one Cursor rules-folder file to ~/.cursor/rules/<name>.
 * The migrate `rules` ConfigType uses this for cross-agent passthrough.
 */
export async function applyCursorRule(ruleName: string, content: string): Promise<void> {
  if (
    ruleName.length === 0 ||
    ruleName !== basename(ruleName) ||
    ruleName.startsWith(".") ||
    ruleName.includes("\0")
  ) {
    throw new Error(`Invalid Cursor rule filename: ${ruleName}`);
  }
  const target = join(AgentPaths.cursor.rulesDir, ruleName);
  await mkdir(AgentPaths.cursor.rulesDir, { recursive: true });
  await atomicWrite(target, content);
}

export async function applyCursorCommand(commandName: string, content: string): Promise<void> {
  const target = join(AgentPaths.cursor.commandsDir, commandName);
  await mkdir(AgentPaths.cursor.commandsDir, { recursive: true });
  await atomicWrite(target, content);
}

/**
 * Restore one Cursor skill directory from the vault by extracting its
 * encrypted tar archive into `~/.cursor/skills/<name>/` — NEVER into the
 * bundled `~/.cursor/skills-cursor/` path.
 *
 * Mirrors {@link applyClaudeSkill}: parents are created on demand and the
 * tar's interior layout is preserved bit-for-bit.
 *
 * @param skillName  Basename of the skill (no extension).
 * @param base64Tar  Base64-encoded `.tar.gz` payload that the walker
 *                   produced on the source machine.
 */
export async function applyCursorSkill(skillName: string, base64Tar: string): Promise<void> {
  validateSkillName(skillName);
  const targetDir = join(AgentPaths.cursor.skillsDir, skillName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { type ApplyPlan, defineFileArtifact, runApplyPlan } from "../_apply";

/** Decrypt and apply all Cursor vault artifacts to the local machine. */
export async function applyCursorVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
  _config?: AgentSyncConfig,
): Promise<void> {
  const plan: ApplyPlan = {
    agent: "cursor",
    warnOnUnknownTopLevel: true,
    directives: [
      defineFileArtifact({
        vaultName: "user-rules.md.age",
        dryRunLabel: "[dry-run] [cursor] would apply user-rules",
        apply: applyCursorRules,
      }),
      defineFileArtifact({
        vaultName: "mcp.json.age",
        dryRunLabel: "[dry-run] [cursor] would apply mcp.json",
        apply: applyCursorMcp,
      }),
      {
        kind: "dir",
        subdir: "commands",
        suffix: ".age",
        dryRunVerb: "would write command:",
        apply: applyCursorCommand,
      },
      {
        kind: "dir",
        subdir: "skills",
        suffix: ".tar.age",
        dryRunVerb: "would extract skill:",
        apply: applyCursorSkill,
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
    ],
  };
  await runApplyPlan(plan, vaultDir, key, dryRun);
}
