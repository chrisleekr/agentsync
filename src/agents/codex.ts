import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@clack/prompts";
import * as TOML from "@iarna/toml";
import { AgentPaths } from "../config/paths";
import { denormalizeFromVault, normalizeForVault } from "../core/path-portability";
import { type RedactionResult, redactSecretLiterals, shouldNeverSync } from "../core/sanitizer";
import { extractArchive } from "../core/tar";
import {
  atomicWrite,
  collect,
  readIfExists,
  type SnapshotArtifact,
  type SnapshotResult,
} from "./_utils";
import { collectSkillArtifacts, InvalidSkillNameError, validateSkillName } from "./skills-walker";

/** Snapshot payload for the Codex adapter. */
export type CodexSnapshotResult = SnapshotResult;

/**
 * Sanitize Codex config.toml: parse the TOML properly, redact any secret-looking
 * values in the object tree (handles nested tables correctly), then re-stringify.
 * Using TOML parse → redact → stringify avoids the line-level regex approach which
 * misses multi-line values and nested tables.
 */
function sanitizeCodexConfig(raw: string, home: string = homedir()): RedactionResult<string> {
  const warnings: string[] = [];
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(raw);
  } catch {
    warnings.push("Could not parse codex config.toml as TOML — skipping sanitization");
    return { value: raw, warnings };
  }

  const normalized = normalizeForVault(parsed as unknown, home);
  const redacted = redactSecretLiterals(normalized, "codex_config");
  warnings.push(...redacted.warnings);
  return {
    value: TOML.stringify(redacted.value as TOML.JsonMap),
    warnings,
  };
}

/** Collect Codex instructions, rules, and config that are safe to sync. */
export async function snapshotCodex(): Promise<SnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  const agentsMd = await readIfExists(AgentPaths.codex.agentsMd);
  if (agentsMd !== null) {
    artifacts.push({
      vaultPath: "codex/AGENTS.md.age",
      sourcePath: AgentPaths.codex.agentsMd,
      plaintext: agentsMd,
      warnings: [],
    });
  }

  // AGENTS.override.md wins over AGENTS.md when codex reads the pair; sync
  // both so the override semantics are preserved on the destination machine.
  const agentsOverrideMd = await readIfExists(AgentPaths.codex.agentsOverrideMd);
  if (agentsOverrideMd !== null) {
    artifacts.push({
      vaultPath: "codex/AGENTS.override.md.age",
      sourcePath: AgentPaths.codex.agentsOverrideMd,
      plaintext: agentsOverrideMd,
      warnings: [],
    });
  }

  const configToml = await readIfExists(AgentPaths.codex.configToml);
  if (configToml !== null) {
    const sanitized = sanitizeCodexConfig(configToml, homedir());
    artifacts.push(collect(sanitized, AgentPaths.codex.configToml, "codex/config.toml.age"));
    warnings.push(...sanitized.warnings);
  }

  try {
    const names = await readdir(AgentPaths.codex.rulesDir);
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const sourcePath = join(AgentPaths.codex.rulesDir, name);
      if (shouldNeverSync(sourcePath)) continue;
      let content: string;
      try {
        content = await readFile(sourcePath, "utf8");
      } catch {
        continue; // skip directories or unreadable entries
      }
      artifacts.push({
        vaultPath: `codex/rules/${name}.age`,
        sourcePath,
        plaintext: content,
        warnings: [],
      });
    }
  } catch {
    // rules dir may not exist yet
  }

  // Skills — canonical USER scope is $HOME/.agents/skills per the Codex Skills
  // docs; the legacy $CODEX_HOME/.codex/skills path stays readable so prior
  // installs migrate forward on the next pull. Deduplication keys come from
  // the canonical directory listing rather than emitted artifacts so a skill
  // the walker REJECTED at the canonical location (never-sync hit, literal
  // secret) still blocks the legacy copy from leaking through.
  let canonicalNames: string[] = [];
  try {
    canonicalNames = await readdir(AgentPaths.codex.userSkillsDir);
  } catch {
    // canonical dir may not exist yet
  }
  const seen = new Set(canonicalNames.filter((n) => !n.startsWith(".")));

  const userSkills = await collectSkillArtifacts("codex", AgentPaths.codex.userSkillsDir);
  const legacySkills = await collectSkillArtifacts("codex", AgentPaths.codex.skillsDir);
  artifacts.push(...userSkills.artifacts);
  for (const artifact of legacySkills.artifacts) {
    // vaultPath is `codex/skills/<name>.tar.age` — extract `<name>` and skip
    // when the canonical directory already carries the name (regardless of
    // whether the canonical scan emitted an artifact).
    const legacyName = artifact.vaultPath
      .replace(/^codex\/skills\//, "")
      .replace(/\.tar\.age$/, "");
    if (seen.has(legacyName)) continue;
    artifacts.push(artifact);
  }
  warnings.push(...userSkills.warnings, ...legacySkills.warnings);

  return { artifacts, warnings };
}

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

  // Shallow-merge at top level: incoming keys win, local-only keys survive.
  const merged: TOML.JsonMap = { ...existing, ...incoming };
  await atomicWrite(AgentPaths.codex.configToml, TOML.stringify(merged));
}

/** Restore one Codex rule markdown file from the vault. */
export async function applyCodexRule(ruleName: string, content: string): Promise<void> {
  const target = join(AgentPaths.codex.rulesDir, ruleName);
  await mkdir(AgentPaths.codex.rulesDir, { recursive: true });
  await atomicWrite(target, content);
}

/**
 * Restore one Codex skill directory from the vault by extracting its
 * encrypted tar archive into `~/.codex/skills/<name>/`.
 *
 * Mirrors {@link applyClaudeSkill}: parents are created on demand and the
 * tar's interior layout is preserved bit-for-bit.
 *
 * @param skillName  Basename of the skill (no extension).
 * @param base64Tar  Base64-encoded `.tar.gz` payload that the walker
 *                   produced on the source machine.
 */
export async function applyCodexSkill(skillName: string, base64Tar: string): Promise<void> {
  validateSkillName(skillName);
  // Always restore under $HOME/.agents/skills — the canonical Codex USER scope.
  // Legacy $CODEX_HOME/.codex/skills remains readable on snapshot but is never
  // a write target, so pulls migrate forward in place without leaving stragglers.
  const targetDir = join(AgentPaths.codex.userSkillsDir, skillName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { basename } from "node:path";
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

/** Decrypt and apply all Codex vault artifacts to the local machine. */
export async function applyCodexVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
): Promise<void> {
  const codexDir = join(vaultDir, "codex");
  const files = await readAgeFiles(codexDir);

  for (const { name, fullPath } of files) {
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);

    if (name === "AGENTS.md.age") {
      if (dryRun) {
        log.info("[dry-run] [codex] would apply AGENTS.md");
        continue;
      }
      await applyCodexAgentsMd(decrypted);
    } else if (name === "AGENTS.override.md.age") {
      if (dryRun) {
        log.info("[dry-run] [codex] would apply AGENTS.override.md");
        continue;
      }
      await applyCodexAgentsOverrideMd(decrypted);
    } else if (name === "config.toml.age") {
      if (dryRun) {
        log.info("[dry-run] [codex] would apply config.toml");
        continue;
      }
      await applyCodexConfig(decrypted);
    }
  }

  const ruleFiles = await readAgeFiles(join(codexDir, "rules"));
  for (const { name, fullPath } of ruleFiles) {
    if (!name.endsWith(".md.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const ruleName = basename(name, ".age");
    if (dryRun) {
      log.info(`[dry-run] [codex] would write rule: ${ruleName}`);
    } else {
      await applyCodexRule(ruleName, decrypted);
    }
  }

  // Skills sub-directory — stored as <name>.tar.age. Mirrors the
  // Claude/Copilot apply path: each entry is decrypted, then the inner base64
  // tar is extracted into ~/.codex/skills/<name>/ via applyCodexSkill.
  const skillFiles = await readAgeFiles(join(codexDir, "skills"));
  for (const { name, fullPath } of skillFiles) {
    if (!name.endsWith(".tar.age")) continue;
    const skillName = basename(name, ".tar.age");
    try {
      validateSkillName(skillName);
    } catch (err) {
      if (err instanceof InvalidSkillNameError) {
        log.warn(`[codex] Skipping vault skill with invalid name '${name}': ${err.reason}`);
        continue;
      }
      throw err;
    }
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    if (dryRun) {
      log.info(`[dry-run] [codex] would extract skill: ${skillName}`);
      continue;
    }
    await applyCodexSkill(skillName, decrypted);
  }
}
