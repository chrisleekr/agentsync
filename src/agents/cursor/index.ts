import { homedir } from "node:os";
import { basename } from "node:path";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { AgentPaths } from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import { denormalizeStringFromVault, normalizeStringForVault } from "../../core/path-portability";
import { sanitizeAndNormalizeJson, securityToPolicy } from "../../core/sanitizer";
import {
  type ApplyPlan,
  defineFileArtifact,
  dirWriteApplier,
  makeApplyVault,
  skillNameFilter,
} from "../_apply";
import { collectMarkdownDir } from "../_snapshot";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
  setJsoncTopLevelKey,
} from "../_utils";
import { applySkillArchive, collectSkillArtifacts } from "../skills-walker";

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

/**
 * Reject Cursor rule filenames that could escape `rulesDir`, smuggle in vendor
 * dotfiles, or carry NUL bytes. Used as the apply-side `validate` guard for the
 * cross-agent `rules` passthrough.
 */
function validateCursorRuleName(ruleName: string): void {
  if (
    ruleName.length === 0 ||
    ruleName !== basename(ruleName) ||
    ruleName.startsWith(".") ||
    ruleName.includes("\0")
  ) {
    throw new Error(`Invalid Cursor rule filename: ${ruleName}`);
  }
}

/** Collect Cursor rules, MCP config, and commands that are safe to sync. */
export async function snapshotCursor(config?: AgentSyncConfig): Promise<SnapshotResult> {
  const policy = securityToPolicy(config?.security);
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
    const sanitized = sanitizeAndNormalizeJson(mcpRaw, "cursor_mcp", homedir(), policy);
    artifacts.push(collect(sanitized, AgentPaths.cursor.mcpGlobal, "cursor/mcp.json.age"));
    warnings.push(...sanitized.warnings);
  }

  artifacts.push(
    ...(await collectMarkdownDir({
      dir: AgentPaths.cursor.commandsDir,
      vaultPath: (name) => `cursor/commands/${name}.age`,
    })),
  );

  // Skills — delegated to the shared walker, pointed at `~/.cursor/skills/`. The
  // bundled `~/.cursor/skills-cursor/` directory is never read (paths.ts does
  // not expose it), so vendor bundles cannot leak into the vault.
  const cursorSkills = await collectSkillArtifacts("cursor", AgentPaths.cursor.skillsDir);
  artifacts.push(...cursorSkills.artifacts);
  warnings.push(...cursorSkills.warnings);

  return { artifacts, warnings };
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

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

/**
 * Write one Cursor rules-folder file to ~/.cursor/rules/<name>.
 * The migrate `rules` ConfigType uses this for cross-agent passthrough.
 */
export function applyCursorRule(ruleName: string, content: string): Promise<void> {
  return dirWriteApplier({ dir: AgentPaths.cursor.rulesDir, validate: validateCursorRuleName })(
    ruleName,
    content,
  );
}

/** Restore one Cursor command markdown file from the vault. */
export function applyCursorCommand(commandName: string, content: string): Promise<void> {
  return dirWriteApplier({ dir: AgentPaths.cursor.commandsDir })(commandName, content);
}

/**
 * Restore one Cursor skill directory from the vault by extracting its encrypted
 * tar archive into `~/.cursor/skills/<name>/` — NEVER into the bundled
 * `~/.cursor/skills-cursor/` path. Thin wrapper over {@link applySkillArchive}.
 */
export async function applyCursorSkill(skillName: string, base64Tar: string): Promise<void> {
  await applySkillArchive(AgentPaths.cursor.skillsDir, skillName, base64Tar);
}

/** Build the Cursor apply plan. Exposed so `copy` can apply a single artifact. */
export function buildCursorPlan(_config?: AgentSyncConfig): ApplyPlan {
  return {
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
        filter: skillNameFilter(),
      },
    ],
  };
}

/** Decrypt and apply all Cursor vault artifacts to the local machine. */
export const applyCursorVault = makeApplyVault(buildCursorPlan);
