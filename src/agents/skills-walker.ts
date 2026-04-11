/**
 * src/agents/skills-walker.ts
 *
 * Shared skill-collection helper used by every skill-bearing agent adapter
 * (Claude, Cursor, Codex, Copilot). Encapsulates the five gates required by
 * the agent-skills-sync feature so the rules live in exactly one place:
 *
 *   1. FR-017 — top-level dot-prefixed entries are skipped (silent).
 *   2. FR-016 — entries that are symlinks are skipped (silent).
 *   3. FR-002 — entries without a real (non-symlink) `SKILL.md` sentinel are
 *               skipped (silent).
 *   4. FR-006 — interior file paths matching `NEVER_SYNC_PATTERNS` cause the
 *               skill to be rejected with a `never-sync inside skill:`
 *               warning that the push pipeline escalates to a fatal error.
 *   5. FR-016 — interior symlink files and sub-directories are omitted from
 *               the archive while real surrounding content is still archived.
 *
 * The walker NEVER throws on filesystem read errors and NEVER emits log
 * output. Quiet by design — see contracts/walker-interface.md for the rules.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { shouldNeverSync } from "../core/sanitizer";
import { archiveDirectory } from "../core/tar";
import type { SnapshotArtifact, SnapshotResult } from "./_utils";

/**
 * Agents that may host skill directories. VS Code is intentionally excluded
 * because the editor does not have a user-skills concept; encoding that here
 * keeps the walker's input domain narrower than the full `AgentName` union.
 */
export type SkillBearingAgent = "claude" | "cursor" | "codex" | "copilot";

/**
 * Result returned by {@link collectSkillArtifacts}. Structurally identical to
 * `SnapshotResult` — exported as a distinct alias so call sites and the
 * walker contract document line up under the same name.
 */
export type SkillsWalkerResult = SnapshotResult;

/** Warning prefix emitted when a never-sync rule matches inside a skill. */
const NEVER_SYNC_WARNING_PREFIX = "never-sync inside skill: ";

/** Warning prefix emitted when `archiveDirectory` fails on an otherwise-valid skill. */
const ARCHIVE_FAILURE_WARNING_PREFIX = "skill archive failed: ";

/**
 * Walk an agent's local skills root and collect encrypted-ready tar artifacts
 * for every directory that qualifies as a user-created skill.
 *
 * Gates are applied in the order documented in
 * `specs/20260411-002222-agent-skills-sync/contracts/walker-interface.md`.
 *
 * @param agent      Vault namespace this walker writes under (`claude`, `cursor`, `codex`, `copilot`).
 * @param skillsDir  Absolute path to the agent's skills root on disk. A
 *                   missing directory is NOT an error — the walker returns
 *                   an empty result (FR-009). A skills root that is itself a
 *                   symbolic link is also rejected (returns empty) under the
 *                   "skills I created" spec intent — the same anti-vendoring
 *                   rule that FR-016 applies to individual skill entries
 *                   extends to the root by consistency.
 * @returns          A {@link SkillsWalkerResult} with one artifact per
 *                   qualifying skill and zero or more warnings: each
 *                   `never-sync inside skill: ` warning is escalated to a
 *                   fatal abort by the push pipeline (FR-006), and each
 *                   `skill archive failed: ` warning is surfaced as a soft
 *                   warning to the user without aborting the push.
 *                   The walker NEVER throws on filesystem read errors.
 */
export async function collectSkillArtifacts(
  agent: SkillBearingAgent,
  skillsDir: string,
): Promise<SkillsWalkerResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  // Reject a symlinked skills root before reading it. Node's `readdir` follows
  // symlinks on its argument by default, so without this guard a user with
  // `~/.claude/skills -> /srv/team-pool` would silently sync every team
  // skill as if it were their own. The check is intentionally `lstat` so a
  // missing path falls through to the catch block below and yields the same
  // empty no-op as a missing directory (FR-009).
  try {
    const rootStat = await lstat(skillsDir);
    if (rootStat.isSymbolicLink()) return { artifacts, warnings };
  } catch {
    return { artifacts, warnings };
  }

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    // FR-009: missing or unreadable skills root is a no-op, not an error.
    return { artifacts, warnings };
  }

  for (const entryName of entries) {
    // Gate 1 (FR-017): skip dot-prefixed entries silently.
    if (entryName.startsWith(".")) continue;

    const entryPath = join(skillsDir, entryName);

    let entryStat: Awaited<ReturnType<typeof lstat>>;
    try {
      entryStat = await lstat(entryPath);
    } catch {
      continue;
    }

    // Gate 2 (FR-016 outer): reject anything that is not a real directory.
    // A symlink (even one pointing at a directory) fails isDirectory() under
    // lstat — there is no separate symlink check needed.
    if (!entryStat.isDirectory()) continue;

    // Gate 3 (FR-002 + FR-016 sentinel guard): require a REAL `SKILL.md` file.
    // Using lstat means a symlinked SKILL.md fails the isFile() check, so
    // vendored skills cannot smuggle themselves in via a symlinked sentinel.
    const sentinelPath = join(entryPath, "SKILL.md");
    let sentinelStat: Awaited<ReturnType<typeof lstat>>;
    try {
      sentinelStat = await lstat(sentinelPath);
    } catch {
      continue;
    }
    if (!sentinelStat.isFile()) continue;

    // Gate 4 (FR-006): never-sync interior walk. The walker collects every
    // matching path in the skill — not just the first — so the user sees
    // every offender in one push instead of fixing them one at a time.
    const neverSyncHits = await collectNeverSyncHits(entryPath);
    if (neverSyncHits.length > 0) {
      for (const hit of neverSyncHits) {
        warnings.push(`${NEVER_SYNC_WARNING_PREFIX}${hit}`);
      }
      // Skip the artifact entirely so encryption never sees the bad bytes,
      // even in the unlikely event that the push gate is later removed.
      continue;
    }

    // Gate 5 (FR-016 inner): archive with interior symlinks filtered out.
    let tarBuffer: Buffer;
    try {
      tarBuffer = await archiveDirectory(entryPath, { skipSymlinks: true });
    } catch (err) {
      // Distinct from the FR-017 / FR-016 silent skips: a tar failure here
      // means the user DID intend the skill to sync but the machine failed
      // (EACCES, EMFILE, transient I/O, etc.). Surfacing this as a warning
      // gives the user a fighting chance to notice and fix it. The push
      // pipeline does NOT escalate this prefix to a fatal abort — only the
      // never-sync prefix is fatal — so a single broken skill never blocks
      // the rest of the push.
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${ARCHIVE_FAILURE_WARNING_PREFIX}${entryPath} — ${message}`);
      continue;
    }

    artifacts.push({
      vaultPath: `${agent}/skills/${entryName}.tar.age`,
      sourcePath: entryPath,
      // Base64 so the binary tar bytes survive the UTF-8 string layer that
      // performPush feeds into encryptString.
      plaintext: tarBuffer.toString("base64"),
      warnings: [],
    });
  }

  return { artifacts, warnings };
}

/**
 * Walk a real skill directory and return the absolute paths of every interior
 * file whose path matches a {@link shouldNeverSync} rule.
 *
 * Symlinks (files OR sub-directories) are NOT followed and NOT inspected,
 * which is consistent with FR-016: vendored content reached via a symlink is
 * out of scope for this feature and will not be archived in gate 5 either.
 */
async function collectNeverSyncHits(rootDir: string): Promise<string[]> {
  const hits: string[] = [];

  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }

    for (const name of names) {
      const childPath = join(dir, name);
      let childStat: Awaited<ReturnType<typeof lstat>>;
      try {
        childStat = await lstat(childPath);
      } catch {
        continue;
      }

      if (childStat.isSymbolicLink()) {
        // Don't follow vendored content. The interior-symlink rule (FR-016
        // inner) means it would be omitted from the tar in gate 5 anyway.
        continue;
      }

      if (childStat.isDirectory()) {
        await walk(childPath);
      } else if (childStat.isFile() && shouldNeverSync(childPath)) {
        hits.push(childPath);
      }
    }
  }

  await walk(rootDir);
  return hits;
}
