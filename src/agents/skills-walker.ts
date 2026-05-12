/**
 * Shared skill-collection helper for every skill-bearing agent (Claude,
 * Cursor, Codex, Copilot). Lives in one place so adapters cannot drift
 * apart on the gating rules. Gates applied in order:
 *
 *   1. Dot-prefixed top-level entries are skipped silently (hidden by convention).
 *   2. Symlinked top-level entries are skipped silently so vendored or
 *      shared-pool skills the user did not author cannot slip in.
 *   3. Entries without a real, non-symlink `SKILL.md` sentinel are skipped
 *      silently so only authored skills sync.
 *   4. Interior paths matching `NEVER_SYNC_PATTERNS` emit a
 *      `never-sync inside skill: ` warning that the push pipeline escalates
 *      to a fatal abort, so secrets nested inside a skill cannot leak. The
 *      same interior walk also runs `scanForSecrets` over each readable
 *      file body and emits `Detected literal secret` warnings. The central
 *      Phase-1 scan in `commands/push.ts` skips `.tar.age` artifacts (base64
 *      scrambles credential prefixes and false-positives on the encoded
 *      alphabet), so a per-file scan inside the bundle is the only layer
 *      that can catch a literal credential pasted into `SKILL.md` or any
 *      other interior file.
 *   5. Interior symlinks are filtered from the tar archive so vendored
 *      files cannot smuggle in through a symlinked child.
 *
 * Silent by design: never throws on filesystem errors, never logs. Errors
 * travel back as warnings on the result so the caller decides how to surface.
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanForSecrets, shouldNeverSync } from "../core/sanitizer";
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
 * Thrown by {@link validateSkillName} when a skill name derived from a vault
 * filename fails the allow-list. A dedicated subclass (rather than a generic
 * `Error`) lets the `applyXxxVault` call sites catch this specific failure
 * mode and log a targeted warning without swallowing unrelated I/O errors.
 */
export class InvalidSkillNameError extends Error {
  constructor(
    public readonly provided: string,
    public readonly reason: string,
  ) {
    super(`Invalid skill name '${provided}': ${reason}`);
    this.name = "InvalidSkillNameError";
  }
}

/**
 * Validate a skill name derived from a vault filename BEFORE it is joined onto
 * the local skills root. This is the trust-boundary check for the pull-side
 * symmetric to the walker's own gates on the push-side.
 *
 * **Why this exists**: `applyXxxSkill(skillName, base64Tar)` is called with
 * `skillName = basename(vaultFile, ".tar.age")`. A compromised vault can
 * contain a file literally named `...tar.age`, which `basename` strips down
 * to `".."`, and `path.join(skillsRoot, "..")` resolves to the agent's
 * config root (e.g. `~/.codex/`). `extractArchive` then writes tar entries
 * into that config root and can overwrite legitimate files like
 * `~/.codex/AGENTS.md` or `~/.codex/config.toml`. The existing tar-slip
 * filter in `src/core/tar.ts::extractArchive` defends against traversing
 * entry paths but does NOT sanitize the `cwd` argument — this validator
 * closes that gap at the caller.
 *
 * Rules MUST reject every name that could:
 *   - resolve to a different directory under `path.join` (`.`, `..`, empty)
 *   - contain a path separator on any platform (`/` on POSIX, `\` on Windows)
 *   - collide with hidden-file rules the walker applies on the push side
 *     (dot-prefixed names are silently skipped during push, so pull must
 *     not manufacture them or the next push would drop them)
 *   - smuggle control characters or NUL bytes that shell or filesystem
 *     layers might interpret inconsistently
 *
 * @param name  The skill basename, typically from `basename(vaultFile, ".tar.age")`.
 * @throws {InvalidSkillNameError} if the name fails any rule above.
 */
export function validateSkillName(name: string): void {
  if (name.length === 0) {
    throw new InvalidSkillNameError(name, "empty");
  }
  if (name === "." || name === "..") {
    throw new InvalidSkillNameError(name, "reserved name");
  }
  if (name.startsWith(".")) {
    throw new InvalidSkillNameError(name, "leading dot is reserved for hidden entries");
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20) {
      throw new InvalidSkillNameError(name, "contains control character");
    }
    if (code === 0x2f || code === 0x5c) {
      throw new InvalidSkillNameError(name, "contains path separator");
    }
  }
}

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
 *                   an empty result. A skills root that is itself a
 *                   symbolic link is also rejected (returns empty) under the
 *                   "skills I created" spec intent — the same anti-vendoring
 *                   rule that rejects symlinked entries individually
 *                   extends to the root by consistency.
 * @returns          A {@link SkillsWalkerResult} with one artifact per
 *                   qualifying skill and zero or more warnings: each
 *                   `never-sync inside skill: ` warning is escalated to a
 *                   fatal abort by the push pipeline, and each
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
  // empty no-op as a missing directory.
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
    // missing or unreadable skills root is a no-op, not an error.
    return { artifacts, warnings };
  }

  for (const entryName of entries) {
    // Gate 1: skip dot-prefixed entries silently.
    if (entryName.startsWith(".")) continue;

    const entryPath = join(skillsDir, entryName);

    let entryStat: Awaited<ReturnType<typeof lstat>>;
    try {
      entryStat = await lstat(entryPath);
    } catch {
      continue;
    }

    // Gate 2: reject anything that is not a real directory.
    // A symlink (even one pointing at a directory) fails isDirectory() under
    // lstat — there is no separate symlink check needed.
    if (!entryStat.isDirectory()) continue;

    // Gate 3: require a REAL `SKILL.md` file.
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

    // Gate 4: interior violation walk. A single pass collects both
    // never-sync hits (path-pattern only) and literal secret hits
    // (file-body scan). The walker collects every match in the skill —
    // not just the first — so the user sees every offender in one push
    // instead of fixing them one at a time. Literal-secret coverage at
    // this layer closes the bundle-internals gap: the central scan in
    // `commands/push.ts` skips `.tar.age` artifacts because base64 of a
    // tar buffer is both scramble-prone and false-positive prone.
    const violations = await collectInteriorViolations(entryPath);
    if (violations.neverSyncHits.length > 0 || violations.secretWarnings.length > 0) {
      for (const hit of violations.neverSyncHits) {
        warnings.push(`${NEVER_SYNC_WARNING_PREFIX}${hit}`);
      }
      warnings.push(...violations.secretWarnings);
      // Skip the artifact entirely so encryption never sees the bad bytes,
      // even in the unlikely event that the push gate is later removed.
      continue;
    }

    // Gate 5: archive with interior symlinks filtered out.
    let tarBuffer: Buffer;
    try {
      tarBuffer = await archiveDirectory(entryPath, { skipSymlinks: true });
    } catch (err) {
      // Distinct from the dot-skip and symlink silent skips: a tar failure here
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
 * Walk a real skill directory and surface every interior gate violation in
 * one pass. Returned shape:
 *
 *   - `neverSyncHits`  — absolute paths of files whose path matches a
 *                        {@link shouldNeverSync} rule (gate 4a, path-only).
 *   - `secretWarnings` — `Detected literal secret …` warnings emitted by
 *                        {@link scanForSecrets} over each readable file
 *                        body (gate 4b, body-scan). The full warning
 *                        string from `scanForSecrets` is preserved so the
 *                        push pipeline's existing `Detected literal secret`
 *                        prefix check fires unchanged.
 *
 * One pass means each interior file is `lstat`-ed and read at most once,
 * and both gates share the same symlink-skipping rules.
 *
 * Symlinks (files OR sub-directories) are NOT followed and NOT inspected.
 * This matches the skills-walker caller, which then calls
 * `archiveDirectory(skillDir, { skipSymlinks: true })`. The Copilot agents
 * caller in `src/agents/copilot.ts` currently passes `archiveDirectory` its
 * default (`skipSymlinks: false`) for backwards-compatibility with existing
 * agent tarballs, so an interior symlink there is skipped by the body-scan
 * but its target-path string is still archived. node-tar archives symlinks
 * as `SymbolicLink` entries (target path only, not target content), so this
 * does not exfiltrate credential bodies through a vendored helper — but
 * callers that need full symmetry should pass `{ skipSymlinks: true }`.
 *
 * File-body reads use UTF-8. Permission errors and transient I/O silently
 * skip the body scan for that file — the path-only never-sync check still
 * runs against the path. Binary content does NOT throw under UTF-8: Node
 * substitutes U+FFFD for invalid sequences and returns a string, so the
 * regex still executes against the decoded bytes. This is intentional —
 * `EMBEDDED_SECRET_PATTERNS` are anchored on real credential prefixes
 * (`sk-ant-api03-`, `AKIA…`, `AIza…`, …) with realistic length floors, so
 * random binary bytes virtually never match while a credential pasted into
 * a binary blob is still caught. Do NOT add a binary-detection early-return
 * here without a measured false-positive case; it would only weaken coverage.
 */
export interface InteriorViolations {
  neverSyncHits: string[];
  secretWarnings: string[];
}

export async function collectInteriorViolations(rootDir: string): Promise<InteriorViolations> {
  const neverSyncHits: string[] = [];
  const secretWarnings: string[] = [];

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
        // Skip vendored content. The skills-walker caller filters interior
        // symlinks out of the tar archive via `skipSymlinks: true`; the
        // Copilot agents caller currently does not, so a symlink there is
        // archived as a `SymbolicLink` entry (path string only, not target
        // content). See the symmetry note in `collectInteriorViolations`'s
        // contract docstring above.
        continue;
      }

      if (childStat.isDirectory()) {
        await walk(childPath);
        continue;
      }
      if (!childStat.isFile()) continue;

      if (shouldNeverSync(childPath)) {
        neverSyncHits.push(childPath);
        // Do not also body-scan a never-sync file: it is rejected by path,
        // and reading it would leak its contents into memory for no benefit.
        continue;
      }

      let body: string;
      try {
        body = await readFile(childPath, "utf8");
      } catch {
        // Binary content, EACCES, or transient I/O — the path-only gate
        // above is already best-effort for non-readable files. Skip silently.
        continue;
      }
      secretWarnings.push(...scanForSecrets(body, childPath));
    }
  }

  await walk(rootDir);
  return { neverSyncHits, secretWarnings };
}
