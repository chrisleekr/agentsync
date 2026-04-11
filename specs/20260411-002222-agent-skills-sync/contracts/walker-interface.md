# Contract: Shared Skills Walker Interface

**Feature**: 20260411-002222-agent-skills-sync
**Module**: `src/agents/skills-walker.ts` (new)
**Scope**: The exported surface of the walker, the invariants it upholds, and the behavioral guarantees that `claude.ts`, `cursor.ts`, `codex.ts`, and the `copilot.ts` retrofit all depend on.

---

## Exported surface

```ts
/**
 * Walk an agent's local skills root and collect encrypted-ready tar artifacts
 * for every directory that qualifies as a user-created skill.
 *
 * Gates applied in order:
 *   1. Entry name does not start with "."                              (FR-017)
 *   2. Entry is a real directory per lstat (not a symlink)             (FR-016 outer)
 *   3. Entry contains a SKILL.md file that is itself a real regular
 *      file per lstat (not a symlink)                                  (FR-002 + FR-016 sentinel)
 *   4. No file inside the entry matches NEVER_SYNC_PATTERNS            (FR-006)
 *   5. The tar.gz archive produced for the entry omits every interior
 *      symlink while keeping every real file and real sub-directory    (FR-016 inner)
 *
 * @param agent        The skill-bearing agent namespace to write artifacts
 *                     under (`claude`, `cursor`, `codex`, `copilot`). The
 *                     parameter type `SkillBearingAgent` excludes `vscode`
 *                     at compile time, so no runtime no-op branch is needed.
 * @param skillsDir    Absolute path to the agent's skills root on disk.
 *                     A missing directory is NOT an error — the walker
 *                     returns { artifacts: [], warnings: [] }.
 *
 * @returns            SkillsWalkerResult with one artifact per qualifying
 *                     skill and zero or more `never-sync inside skill: `
 *                     warnings for skills rejected at gate 4.
 */
export async function collectSkillArtifacts(
  agent: SkillBearingAgent,
  skillsDir: string,
): Promise<SkillsWalkerResult>;
```

The walker is the **only** function that owns the five gates. Agent adapters call it once per agent, spread its output into their own `SnapshotResult`, and return. They do not re-implement any of the gates themselves.

---

## Invariants the walker MUST uphold

### Silence on non-failures (R7, FR-017)

- Entries skipped by gate 1 (dot-prefixed) MUST NOT produce any warning, log line, or artifact. `artifacts.length` goes down; `warnings.length` does not go up.
- Entries skipped by gate 2 (symlink root) MUST NOT produce any warning, log line, or artifact.
- Entries skipped by gate 3 (missing or symlinked `SKILL.md`) MUST NOT produce any warning, log line, or artifact.
- An entire skill directory that archives successfully but contains interior symlinks MUST produce exactly one artifact and zero warnings. The interior symlinks are silently omitted from the tarball (FR-016 inner tier).

### Noisy only on the one failure that aborts the whole push (R3, FR-006)

- A never-sync match inside a real, otherwise-qualifying skill directory MUST produce:
  - **Zero** artifacts for that specific skill (the walker refuses to archive).
  - Exactly one entry in `warnings`, prefixed with `"never-sync inside skill: "` followed by the absolute path of the offending file.
- Multiple never-sync hits across different skills MUST produce multiple warning entries — one per offending path — so the user can fix them all in a single cycle instead of discovering them one at a time.
- The walker MUST NOT throw on a never-sync hit. The push gate in `src/commands/push.ts` converts the warning to a fatal error.

### Missing directory = no-op, not an error (FR-009)

- If `skillsDir` does not exist, is not a directory, or cannot be read due to permissions, the walker MUST return `{ artifacts: [], warnings: [] }` without throwing.
- The walker MUST NOT create the directory as a side-effect.

### `lstat` is the only stat-family syscall used for "is it a symlink?" decisions (R4)

- `stat` (which follows symlinks) MUST NOT be used to check whether a directory entry is a symlink.
- `lstat` is authoritative for gate 2 (root), gate 3 (sentinel), and gate 5 (interior walk).
- Using `fs/promises` `lstat` is preferred; `lstatSync` is acceptable inside the tar `filter` callback where async is unavailable.

### Output paths match the vault path contract

- Every `SkillArtifact.vaultPath` produced by the walker MUST match the template `<agent>/skills/<name>.tar.age`, where `<agent>` is the walker's input argument and `<name>` is the basename of the directory that passed all five gates. See `contracts/vault-paths.md`.

### Base64 deterministic encoding

- `SkillArtifact.plaintext` MUST be `buffer.toString("base64")` where `buffer` is the result of `archiveDirectory(skillDir, { skipSymlinks: true })`. This matches the existing Copilot convention at `src/agents/copilot.ts:95` so status-command SHA-256 comparisons behave identically across all four agents.

---

## Behavioral matrix (for tests at `src/agents/__tests__/skills-walker.test.ts`)

The walker's test suite MUST cover at least these rows. Each row is an independent fixture directory that the test creates inside a tmp dir, passes to `collectSkillArtifacts("claude", tmpDir)`, and asserts on the returned shape.

| # | Fixture | Expected `artifacts.length` | Expected `warnings` |
| - | ------- | --------------------------- | ------------------- |
| 1 | Empty tmp dir | 0 | `[]` |
| 2 | Missing tmp dir (not created) | 0 | `[]` |
| 3 | Real skill `my-skill/SKILL.md` + `my-skill/README.md` | 1 | `[]` |
| 4 | Real skill `my-skill/` with no `SKILL.md` | 0 | `[]` |
| 5 | Real skill `my-skill/` where `SKILL.md` is a symlink to another file | 0 | `[]` |
| 6 | Top-level symlink `my-skill -> /tmp/other/my-skill` with valid target | 0 | `[]` |
| 7 | Top-level `.system/` directory containing a real skill | 0 | `[]` |
| 8 | Top-level `.DS_Store` regular file | 0 | `[]` |
| 9 | Real skill `a/SKILL.md` + another real skill `b/SKILL.md` + symlinked root `c/` | 2 | `[]` |
| 10 | Real skill whose interior contains a symlinked helper file | 1 | `[]` (the helper is omitted silently) |
| 11 | Real skill containing a file whose path matches `NEVER_SYNC_PATTERNS` (e.g. `./credentials.json`) | 0 (the skill is not archived) | 1 warning of the form `never-sync inside skill: <absolute path>` |
| 12 | Two real skills, one of which has a never-sync match | 0 for the matched skill, 1 for the clean one → `artifacts.length === 1` | 1 warning of the form `never-sync inside skill: <absolute path>` |

Row 12 is the important edge: the walker does not short-circuit on the first never-sync match, it collects the whole picture. The push gate then decides to escalate. This matches the "list every offender" UX from research R3.

---

## What the walker does NOT do

- The walker does NOT call `archiveDirectory` with `skipSymlinks: false`. The `skipSymlinks: true` flag is always passed (R2).
- The walker does NOT encrypt. Encryption is performed by `performPush` after the walker returns.
- The walker does NOT write any file. It reads from disk, builds in-memory `SkillArtifact` objects, and returns them.
- The walker does NOT commit, push, or touch any Git state.
- The walker does NOT deduplicate skills across agents. Each agent adapter calls the walker once with its own `skillsDir`, and the vault namespace isolation (`<agent>/skills/`) keeps results from colliding.
- The walker does NOT emit log lines at any level. All user-visible output is the responsibility of the push command (for warnings) and `log` utility helpers in the command layer.

---

## Relationship to existing agent adapters

After this feature lands, each of `snapshotClaude`, `snapshotCursor`, `snapshotCodex`, and `snapshotCopilot` will:

1. Do its current non-skill work (instructions, commands, rules, MCP, etc.) as today.
2. Call `collectSkillArtifacts(<agent>, AgentPaths.<agent>.skillsDir)`.
3. Spread `walker.artifacts` into its own `artifacts` array.
4. Spread `walker.warnings` into its own `warnings` array.
5. Return `{ artifacts, warnings }`.

For Copilot specifically, step 2 replaces the existing inline skill-collection block at `src/agents/copilot.ts:82-101`. The block is removed; the walker takes over. This is the retrofit that brings Copilot into FR-016 / FR-017 compliance without duplicating logic.
