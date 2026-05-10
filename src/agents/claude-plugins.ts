/**
 * src/agents/claude-plugins.ts
 *
 * Discovery walker and name validator for Claude Code plugins.
 *
 * Upstream layout (anthropics/claude-code, plugins/README.md):
 *   ~/.claude/plugins/<plugin-name>/
 *     .claude-plugin/plugin.json     ← manifest sentinel
 *     commands/<file>.md             ← optional per-plugin commands
 *     agents/<file>.md               ← optional per-plugin agent definitions
 *     hooks/<file>.json              ← optional per-plugin hook bundles
 *     skills/<skill-name>/SKILL.md   ← optional per-plugin skills
 *     .mcp.json                      ← optional per-plugin MCP server wiring
 *
 * Discovery rules mirror the skills walker:
 *   1. A missing or symlinked plugins root is a no-op (returns empty).
 *   2. Top-level dot-prefixed entries are skipped silently.
 *   3. Symlinked plugin entries are skipped silently.
 *   4. A plugin must contain a real (non-symlink) `.claude-plugin/plugin.json`
 *      file to qualify, so vendored bundles cannot smuggle themselves in via a
 *      symlinked manifest.
 *
 * The walker NEVER throws on filesystem read errors and emits no log output.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { resolveClaudePluginPaths } from "../config/paths";

/** One discovered Claude Code plugin. */
export interface ClaudePluginEntry {
  /** Plugin directory name (also the vault namespace component). */
  name: string;
  /** Absolute path to the plugin root on disk. */
  root: string;
  /** Canonical sub-paths inside the plugin root. */
  paths: ReturnType<typeof resolveClaudePluginPaths>;
}

/**
 * Thrown by {@link validatePluginName} when a plugin name derived from a vault
 * filename or directory entry fails the allow-list. A dedicated subclass
 * lets `applyClaudeVault` catch this specific failure mode and skip the
 * adversarial entry without swallowing unrelated I/O errors.
 */
export class InvalidPluginNameError extends Error {
  constructor(
    public readonly provided: string,
    public readonly reason: string,
  ) {
    super(`Invalid Claude plugin name '${provided}': ${reason}`);
    this.name = "InvalidPluginNameError";
  }
}

/**
 * Validate a plugin name BEFORE it is joined onto the local plugins root.
 * Symmetric to `validateSkillName` in skills-walker.ts — closes the same
 * tar-slip / path-traversal class on the pull side. A vault that contains a
 * directory literally named `..` would otherwise resolve to `~/.claude/`,
 * which is the agent's config root.
 */
export function validatePluginName(name: string): void {
  if (name.length === 0) {
    throw new InvalidPluginNameError(name, "empty");
  }
  if (name === "." || name === "..") {
    throw new InvalidPluginNameError(name, "reserved name");
  }
  if (name.startsWith(".")) {
    throw new InvalidPluginNameError(name, "leading dot is reserved for hidden entries");
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20) {
      throw new InvalidPluginNameError(name, "contains control character");
    }
    if (code === 0x2f || code === 0x5c) {
      throw new InvalidPluginNameError(name, "contains path separator");
    }
  }
}

/**
 * Walk a Claude plugins root and return every entry that qualifies as a real
 * plugin. The walker mirrors {@link collectSkillArtifacts} gating so a
 * vendored pool symlinked into `~/.claude/plugins/` cannot leak through.
 *
 * @param pluginsDir  Absolute path to the plugins root on disk. A missing or
 *                    symlinked root yields an empty result with no warnings.
 */
export async function collectClaudePlugins(pluginsDir: string): Promise<ClaudePluginEntry[]> {
  const entries: ClaudePluginEntry[] = [];

  try {
    const rootStat = await lstat(pluginsDir);
    if (rootStat.isSymbolicLink()) return entries;
    if (!rootStat.isDirectory()) return entries;
  } catch {
    return entries;
  }

  let names: string[];
  try {
    names = await readdir(pluginsDir);
  } catch {
    return entries;
  }

  for (const name of names) {
    if (name.startsWith(".")) continue;

    // Reject names that would escape the plugins root via path.join. We do this
    // up front so a malformed directory entry never reaches the manifest stat.
    try {
      validatePluginName(name);
    } catch {
      continue;
    }

    const root = join(pluginsDir, name);

    let entryStat: Awaited<ReturnType<typeof lstat>>;
    try {
      entryStat = await lstat(root);
    } catch {
      continue;
    }
    if (!entryStat.isDirectory()) continue;

    const paths = resolveClaudePluginPaths(root);

    let manifestStat: Awaited<ReturnType<typeof lstat>>;
    try {
      manifestStat = await lstat(paths.manifest);
    } catch {
      continue;
    }
    if (!manifestStat.isFile()) continue;

    entries.push({ name, root, paths });
  }

  return entries;
}
