import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import * as TOML from "@iarna/toml";
import { AgentPaths } from "../config/paths";
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
function sanitizeCodexConfig(raw: string): RedactionResult<string> {
  const warnings: string[] = [];
  let parsed: TOML.JsonMap;
  try {
    parsed = TOML.parse(raw);
  } catch {
    warnings.push("Could not parse codex config.toml as TOML — skipping sanitization");
    return { value: raw, warnings };
  }

  const redacted = redactSecretLiterals(parsed as unknown, "codex_config");
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

  const configToml = await readIfExists(AgentPaths.codex.configToml);
  if (configToml !== null) {
    const sanitized = sanitizeCodexConfig(configToml);
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

  // Skills — delegated to the shared walker (FR-001/FR-002/FR-006/FR-016/FR-017).
  // The walker enforces dot-skip (which covers Codex's vendored `.system/`
  // bundle — FR-017), symlink rejection at the root, sentinel verification,
  // the never-sync interior scan, and the symlink-filtered tar archival in one
  // place so every skill-bearing agent inherits identical rules.
  const codexSkills = await collectSkillArtifacts("codex", AgentPaths.codex.skillsDir);
  artifacts.push(...codexSkills.artifacts);
  warnings.push(...codexSkills.warnings);

  return { artifacts, warnings };
}

/** Restore the top-level Codex AGENTS.md file from the vault. */
export async function applyCodexAgentsMd(content: string): Promise<void> {
  await atomicWrite(AgentPaths.codex.agentsMd, content);
}

/** Merge synced Codex config into the local TOML while preserving unrelated local keys. */
export async function applyCodexConfig(content: string): Promise<void> {
  const existingRaw = await readIfExists(AgentPaths.codex.configToml);
  if (existingRaw === null) {
    // No local file yet — write directly.
    await atomicWrite(AgentPaths.codex.configToml, content);
    return;
  }

  let existing: TOML.JsonMap;
  try {
    existing = TOML.parse(existingRaw);
  } catch {
    // Existing file is corrupt — overwrite.
    await atomicWrite(AgentPaths.codex.configToml, content);
    return;
  }

  const incoming = TOML.parse(content);
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
  const targetDir = join(AgentPaths.codex.skillsDir, skillName);
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

  // Skills sub-directory — stored as <name>.tar.age (FR-005). Mirrors the
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
