---
description: "Task list for the agent-skills-sync feature"
---

# Tasks: Sync Agents' Skills

**Input**: Design documents from `/specs/20260411-002222-agent-skills-sync/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: This feature ships runtime source code changes across several agent adapters and a new CLI verb. It does **not** qualify for the constitution's documentation-only exception (recorded in plan.md Constitution Check). **Automated tests are required** for both the success path and at least one error or edge-case path of every new module, plus the manual cross-machine walkthrough in `quickstart.md`. TDD ordering is observed: every implementation task is preceded by a failing test task.

**Organization**: Tasks are grouped by user story so each story (Claude P1, Codex P2, Cursor P3) can be implemented, tested, and shipped independently. The `skill remove` verb (FR-012/FR-013) is cross-cutting and lives in its own phase between the user stories and Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Maps to a user story from spec.md (US1, US2, US3). Setup, Foundational, Cross-cutting, and Polish phases have NO story label
- All file paths are absolute or repo-rooted; LLMs executing a task must not have to guess where to write

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the feature branch is in a buildable state before any code changes land. AgentSync's repo, dependencies, and Bun toolchain are already in place — there is no scaffolding work to do.

- [X] T001 Verify the feature branch baseline by running `bun install` followed by `bun run check` from the repo root and confirming both succeed before any task in Phase 2 begins. Record the resulting commit SHA in the PR description as the "pre-feature green commit" so regressions introduced by later phases are easy to bisect.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Build the shared infrastructure that every user story and the cross-cutting `skill remove` verb consume: the new `AgentPaths.<agent>.skillsDir` entries, the `archiveDirectory` symlink filter, the shared `skills-walker` module, the push-side never-sync gate extension, the Copilot retrofit (which is the safety regression check that proves the walker honors FR-016/FR-017), and the doctor extension for the new directories.

**⚠️ CRITICAL**: No user story phase (US1/US2/US3) and no cross-cutting `skill remove` work may begin until Phase 2 is complete. The walker is the single source of truth for FR-002/FR-006/FR-016/FR-017, and every story consumes it.

- [X] T002 Extend `src/config/paths.ts` to add `skillsDir` to the `claude`, `cursor`, and `codex` entries. Use `join(HOME, ".claude", "skills")`, `join(HOME, ".cursor", "skills")` (the FR-010 canonical path), and `join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "skills")` respectively. Do NOT add a `skillsDir` to the `vscode` entry (data-model.md cross-cutting invariant). The Copilot entry already has `skillsDir`; leave it untouched.
- [X] T003 [P] Extend `src/config/__tests__/paths.test.ts` with assertions that `AgentPaths.claude.skillsDir`, `AgentPaths.cursor.skillsDir`, and `AgentPaths.codex.skillsDir` are non-empty strings ending in `/skills` (after the join). Include a regression assertion that `AgentPaths.vscode` does NOT contain a `skillsDir` key, so an accidental future addition fails this test.
- [X] T004 [P] Extend `src/core/__tests__/tar.test.ts` with three failing tests for `archiveDirectory(dir, { skipSymlinks: true })`. (1) **Symlink filter**: a tmp dir containing one real `SKILL.md`, one symlinked file (`./helper.md` → `/tmp/something`), and one symlinked sub-directory (`./refs` → `/tmp/elsewhere`); extracting the resulting tar to a fresh tmp dir yields exactly `SKILL.md` and no other entries. (2) **Default behavior preserved**: calling `archiveDirectory(dir)` without the flag still archives symlink entries unchanged so existing Copilot agent tarballs are not regressed. (3) **Tar determinism for status hash stability** (closes the research R9 caveat): build a fixture, call `archiveDirectory(dir, { skipSymlinks: true })` twice in the same test, and assert `Buffer.equals(buf1, buf2)`. If this assertion fails on Bun's tar v7, the fix is to pass `mtime: new Date(0)` (or equivalent) to the `tarCreate` options so file mtimes do not leak into the gzip stream — the property is required by SC-003 because the status command's SHA-256 comparison depends on `archiveDirectory` producing identical bytes for the same directory tree.
- [X] T005 Extend `src/core/tar.ts::archiveDirectory` with an opt-in `options?: { skipSymlinks?: boolean }` parameter. When `options.skipSymlinks === true`, install a synchronous `filter: (path, stat) => !stat.isSymbolicLink()` callback on the `tarCreate` call. The default (`undefined` or `false`) preserves the current behavior bit-for-bit. Update the JSDoc on the function to document the new parameter, including the rationale that the flag is opt-in to keep the existing Copilot agent-tarball callers (`copilot.ts:104-120`) unchanged. Verify T004 now passes.
- [X] T006 [P] Create `src/agents/__tests__/skills-walker.test.ts` with the 12-row behavioral matrix from `contracts/walker-interface.md`. Each row is an independent fixture under a tmp dir built with `node:fs/promises` and (where needed) `symlink`. Assert on `result.artifacts.length` and the prefix(es) of `result.warnings`. Row 12 (multiple skills, one with a never-sync match) is the most important — it MUST assert that `artifacts.length === 1` (the clean skill is collected) AND that `warnings` contains exactly one `"never-sync inside skill: "` entry (the dirty skill is reported but not archived). All assertions on `warnings` MUST use `expect(...).toStartWith(...)` to lock the prefix without coupling to the absolute path text.
- [X] T007 Create `src/agents/skills-walker.ts` exporting `collectSkillArtifacts(agent: AgentName, skillsDir: string): Promise<SkillsWalkerResult>`. Implement the five gates in order from `contracts/walker-interface.md`: (1) skip names starting with `.`; (2) skip entries that fail `lstat().isDirectory()` (this rejects both files and symlinks naturally); (3) skip when `<dir>/SKILL.md` is missing or fails `lstat().isFile()`; (4) walk the interior with `readdir` + `lstat`, run `shouldNeverSync` on every file path, and on any match emit a `"never-sync inside skill: <abs-path>"` warning AND skip the artifact for that skill; (5) call `archiveDirectory(skillDir, { skipSymlinks: true })` to produce the tar. Output `vaultPath: \`${agent}/skills/${name}.tar.age\``, `sourcePath: <abs skill dir>`, `plaintext: tarBuffer.toString("base64")`. Add full JSDoc per Constitution Principle V. Verify T006 passes.
- [X] T008 [P] Extend `src/commands/__tests__/push.test.ts` (create the file if absent under `src/commands/__tests__/`) with a failing test that builds a Claude skills root containing one valid skill plus one skill whose interior contains a file matching a `NEVER_SYNC_PATTERNS` entry (use `auth.json` as the canonical example since it appears literally in `src/core/sanitizer.ts`). Run `performPush({ dryRun: false })` against a tmp vault, then assert: the function returned `{ pushed: 0, fatal: true }`, the `errors` array contains a string starting with `"Push aborted"`, and zero `.age` files exist under `<tmpVault>/claude/skills/`. The test must run with `__setPushAgentsForTesting` to limit the agents iterated.
- [X] T009 Extend `src/commands/push.ts` Phase-1 gate (the loop at `push.ts:80-98` that currently matches `"Redacted literal secret"`) so it ALSO matches the prefix `"never-sync inside skill: "` and escalates those warnings to `secretErrors`. Update the abort message preamble so the user sees a distinct phrase for never-sync hits versus literal secrets, then the same `secretErrors` list. Verify T008 passes.
- [X] T010 [P] Extend `src/agents/__tests__/copilot.test.ts` with three new failing tests against the retrofitted walker behavior: (1) a top-level symlinked skill root produces zero artifacts; (2) a top-level `.system/` directory produces zero artifacts; (3) a real skill containing one symlinked helper file inside produces exactly one artifact whose tar contains the real files but not the symlinked helper. Use the same test scaffolding the existing `snapshotCopilot` tests use (they already mutate `testCopilotPaths` under a tmp dir).
- [X] T011 Retrofit `src/agents/copilot.ts::snapshotCopilot` by replacing the inline skill collection block at `copilot.ts:82-101` with a single `const skillsResult = await collectSkillArtifacts("copilot", AgentPaths.copilot.skillsDir);` call followed by `artifacts.push(...skillsResult.artifacts)` and `warnings.push(...skillsResult.warnings)`. Delete the now-unused `fileExists` helper at `copilot.ts:12-20` (it was a `stat`-based check that the walker no longer needs). Verify T010 passes AND every existing copilot test still passes (this is the no-regression check).
- [X] T012 [P] Extend `src/commands/__tests__/integration.test.ts` (or create `src/commands/__tests__/doctor.test.ts` if it does not yet exist; check first) with a failing test that runs `doctorCommand`'s logic against a tmp `$HOME` containing a readable `~/.claude/skills/`, a readable `~/.codex/skills/`, and a missing `~/.cursor/skills/`, and asserts the resulting checks list contains one `pass` row per readable skills directory and one `warn` row for the missing one. Each row's `name` MUST be agent-specific (e.g., `"Claude skills directory"`).
- [X] T013 Extend `src/commands/doctor.ts` with three new check rows immediately after the existing "Claude settings.json" check block: one for each of `AgentPaths.claude.skillsDir`, `AgentPaths.codex.skillsDir`, `AgentPaths.cursor.skillsDir`. Each check uses `access(path, constants.R_OK)` to mirror the existing pattern, returns `pass` when readable, `warn` when missing or unreadable, and includes the absolute path in `detail`. Do NOT add a row for Copilot — it already has its directory wired through other paths and FR-008 is scoped to the *new* dirs. Verify T012 passes. (Anchor by textual marker, not line number — line numbers drift.)
- [X] T035 [P] Extend `src/commands/__tests__/status.test.ts` with a failing test that closes the **FR-007 automated-coverage gap** flagged by the analysis. Use the **already-retrofitted Copilot skill path** (depends on T011) so this test can land in Phase 2 without waiting for any user story. Setup: build a tmp `$HOME` with one real `~/.copilot/skills/my-skill/SKILL.md` plus a tmp vault containing the matching encrypted `copilot/skills/my-skill.tar.age` artifact (encrypt directly with the existing `encryptString` helper — no need to invoke `performPush`). Run the status command's logic (via the existing test hook pattern in `src/commands/__tests__/status.test.ts`, or factor a testable function out of `statusCommand.run` if no hook exists). Assert: exactly one row has `agent: copilot`, `file` ending in `.copilot/skills/my-skill`, and `status: synced`. Then mutate the local skill on disk (write a different file inside the directory), re-run, and assert the same row now reports `local-changed`. This is the regression net for the research R9 assumption that the existing `collectAgeFiles` walker picks up new artifacts without status-side code changes — and proves FR-007 holds for any agent that produces `<agent>/skills/<name>.tar.age` artifacts.
- [X] T036 [P] Extend `src/commands/__tests__/push.test.ts` (the same file T008 creates or extends) with a failing test that closes the **FR-011 / SC-006 additive-default automated-coverage gap** flagged by the analysis. Use the Copilot skill path (depends on T011) so this test can land in Phase 2. Setup: build a tmp `$HOME` with one real `~/.copilot/skills/my-skill/SKILL.md`, run `performPush({ dryRun: false })` against a tmp vault, capture the byte content of `<vault>/copilot/skills/my-skill.tar.age` with `readFile`. Then `rm -rf` the local `~/.copilot/skills/my-skill/` directory and run `performPush` again. Assert: (a) the second call returns `pushed: 0` (no new artifacts written for the deleted skill), (b) `<vault>/copilot/skills/my-skill.tar.age` still exists, (c) its byte content is `Buffer.equals` to the captured snapshot. This proves a local delete does NOT mutate the vault — the additive-by-default property of FR-011 / SC-006 — which is the safety guarantee that makes `agentsync skill remove` (Phase 6) the only way a skill leaves the vault.

**Checkpoint**: At the end of Phase 2, the walker is callable from any agent adapter, the tar filter rejects symlinks under the new flag AND produces deterministic bytes for status hashing, the push pipeline aborts on never-sync inside a skill, the Copilot pipeline already honors FR-016/FR-017, status surfaces skill drift for any agent, additive-by-default push is proven by an automated test, and `doctor` reports on the three new directories. Run `bun run check` here as a phase-end gate before moving on.

---

## Phase 3: User Story 1 - Claude skills follow me to a new laptop (Priority: P1) 🎯 MVP

**Goal**: A user-created skill under `~/.claude/skills/<name>/` round-trips through the encrypted vault and lands on a fresh second machine in exactly the same place after `pull`. This is the highest-value slice — the spec ranks it P1 because Claude is the primary daily driver and skills are the richest per-user Claude configuration.

**Independent Test**: Populate `~/.claude/skills/my-skill/SKILL.md` on machine A, run `agentsync push`, run `agentsync pull` on a second machine with an empty `~/.claude/skills/`, and confirm the same skill tree exists at `~/.claude/skills/my-skill/` on machine B with identical contents — quickstart.md steps 2–4.

### Tests for User Story 1 (REQUIRED — runtime feature, no documentation-only exception) ⚠️

- [X] T014 [US1] Extend `src/agents/__tests__/claude.test.ts` with failing tests for the Claude skill round-trip. Include: (1) a happy-path snapshot test that creates `~/.claude/skills/my-skill/SKILL.md` plus `~/.claude/skills/my-skill/notes.md` and asserts `snapshotClaude()` returns one artifact with `vaultPath === "claude/skills/my-skill.tar.age"` and a non-empty base64 `plaintext`; (2) an apply-side test that calls `applyClaudeSkill("my-skill", base64Tar)` (where `base64Tar` is built with `archiveDirectory(srcDir)`) and asserts the files appear under the test's tmp `claude.skillsDir`; (3) an `applyClaudeVault` integration test that sets up an encrypted `claude/skills/my-skill.tar.age` artifact in a tmp vault and asserts `applyClaudeVault(vaultDir, key, false)` restores the directory; (4) a dry-run test (`applyClaudeVault(..., true)`) that asserts the local skills dir was NOT touched; (5) **FR-009 missing-dir case**: point `testClaudePaths.skillsDir` at a tmp path that does NOT exist on disk, run `snapshotClaude()`, and assert it returns an empty skill-artifact list, zero warnings, and does NOT throw — the missing dir is a no-op, not an error; (6) **FR-016 interior-symlink at the agent layer (defense-in-depth for the walker)**: build a real `~/.claude/skills/my-skill/` containing `SKILL.md` plus a `helper.md` symlink, run `snapshotClaude()`, decrypt the resulting base64 tar to a tmp dir, and assert `helper.md` is absent while every real file is present. Use the existing claude.test.ts mutation pattern (`testClaudePaths.skillsDir = join(tmpDir, "skills")`); add `skillsDir` to the `MutableClaudePaths` type if it's not already there.
- [X] T015 [P] [US1] Extend `src/agents/__tests__/claude.test.ts` with three Claude-specific edge-case tests built on the walker contract: (a) a top-level symlinked skill root must NOT appear in `snapshotClaude()`'s artifacts; (b) a `~/.claude/skills/.system/` directory must NOT appear; (c) a real skill whose `SKILL.md` is itself a symlink must NOT appear. These mirror the walker tests at the agent layer to prove the wiring is correct.

### Implementation for User Story 1

- [X] T016 [US1] Extend `src/agents/claude.ts::snapshotClaude` (currently at `claude.ts:18-95`) to call `collectSkillArtifacts("claude", AgentPaths.claude.skillsDir)` after the existing `agentsDir` block, then spread `walker.artifacts` into `artifacts` and `walker.warnings` into `warnings`. Add a new exported `applyClaudeSkill(skillName: string, base64Tar: string): Promise<void>` helper that mirrors `applyCopilotSkill` (`copilot.ts:148-153`): `mkdir(targetDir, { recursive: true })`, then `extractArchive(Buffer.from(base64Tar, "base64"), targetDir)`. Extend `applyClaudeVault` to call `readAgeFiles(join(claudeDir, "skills"))` after the existing `agents/` block, decrypt each `.tar.age`, base64-decode, and call `applyClaudeSkill(basename(name, ".tar.age"), decrypted)` — except in `dryRun` mode, where it logs `[dry-run] [claude] would extract skill: <name>` and continues. Add JSDoc per Principle V. Verify T014 and T015 pass.

**Checkpoint**: At this point, User Story 1 is fully functional. Quickstart steps 2–4 (the Claude round trip) can be executed manually and pass. The MVP slice ships here. Run `bun run check`.

---

## Phase 4: User Story 2 - Codex skills sync alongside Codex configuration (Priority: P2)

**Goal**: A user-created skill under `~/.codex/skills/<name>/` round-trips through the vault the same way Claude skills do, with the additional concrete check that the host's `~/.codex/skills/.system/` vendor bundle is silently skipped (FR-017).

**Independent Test**: Place a valid skill under `~/.codex/skills/<name>/SKILL.md`, push, pull on a second machine, verify identical contents — quickstart.md step 10 (Codex variant).

### Tests for User Story 2 (REQUIRED) ⚠️

- [X] T017 [US2] Extend `src/agents/__tests__/codex.test.ts` with the six Codex skill tests mirroring T014: (1) happy-path snapshot, (2) `applyCodexSkill` direct test, (3) `applyCodexVault` round-trip, (4) dry-run no-op, (5) **FR-009 missing-dir case** — point `testCodexPaths.skillsDir` at a non-existent path, run `snapshotCodex()`, assert empty skill-artifact list with zero warnings and no throw, (6) **FR-016 interior-symlink defense-in-depth** — real skill dir with one symlinked helper file inside, snapshot, decrypt the tar, assert the symlinked entry is absent while real files are present. Use `testCodexPaths.skillsDir` (extend the mutable paths type if needed). Vault path expected: `codex/skills/my-skill.tar.age`.
- [X] T018 [P] [US2] Extend `src/agents/__tests__/codex.test.ts` with the FR-017 dot-skip assertion specific to Codex: build a tmp `~/.codex/skills/` containing one real skill `my-skill/SKILL.md` AND one `.system/` directory containing its own `SKILL.md`, run `snapshotCodex()`, and assert the result has exactly one artifact whose `vaultPath === "codex/skills/my-skill.tar.age"` — the `.system` directory is NOT archived. This is the regression test that catches a future change accidentally bypassing the dot-skip rule.

### Implementation for User Story 2

- [X] T019 [US2] Extend `src/agents/codex.ts::snapshotCodex` (currently at `codex.ts:43-88`) to call `collectSkillArtifacts("codex", AgentPaths.codex.skillsDir)` after the existing `rulesDir` block, then spread the walker output. Add `applyCodexSkill(skillName, base64Tar)` mirroring `applyCopilotSkill`. Extend `applyCodexVault` (currently at `codex.ts:147-186`) to read `.tar.age` files from `join(codexDir, "skills")` and apply each via `applyCodexSkill`, with the dry-run log line `[dry-run] [codex] would extract skill: <name>`. Add JSDoc. Verify T017 and T018 pass.

**Checkpoint**: User Story 2 is fully functional. Quickstart step 10 (Codex variant) passes manually. Run `bun run check`.

---

## Phase 5: User Story 3 - Cursor skills round-trip without hand-copying (Priority: P3)

**Goal**: Skills under `~/.cursor/skills/` (the FR-010 canonical path) round-trip through the vault, AND the bundled `~/.cursor/skills-cursor/` directory is provably never touched. The negative assertion is the load-bearing piece of this story because it's the only direct evidence that FR-010 is honored.

**Independent Test**: Create `~/.cursor/skills/<name>/SKILL.md`, push, pull on a second machine, verify the skill is restored at `~/.cursor/skills/<name>/`. Separately, create a `~/.cursor/skills-cursor/<name>/SKILL.md` and verify push does NOT produce any artifact under `cursor/skills-cursor/` in the vault — quickstart.md step 10 (Cursor variant).

### Tests for User Story 3 (REQUIRED) ⚠️

- [X] T020 [US3] Extend `src/agents/__tests__/cursor.test.ts` with the six Cursor skill tests mirroring T014: (1) happy-path snapshot, (2) `applyCursorSkill` direct test, (3) `applyCursorVault` round-trip, (4) dry-run no-op, (5) **FR-009 missing-dir case** — point `testCursorPaths.skillsDir` at a non-existent path, run `snapshotCursor()`, assert empty skill-artifact list with zero warnings and no throw, (6) **FR-016 interior-symlink defense-in-depth** — real skill dir with one symlinked helper file inside, snapshot, decrypt the tar, assert the symlinked entry is absent while real files are present. Use `testCursorPaths.skillsDir` (extend the mutable paths type if needed). Vault path expected: `cursor/skills/my-skill.tar.age`.
- [X] T021 [P] [US3] Extend `src/agents/__tests__/cursor.test.ts` with the FR-010 negative assertion: in the same tmp dir containing a real `~/.cursor/skills/my-skill/SKILL.md`, also create a `~/.cursor/skills-cursor/other-skill/SKILL.md`. Run `snapshotCursor()`, assert that the result contains exactly one skill artifact (`cursor/skills/my-skill.tar.age`) AND that `result.artifacts.every(a => !a.vaultPath.includes("skills-cursor"))` is true. This is User Story 3 acceptance scenario 3 from the spec.

### Implementation for User Story 3

- [X] T022 [US3] Extend `src/agents/cursor.ts::snapshotCursor` (currently at `cursor.ts:36-92`) to call `collectSkillArtifacts("cursor", AgentPaths.cursor.skillsDir)` after the existing `commandsDir` block, then spread the walker output. Add `applyCursorSkill(skillName, base64Tar)` mirroring `applyCopilotSkill`. Extend `applyCursorVault` (currently at `cursor.ts:140-182`) to read `.tar.age` files from `join(cursorDir, "skills")` and apply each via `applyCursorSkill`, with dry-run log line `[dry-run] [cursor] would extract skill: <name>`. Make sure the existing `applyCursorVault` "Unrecognised vault file" warn line at `cursor.ts:165` does NOT trigger on the new `skills/` sub-directory — the existing code only inspects top-level files and walks `commands/` separately, so adding a parallel `skills/` walk should not collide, but verify by re-running existing cursor tests. Add JSDoc. Verify T020 and T021 pass.

**Checkpoint**: All three numbered user stories are functional and independently testable. Run `bun run check`.

---

## Phase 6: Cross-cutting — Explicit Vault Removal (FR-012, FR-013)

**Purpose**: Implement the new `agentsync skill remove <agent> <name>` CLI verb introduced by Q2's clarification. This verb is intentionally NOT a numbered user story because it cuts across all four agents and depends on the foundational walker output already being in the vault — but it can ship independently of US1/US2/US3 (it can even operate on Copilot skills today). The pull-side no-delete guarantee (FR-013) is enforced *implicitly* by the existing `applyXxxVault` functions, so this phase's only test of FR-013 is an integration test that proves the implicit guarantee holds end-to-end.

- [X] T023 Create `src/commands/__tests__/skill.test.ts` with failing tests for every row in `contracts/skill-remove-cli.md`: (1) **success path** — set up a tmp vault with `<vaultDir>/claude/skills/my-skill.tar.age` present, run the command's underlying function (not the citty wrapper) with `("claude", "my-skill")`, assert the file is gone, the working tree has a commit, and `process.exitCode` is unset (or 0); (2) **not-found path** — run with `("claude", "does-not-exist")` and assert `process.exitCode === 1`, the vault file count is unchanged, and the error log contains the resolved path; (3) **unknown-agent path** — run with `("vscode", "anything")` and assert `process.exitCode === 1` and the error mentions the supported agent list; (4) **leave-local-alone assertion** — before invoking the success path, write a sentinel file at `<tmpHome>/.claude/skills/my-skill/SKILL.md` and after invocation assert the sentinel still exists. Use `__setPushAgentsForTesting`-style hooks if the new command exposes one; otherwise factor the command body into a testable async function.
- [X] T024 Create `src/commands/skill.ts` exporting `skillCommand`, a citty `defineCommand` that sets `subCommands: { remove: removeSubCommand }` where `removeSubCommand` accepts two positional args `<agent>` and `<name>`. The implementation MUST: validate `<agent>` is one of `claude | cursor | codex | copilot` (reject `vscode` and any other value with exit 1); resolve `<vaultDir>` via `resolveRuntimeContext()`; build the path `join(runtime.vaultDir, agent, "skills", \`${name}.tar.age\`)`; check existence with `stat`; on missing, print the not-found error format from `contracts/skill-remove-cli.md` and set `process.exitCode = 1`; on present, call `git.reconcileWithRemote(...)` (same options used by `performPush`), `unlink` the file, `git.commit({ message: \`skill remove(${agent}): ${name}\` })`, then `git.push("origin", config.remote.branch)`. NEVER touch any path under `AgentPaths.<agent>.skillsDir`. Add JSDoc per Principle V. Verify T023 passes.
- [X] T025 Register the new `skillCommand` group on the root CLI in `src/cli.ts` alongside `init`, `push`, `pull`, `status`, `doctor`, `daemon`, `key`. Confirm `agentsync skill --help` and `agentsync skill remove --help` both render after the change. This task is NOT parallelizable with T024 — it edits the same shared registration block in `cli.ts` that other tasks may also touch.
- [X] T026 [P] Extend `src/commands/__tests__/integration.test.ts` with TWO end-to-end tests. **First test (FR-013 pull-side no-delete)**: (a) build a tmp vault containing one Claude skill artifact, (b) call `applyClaudeVault(vaultDir, key, false)` against a tmp `$HOME` to populate the local skill, (c) delete the artifact from the vault directly (simulating the post-`skill remove` state on the remote without invoking the CLI), (d) call `applyClaudeVault(vaultDir, key, false)` AGAIN with the same tmp `$HOME`, and (e) assert the local skill directory at `<tmpHome>/.claude/skills/my-skill/` still exists with its original files. This proves FR-013's pull-side no-delete guarantee is upheld by the existing apply pipeline — if it fails, `applyXxxVault` or the walker is silently deleting locally, which violates the contract. **Second test (SC-009 negative-space vault content check)**: (a) build a tmp `$HOME` whose `~/.claude/skills/` contains one real skill `my-skill/SKILL.md` AND one top-level symlink `vendored -> /tmp/vendored-pool/sensitive-skill/` (where the target tree contains a marker file like `secret-marker.md` with content `THIS_MUST_NOT_LEAK`), (b) run `performPush({ dryRun: false })` against a tmp vault, (c) assert no `<vault>/claude/skills/vendored.tar.age` file was written, (d) for every `<vault>/claude/skills/*.tar.age` that DID get written, decrypt it, base64-decode it, gunzip the tar, walk the entries, and assert that NO entry has a path containing `vendored`, `sensitive-skill`, or `secret-marker`, AND that no entry's content contains the literal string `THIS_MUST_NOT_LEAK`. This proves SC-009's information-leak guarantee — vendored pool data never reaches the encrypted vault, even indirectly through tar-follow or path traversal. If the test fails, FR-016's outer-tier rule has a leak path that the walker test (T006) cannot catch because T006 only inspects walker output structure, not the post-encryption byte content.

**Checkpoint**: `agentsync skill remove` is wired up, exit codes match the contract, and the FR-013 invariant is proven by integration. Run `bun run check`.

---

## Phase 7: Polish & Documentation

**Purpose**: Ship the documentation updates the spec's Documentation Impact section requires (FR-014), the two Mermaid diagrams FR-015 mandates, the README safety note, and the manual cross-machine validation that automated tests cannot cover. This phase is not optional — Constitution Principle V's documentation gate blocks merge until docs land in the same commit as the code.

- [X] T027 [P] Update `docs/architecture.md` to add a new "Skills sync flow" section describing the shared `skills-walker.ts` module, the five gates in order (FR-002/FR-006/FR-016/FR-017), and how each agent adapter consumes the walker. Add the **first** Mermaid diagram from `research.md` R10 (sync flow: local skills directory → sentinel check → tar archive → age encryption → vault namespace → pull → atomic restore). Apply the GitHub-compatible Mermaid rules from the project's global guidelines: inline `:::className` styles, single `subgraph`, `<br/>` instead of `\n`, no parentheses in node labels, descriptive node IDs of ≥ 3 characters, and `classDef` colour pairs that meet WCAG 2 AA contrast (≥ 4.5:1).
- [X] T028 [P] Update `docs/architecture.md` (same file as T027 — but a new sub-section, so the two diagram tasks can be developed in parallel branches and merged sequentially without conflict if coordinated; otherwise perform T028 after T027) to add the **second** Mermaid diagram from `research.md` R10 (vault-removal flow: explicit user request → vault namespace entry removed → next pull on another machine leaves the local skill in place). Same Mermaid rule set. Place this section directly after the sync-flow section so a reader sees both flows in context.
- [X] T029 [P] Update `docs/command-reference.md` to extend the `push`, `pull`, `status`, and `doctor` entries with one-line additions naming the new vault namespaces (`claude/skills/`, `codex/skills/`, `cursor/skills/`) alongside the existing `copilot/skills/`, and add a new top-level `skill remove` section documenting the signature, exit codes, success/not-found/git-error output formats from `contracts/skill-remove-cli.md`. Include the explicit warning that `skill remove` never touches local skill directories on any machine.
- [X] T030 [P] Update `docs/troubleshooting.md` to add the six new entries enumerated in `spec.md`'s Documentation Impact section: (1) "my skills did not push" → FR-002 sentinel rule; (2) "my push aborted because of a never-sync file inside a skill" → FR-006; (3) "I deleted a skill locally and it came back after pull" → FR-011 + pointer to `skill remove`; (4) "I removed a skill from the vault but it is still on my other laptop" → FR-013; (5) "my vendored / symlinked skill did not sync" → FR-016 root-symlink rule; (6) "a helper file inside my skill is missing on the other machine after pull" → FR-016 interior-symlink omission.
- [X] T031 [P] Update `README.md` "What a vault means here" block (currently citing only `copilot/skills/<name>.tar.age`) to also name `claude/skills/`, `codex/skills/`, and `cursor/skills/`. Add a one-line safety note immediately after that block: "AgentSync never silently removes vault skills — removal is always an explicit user action via `agentsync skill remove`."
- [X] T032 Validate every Mermaid diagram introduced or modified by T027 and T028 against the project's GitHub Mermaid renderer rules. Concretely: paste each diagram into the GitHub markdown preview (or use the `mermaid-cli` lint pass if available locally) and verify it renders without parser errors and that every node label is legible. Constitution Principle V treats invalid Mermaid as a documentation defect — a failure here MUST be fixed before merge.
- [X] T033 Run `bun run check` (typecheck → biome → bun test --coverage) from the repo root and verify zero failures. Confirm coverage on `src/agents/skills-walker.ts`, `src/commands/skill.ts`, and the extended portions of `src/agents/{claude,cursor,codex,copilot}.ts` is ≥ 70 % per Constitution Principle II. Confirm `src/core/sanitizer.ts` and `src/core/encryptor.ts` coverage remains ≥ 90 % (both should be unchanged since neither file is modified).
- [ ] T034 Execute the manual cross-machine walkthrough in `quickstart.md` end-to-end on either two physical machines, two `$HOME`-isolated user accounts on the same host, or two Bun processes against two distinct tmp `$HOME` paths. Walk every numbered step and record pass/fail for each row in the "What this walkthrough proves" matrix at the bottom of `quickstart.md`. Attach the result list to the PR description so reviewers can see which spec requirements have been observed end-to-end.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: T001 has no dependencies — start immediately.
- **Phase 2 (Foundational)**: T002–T013, T035, T036 depend on T001. Within Phase 2, the dependencies are: `T002 → T003`, `T004 → T005`, `T006 → T007 (which also depends on T002 + T005)`, `T008 → T009 (which also depends on T007)`, `T010 → T011 (which also depends on T007)`, `T012 → T013 (which also depends on T002)`, `T011 → T035` (status test reuses the retrofitted Copilot skill path), `T011 → T036` (additive-default test reuses the retrofitted Copilot skill path). Phase 2 BLOCKS every later phase.
- **Phases 3, 4, 5 (US1/US2/US3)**: All three depend on Phase 2 complete. They can run in parallel by different developers (the agent files are disjoint), or sequentially in priority order (P1 → P2 → P3) if a single developer is implementing.
- **Phase 6 (Cross-cutting `skill remove`)**: Depends on Phase 2 complete. Does NOT depend on any of US1/US2/US3 — the verb operates on the vault directly and works on Copilot skills the moment Phase 2 is done. Can ship as a standalone increment if desired.
- **Phase 7 (Polish)**: Depends on every code change being merged. The four `[P]` doc tasks (T027, T028, T029, T030, T031) can run in parallel. T032 (Mermaid validation) depends on T027 and T028. T033 (`bun run check`) is the merge gate. T034 (manual walkthrough) depends on every other task being complete.

### User Story Dependencies

- **US1 (Claude, P1)**: Depends only on Foundational complete. No dependency on US2 or US3.
- **US2 (Codex, P2)**: Depends only on Foundational. No dependency on US1 or US3.
- **US3 (Cursor, P3)**: Depends only on Foundational. No dependency on US1 or US2.
- **Cross-cutting `skill remove` (Phase 6)**: Depends only on Foundational. Provides cross-cutting capability for all agents simultaneously.

### Within Each User Story

- Tests are written FIRST and MUST FAIL before implementation lands (TDD per Constitution Principle II).
- Each story is one test task plus one implementation task. The story is complete when the implementation passes the tests AND the existing test suite still passes.

### Parallel Opportunities

- Phase 2: T003, T004, T006, T008, T010, T012, T035, T036 are marked `[P]` because each touches a different file (T035 → `status.test.ts`, T036 → `push.test.ts` which T008 already targets so coordinate authoring with T008). Within each test/implementation pair (T002→T003, T004→T005, T006→T007, T008→T009, T010→T011, T012→T013) the implementation cannot start until the test compiles and fails. T035 and T036 both depend on T011 (Copilot retrofit) being complete because they reuse the Copilot skill path as their test fixture.
- Phase 3 (US1): T015 is marked `[P]` because it can be authored alongside T014 (both edit `claude.test.ts` — the parallelism here is *concurrent test authoring within one task batch* rather than two LLM agents on the same file simultaneously; if two agents are working on `claude.test.ts` they MUST coordinate at the file level).
- Phases 3 / 4 / 5 / 6 can all run in parallel by different developers once Foundational is done.
- Phase 7: T027–T031 are all `[P]` (different files). T028 touches the same file as T027 and is marked `[P]` only with the caveat that the two diagram sub-sections are merged sequentially.

---

## Parallel Example: Phase 2 — multiple foundational tasks at once

```bash
# After T002 completes, the following can be authored concurrently:
Task: "T003 Extend src/config/__tests__/paths.test.ts with skillsDir assertions"
Task: "T004 Add failing test for archiveDirectory({ skipSymlinks: true }) in src/core/__tests__/tar.test.ts"
Task: "T006 Create src/agents/__tests__/skills-walker.test.ts with the 12-row matrix"
Task: "T008 Add failing never-sync-inside-skill push abort test"
Task: "T010 Add failing copilot retrofit regression tests"
Task: "T012 Add failing doctor skills-dir readability test"

# After T005 + T007 complete, T009 / T011 / T013 can land in any order.
```

## Parallel Example: User stories after Foundational

```bash
# Three developers, three agent stories, no cross-talk:
Developer A: T014 → T015 → T016                  # US1 Claude
Developer B: T017 → T018 → T019                  # US2 Codex
Developer C: T020 → T021 → T022                  # US3 Cursor
Developer D: T023 → T024 → T025 → T026          # skill remove cross-cutting

# All four pipelines merge into Phase 7 polish in parallel.
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Complete Phase 1 (T001) — confirm green baseline.
2. Complete Phase 2 (T002–T013) — foundational walker, tar filter, push gate, doctor, Copilot retrofit. **CRITICAL**: this phase is non-skippable.
3. Complete Phase 3 (T014–T016) — Claude skill round-trip.
4. **STOP and VALIDATE**: Run quickstart steps 2–4 manually on a single machine. Confirm `~/.claude/skills/<name>` round-trips.
5. Open the PR with US1 only and ship the MVP. US2/US3/skill-remove/polish can land in follow-ups, OR all in the same PR if the team prefers a single delivery.

### Incremental Delivery

1. Foundational done → walker callable, push aborts on never-sync inside skill, Copilot already correct.
2. + US1 → Claude users see skills round-trip. (MVP — first shippable increment.)
3. + US2 → Codex users join.
4. + US3 → Cursor users join.
5. + Cross-cutting `skill remove` → users gain the explicit removal escape hatch.
6. + Polish → docs, Mermaid diagrams, manual walkthrough recorded.

Each increment is independently testable per its acceptance scenarios in the spec.

### Single-PR Strategy (if preferred)

Land everything (T001–T036) in a single PR, walking the dependency graph in a deterministic order: T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010 → T011 → T035 → T036 → T012 → T013 → T014 → T015 → T016 → T017 → T018 → T019 → T020 → T021 → T022 → T023 → T024 → T025 → T026 → T027 → T028 → T029 → T030 → T031 → T032 → T033 → T034. Note that T035 and T036 are inserted after T011 (which they depend on) and before T012/T013 (which are independent of them). Run `bun run check` after every Phase boundary, not only at T033, so a regression introduced in (say) T013 is caught before it propagates into US1.

---

## Notes

- **`[P]` tasks** = different files, no dependencies on incomplete tasks.
- **`[Story]` label** maps a task to its user story for traceability. Setup, Foundational, Cross-cutting, and Polish phases have NO story label by design.
- **Each user story** is independently completable and testable (US1 on its own ships the MVP).
- **Documentation tasks (T027–T031)** are NOT optional — Constitution Principle V's documentation gate blocks merge.
- **Mermaid validation (T032)** is NOT optional — Constitution Principle V treats invalid Mermaid as a documentation defect.
- **TDD ordering**: every implementation task in this list is preceded by a failing test task. Verify tests fail before implementing.
- **Commit cadence**: commit after each task or each logical pair. Avoid bundling more than one phase into a single commit.
- **Stop at any checkpoint** to validate a story or sub-feature independently before continuing.
- **Avoid**: vague descriptions (every task in this list names exact file paths), same-file parallelism without coordination (the tasks file flags this for `claude.test.ts`, `cursor.test.ts`, `codex.test.ts`, and `architecture.md`), and cross-story dependencies (none are introduced here — all four user stories and the cross-cutting verb are independent).
