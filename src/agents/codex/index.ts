import { homedir } from "node:os";
import * as TOML from "@iarna/toml";
import { AgentPaths } from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import { denormalizeFromVault, normalizeForVault } from "../../core/path-portability";
import {
  DEFAULT_SECRET_POLICY,
  type RedactionResult,
  redactSecretLiterals,
  type SecretPolicy,
  securityToPolicy,
} from "../../core/sanitizer";
import { mergePreservingSecrets } from "../../core/secret-merge";
import {
  type ApplyPlan,
  defineFileArtifact,
  dirWriteApplier,
  makeApplyVault,
  skillNameFilter,
} from "../_apply";
import { collectMarkdownDir, collectSingleFile, collectSkillScopes } from "../_snapshot";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
} from "../_utils";
import { applySkillArchive } from "../skills-walker";

/** Snapshot payload for the Codex adapter. */
export type CodexSnapshotResult = SnapshotResult;

/**
 * Sanitize Codex config.toml: parse the TOML properly, redact any secret-looking
 * values in the object tree (handles nested tables correctly), then re-stringify.
 * Using TOML parse → redact → stringify avoids the line-level regex approach which
 * misses multi-line values and nested tables.
 */
function sanitizeCodexConfig(
  raw: string,
  home: string = homedir(),
  policy: SecretPolicy = DEFAULT_SECRET_POLICY,
): RedactionResult<string> {
  const warnings: string[] = [];
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(raw);
  } catch {
    warnings.push("Could not parse codex config.toml as TOML — skipping sanitization");
    return { value: raw, warnings };
  }

  const normalized = normalizeForVault(parsed as unknown, home);
  const redacted = redactSecretLiterals(normalized, "codex_config", policy);
  warnings.push(...redacted.warnings);
  return {
    value: TOML.stringify(redacted.value as TOML.JsonMap),
    warnings,
  };
}

/** Collect Codex instructions, rules, and config that are safe to sync. */
export async function snapshotCodex(config?: AgentSyncConfig): Promise<SnapshotResult> {
  const policy = securityToPolicy(config?.security);
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  artifacts.push(
    ...(await collectSingleFile({
      sourcePath: AgentPaths.codex.agentsMd,
      vaultPath: "codex/AGENTS.md.age",
    })),
    // AGENTS.override.md wins over AGENTS.md when codex reads the pair; sync
    // both so the override semantics are preserved on the destination machine.
    ...(await collectSingleFile({
      sourcePath: AgentPaths.codex.agentsOverrideMd,
      vaultPath: "codex/AGENTS.override.md.age",
    })),
  );

  const configToml = await readIfExists(AgentPaths.codex.configToml);
  if (configToml !== null) {
    const sanitized = sanitizeCodexConfig(configToml, homedir(), policy);
    artifacts.push(collect(sanitized, AgentPaths.codex.configToml, "codex/config.toml.age"));
    warnings.push(...sanitized.warnings);
  }

  artifacts.push(
    ...(await collectMarkdownDir({
      dir: AgentPaths.codex.rulesDir,
      vaultPath: (name) => `codex/rules/${name}.age`,
    })),
  );

  // Skills — canonical USER scope is $HOME/.agents/skills per the Codex Skills
  // docs; the legacy $CODEX_HOME/.codex/skills path stays readable so prior
  // installs migrate forward on the next pull. collectSkillScopes dedups the
  // legacy scope against the canonical directory listing, so a skill the walker
  // REJECTED at the canonical location (never-sync hit, literal secret) still
  // blocks the legacy copy from leaking through.
  const skills = await collectSkillScopes("codex", [
    AgentPaths.codex.userSkillsDir,
    AgentPaths.codex.skillsDir,
  ]);
  artifacts.push(...skills.artifacts);
  warnings.push(...skills.warnings);

  return { artifacts, warnings };
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

/** Restore the top-level Codex AGENTS.md file from the vault. */
export async function applyCodexAgentsMd(content: string): Promise<void> {
  await atomicWrite(AgentPaths.codex.agentsMd, content);
}

/** Restore the optional AGENTS.override.md companion to AGENTS.md. */
export async function applyCodexAgentsOverrideMd(content: string): Promise<void> {
  await atomicWrite(AgentPaths.codex.agentsOverrideMd, content);
}

/** Merge synced Codex config into the local TOML while preserving unrelated local keys. */
export async function applyCodexConfig(content: string): Promise<void> {
  const home = homedir();
  // Denormalize only the incoming subset. Local-only top-level keys that
  // pre-exist on disk are not in scope for portability — they were never
  // normalized on snapshot, and a `$` literal in their values must stay
  // literal. Any AGENTSYNC_HOME placeholder reaching this branch came from
  // the vault, so denormalization here is sufficient for the synced surface.
  const incoming = denormalizeFromVault(TOML.parse(content), home) as TOML.JsonMap;

  const existingRaw = await readIfExists(AgentPaths.codex.configToml);
  if (existingRaw === null) {
    await atomicWrite(AgentPaths.codex.configToml, TOML.stringify(incoming));
    return;
  }

  let existing: TOML.JsonMap;
  try {
    existing = TOML.parse(existingRaw);
  } catch {
    await atomicWrite(AgentPaths.codex.configToml, TOML.stringify(incoming));
    return;
  }

  // Deep, placeholder-aware merge: a redacted placeholder (`redact` mode) must
  // not overwrite a real local value, and nested local-only keys survive.
  const { merged } = mergePreservingSecrets(existing, incoming);
  await atomicWrite(AgentPaths.codex.configToml, TOML.stringify(merged as TOML.JsonMap));
}

/** Restore one Codex rule markdown file from the vault. */
export function applyCodexRule(ruleName: string, content: string): Promise<void> {
  return dirWriteApplier({ dir: AgentPaths.codex.rulesDir })(ruleName, content);
}

/**
 * Restore one Codex skill directory from the vault. Always restores under
 * $HOME/.agents/skills — the canonical Codex USER scope. Legacy
 * $CODEX_HOME/.codex/skills remains readable on snapshot but is never a write
 * target, so pulls migrate forward in place without leaving stragglers.
 */
export async function applyCodexSkill(skillName: string, base64Tar: string): Promise<void> {
  await applySkillArchive(AgentPaths.codex.userSkillsDir, skillName, base64Tar);
}

/** Build the Codex apply plan. Exposed so `copy` can apply a single artifact. */
export function buildCodexPlan(_config?: AgentSyncConfig): ApplyPlan {
  return {
    agent: "codex",
    directives: [
      defineFileArtifact({
        vaultName: "AGENTS.md.age",
        dryRunLabel: "[dry-run] [codex] would apply AGENTS.md",
        apply: applyCodexAgentsMd,
      }),
      defineFileArtifact({
        vaultName: "AGENTS.override.md.age",
        dryRunLabel: "[dry-run] [codex] would apply AGENTS.override.md",
        apply: applyCodexAgentsOverrideMd,
      }),
      defineFileArtifact({
        vaultName: "config.toml.age",
        dryRunLabel: "[dry-run] [codex] would apply config.toml",
        apply: applyCodexConfig,
      }),
      {
        kind: "dir",
        subdir: "rules",
        suffix: ".age",
        dryRunVerb: "would write rule:",
        apply: applyCodexRule,
      },
      {
        kind: "dir",
        subdir: "skills",
        suffix: ".tar.age",
        dryRunVerb: "would extract skill:",
        apply: applyCodexSkill,
        filter: skillNameFilter(),
      },
    ],
  };
}

/** Decrypt and apply all Codex vault artifacts to the local machine. */
export const applyCodexVault = makeApplyVault(buildCodexPlan);
