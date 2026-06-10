/**
 * src/agents/_snapshot.ts
 *
 * Snapshot-side toolkit shared by every agent adapter. These verbs replace the
 * walk/collect fragments that were copy-pasted across the five adapters so a
 * cross-cutting rule (symlink hardening, the never-sync gate, the artifact
 * shape) lives in exactly one place. Per-adapter variation is passed in as a
 * parameter (match predicate, vault-path builder, scope list), never branched
 * on the agent name.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { shouldNeverSync } from "../core/sanitizer";
import { readIfExists, type SnapshotArtifact, type SnapshotResult } from "./_utils";
import { collectSkillArtifacts, type SkillBearingAgent } from "./skills-walker";

/**
 * Walk one flat directory and return a plaintext SnapshotArtifact per
 * qualifying file. Hardened by construction: `withFileTypes` + reject any entry
 * that is not a real file (so a symlinked `commands/evil.md -> /etc/passwd`
 * cannot smuggle arbitrary content through `readFile`, which follows symlinks
 * while `shouldNeverSync` only ever sees the link path). The per-file
 * `shouldNeverSync` gate and silent skip on a missing directory or unreadable
 * entry are preserved. There is deliberately no symlink-follow opt-out — the
 * hardening is structural, not a flag.
 *
 * @param dir        absolute source directory on the local machine
 * @param vaultPath  builds the vault path from the bare file name,
 *                   e.g. `(n) => `claude/commands/${n}.age``
 * @param match      filename predicate; default `(n) => n.endsWith(".md")`
 */
export async function collectMarkdownDir(opts: {
  dir: string;
  vaultPath: (fileName: string) => string;
  match?: (fileName: string) => boolean;
}): Promise<SnapshotArtifact[]> {
  const match = opts.match ?? ((name: string) => name.endsWith(".md"));
  const artifacts: SnapshotArtifact[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(opts.dir, { withFileTypes: true });
  } catch {
    return artifacts; // dir may not exist yet.
  }

  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const name = entry.name;
    if (!match(name)) continue;
    const sourcePath = join(opts.dir, name);
    if (shouldNeverSync(sourcePath)) continue;
    let content: string;
    try {
      content = await readFile(sourcePath, "utf8");
    } catch {
      continue; // unreadable entry — skip silently.
    }
    artifacts.push({
      vaultPath: opts.vaultPath(name),
      sourcePath,
      plaintext: content,
      warnings: [],
    });
  }

  return artifacts;
}

/**
 * Collect one optional, verbatim single file. Returns `[]` when absent. Only
 * for files stored as-is — adapters that sanitise or normalise a single file
 * (claude hooks/mcp, codex config, cursor rules/mcp) keep using `collect(...)`.
 */
export async function collectSingleFile(opts: {
  sourcePath: string;
  vaultPath: string;
}): Promise<SnapshotArtifact[]> {
  const content = await readIfExists(opts.sourcePath);
  if (content === null) return [];
  return [
    { vaultPath: opts.vaultPath, sourcePath: opts.sourcePath, plaintext: content, warnings: [] },
  ];
}

/**
 * Collect skills across one or more scope directories. `scopes[0]` is the
 * canonical write target; any later scope is deduplicated against the canonical
 * directory's on-disk listing — so a skill present canonically suppresses the
 * same-named copy in a legacy scope even when the canonical scan rejected it
 * (never-sync hit, literal secret) and emitted no artifact. Single-scope
 * callers pass one entry and get a plain `collectSkillArtifacts` pass-through.
 */
export async function collectSkillScopes(
  agent: SkillBearingAgent,
  scopes: readonly string[],
): Promise<SnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];
  if (scopes.length === 0) return { artifacts, warnings };

  const [canonical, ...rest] = scopes;
  const canonicalResult = await collectSkillArtifacts(agent, canonical);
  artifacts.push(...canonicalResult.artifacts);
  warnings.push(...canonicalResult.warnings);
  if (rest.length === 0) return { artifacts, warnings };

  // Dedup key set comes from the canonical directory listing, not the emitted
  // artifacts, so a rejected canonical skill still blocks the legacy copy.
  let canonicalNames: string[] = [];
  try {
    canonicalNames = await readdir(canonical);
  } catch {
    // canonical dir may not exist; nothing to dedup against.
  }
  const seen = new Set(canonicalNames.filter((n) => !n.startsWith(".")));
  const prefix = `${agent}/skills/`;

  for (const scope of rest) {
    const result = await collectSkillArtifacts(agent, scope);
    warnings.push(...result.warnings);
    for (const artifact of result.artifacts) {
      const name = artifact.vaultPath.slice(prefix.length).replace(/\.tar\.age$/, "");
      if (seen.has(name)) continue;
      artifacts.push(artifact);
    }
  }

  return { artifacts, warnings };
}
