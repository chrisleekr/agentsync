import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import * as TOML from "@iarna/toml";
import { AgentPaths } from "../config/paths";
import { type RedactionResult, redactSecretLiterals, shouldNeverSync } from "../core/sanitizer";
import { type SnapshotArtifact, atomicWrite, collect, readIfExists } from "./_utils";

export interface CodexSnapshotResult {
  artifacts: SnapshotArtifact[];
  warnings: string[];
}

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

export async function snapshotCodex(): Promise<CodexSnapshotResult> {
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
    const entries = await readdir(AgentPaths.codex.rulesDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const sourcePath = join(AgentPaths.codex.rulesDir, entry.name);
      if (shouldNeverSync(sourcePath)) continue;
      const content = await readFile(sourcePath, "utf8");
      artifacts.push({
        vaultPath: `codex/rules/${entry.name}.age`,
        sourcePath,
        plaintext: content,
        warnings: [],
      });
    }
  } catch {
    // rules dir may not exist yet
  }

  return { artifacts, warnings };
}

export async function applyCodexAgentsMd(content: string): Promise<void> {
  await atomicWrite(AgentPaths.codex.agentsMd, content);
}

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

export async function applyCodexRule(ruleName: string, content: string): Promise<void> {
  const target = join(AgentPaths.codex.rulesDir, ruleName);
  await mkdir(AgentPaths.codex.rulesDir, { recursive: true });
  await atomicWrite(target, content);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { basename } from "node:path";
import { decryptString } from "../core/encryptor";

async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".age"))
      .map((e) => ({ name: e.name, fullPath: join(dir, e.name) }));
  } catch {
    return [];
  }
}

/**
 * Decrypt and apply all Codex vault artifacts to the local machine.
 */
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
}
