# Tasks: Initial Function Testing

**Input**: Design documents from `/specs/001-initial-function-testing/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, quickstart.md ✅

---

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no shared dependencies)
- **[Story]**: Which user story this task belongs to (US1–US8)
- All test files are co-located with source modules (constitution §II)
- Test runner: `bun test` — never Vitest or Jest

---

## Phase 1: Setup

**Purpose**: Establish the shared test fixture helper used by every test file.

- [x] T001 Create shared test fixture helper `src/test-helpers/fixtures.ts` with `createTmpDir`, `createAgeIdentity`, `createBareRepo`, and `createIpcFixture` utilities

**Checkpoint**: `T001` complete — all per-test isolation utilities are available as imported helpers.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Extend the two existing test files so the security-critical coverage baseline (≥90%) is established before any new test files are written. These tests must pass before any other story proceeds.

- [x] T002 [P] Extend `src/config/schema.test.ts` — add invalid-schema cases: missing `remote`, wrong type for `recipients`, empty array, and extra fields (covers ≥90% of `src/config/schema.ts`)
- [x] T003 [P] Extend `src/core/sanitizer.test.ts` — add `NEVER_SYNC_PATTERNS` boundary cases, `redactionEnvNameForPath` variants, and deeply-nested object performance guard (covers ≥90% of `src/core/sanitizer.ts`)

**Checkpoint**: Security-critical schema and sanitizer modules at ≥90% coverage — user story implementation can begin.

---

## Phase 3: User Story 1 — Core Security Functions Are Verified (Priority: P1) 🎯 MVP

**Goal**: Prove encryption roundtrip correctness and secret-redaction accuracy. The entire system's trust model depends on these two modules.

**Independent Test**: `bun test src/core/encryptor.test.ts` — no git remote, no daemon, no agent config files needed.

- [x] T004 [US1] Create `src/core/encryptor.test.ts` — `generateIdentity` produces valid `AGE-SECRET-KEY-1…` string; `identityToRecipient` returns valid `age1…` string from that identity
- [x] T005 [P] [US1] Add to `src/core/encryptor.test.ts` — `encryptString` / `decryptString` roundtrip: plaintext → ciphertext is ASCII-armored and not readable as original; decrypt returns exact original
- [x] T006 [P] [US1] Add to `src/core/encryptor.test.ts` — `encryptFile` / `decryptFile` roundtrip: output file written, original not readable in output; decrypted file matches source byte-for-byte
- [x] T007 [P] [US1] Add to `src/core/encryptor.test.ts` — error paths: decrypt with wrong key rejects; decrypt malformed ciphertext rejects

**Checkpoint**: `bun test src/core/encryptor.test.ts` passes; coverage ≥90% on `src/core/encryptor.ts`.

---

## Phase 4: User Story 2 — Archive Functions Preserve Directory Integrity (Priority: P2)

**Goal**: Prove `archiveDirectory`/`extractArchive` round-trips correctly and rejects path traversal attacks.

**Independent Test**: `bun test src/core/tar.test.ts` — only filesystem tmpdir needed.

- [x] T008 [US2] Create `src/core/tar.test.ts` — `archiveDirectory` on a nested directory returns non-empty Buffer that is a valid gzipped tar
- [x] T009 [P] [US2] Add to `src/core/tar.test.ts` — `extractArchive` roundtrip: archived Buffer extracted to new tmpdir reproduces original file tree exactly (byte-for-byte content comparison)
- [x] T010 [P] [US2] Add to `src/core/tar.test.ts` — zip-slip rejection: craft tar entry with absolute path (`/etc/passwd`) and assert no file written outside target dir; craft entry with `../secret` traversal and assert same
- [x] T011 [P] [US2] Add to `src/core/tar.test.ts` — edge cases: empty archive Buffer; archive of single file; archive containing a symlink (assert symlink is handled safely)

**Checkpoint**: `bun test src/core/tar.test.ts` passes; zip-slip tests fail 0/N runs; coverage ≥70% on `src/core/tar.ts`.

---

## Phase 5: User Story 3 — Configuration Loads and Validates Correctly (Priority: P3)

**Goal**: Prove `loadConfig`, `writeConfig`, `resolveConfigPath`, `resolveAgentSyncHome`, and `resolveDaemonSocketPath` are correct and fail fast on bad input.

**Independent Test**: `bun test src/config/loader.test.ts src/config/paths.test.ts` — only tmpdir TOML files needed.

- [x] T012 [US3] Create `src/config/loader.test.ts` — `loadConfig` with valid TOML returns fully-typed config; `loadConfig` with missing required field throws with descriptive message
- [x] T013 [P] [US3] Add to `src/config/loader.test.ts` — `writeConfig` roundtrip: write → load → deep-equal original object; verify no trailing whitespace corruption in output TOML
- [x] T014 [P] [US3] Add to `src/config/loader.test.ts` — `resolveConfigPath` returns `<vaultDir>/agentsync.toml` for both absolute and relative vault paths
- [x] T015 [P] [US3] Create `src/config/paths.test.ts` — `resolveAgentSyncHome` returns `~/.config/agentsync` on macOS/Linux; returns `%APPDATA%/agentsync` when `process.platform === "win32"`
- [x] T016 [P] [US3] Add to `src/config/paths.test.ts` — `resolveDaemonSocketPath` ends in `daemon.sock` on macOS/Linux; ends in Windows named pipe pattern on `win32`; `AgentPaths` shape has all expected keys

**Checkpoint**: `bun test src/config/loader.test.ts src/config/paths.test.ts` passes; coverage ≥70% on both config modules.

---

## Phase 6: User Story 4 — Agent Snapshot Functions Capture the Right Files (Priority: P4)

**Goal**: Prove each agent's snapshot function returns exactly the right vault paths and sanitized content from a tmpdir fixture.

**Independent Test**: `bun test src/agents/_utils.test.ts src/agents/claude.test.ts` etc. — no encryption or git.

- [x] T017 [US4] Create `src/agents/_utils.test.ts` — `readIfExists` returns `null` for non-existent path (no throw); returns file content for existing path; `atomicWrite` writes content and leaves no `.tmp` sidecar; `collect` aggregates async iterable items into array
- [x] T018 [P] [US4] Create `src/agents/claude.test.ts` — `snapshotClaude` with `CLAUDE.md`, `settings.json` (with hooks), and `~/.claude.json` (with `mcpServers` + embedded API key): assert correct vault paths, redacted API key in MCP artifact, hooks present
- [x] T019 [P] [US4] Create `src/agents/codex.test.ts` — `snapshotCodex` with `AGENTS.md`, `config.toml`, and two `.md` rule files: assert all four artifacts present with correct vault paths
- [x] T020 [P] [US4] Create `src/agents/copilot.test.ts` — `snapshotCopilot` with a skills directory containing nested files: assert skill artifact is base64-encoded gzipped tar; decode and verify file structure matches original
- [x] T021 [P] [US4] Create `src/agents/cursor.test.ts` — `snapshotCursor` with cursor config and rule files: assert correct vault paths and content
- [x] T022 [P] [US4] Create `src/agents/vscode.test.ts` — `snapshotVsCode` with MCP config containing embedded API key: assert API key is replaced by redaction placeholder in artifact
- [x] T023 [P] [US4] Create `src/agents/registry.test.ts` — `Agents` registry contains exactly the expected agent name set; each entry has `snapshot` and `apply` function properties

**Checkpoint**: All agent snapshot test files pass; coverage ≥70% on all `src/agents/*.ts` modules.

---

## Phase 7: User Story 5 — Agent Apply Functions Write Files to the Correct Locations (Priority: P5)

**Goal**: Prove each agent's apply functions write decrypted content to the correct path; `dryRun` writes nothing.

**Independent Test**: `bun test src/agents/claude.test.ts` (apply section) etc. — uses tmpdir HOME + test age key.

> **Note**: Apply tests are added to the same test files as snapshot tests (same module), but use a different `describe` block and require the encryption fixture from `T001`.

- [x] T024 [US5] Add apply tests to `src/agents/claude.test.ts` — `applyClaudeVault`: encrypt `CLAUDE.md` with test identity, call apply, assert plaintext written to correct local path; `applyClaudeHooks`: existing `settings.json` has `theme` key preserved, `hooks` key updated
- [x] T025 [P] [US5] Add apply tests to `src/agents/codex.test.ts` — `applyCodexConfig`: existing local-only key retained; incoming overlapping key overwrites; write to correct path
- [x] T026 [P] [US5] Add apply tests to `src/agents/copilot.test.ts` — `applyCopilotVault`: encrypted skill archive is decrypted and extracted to `~/.copilot/skills/<skillName>/` with correct file structure
- [x] T027 [P] [US5] Add apply tests to `src/agents/cursor.test.ts` and `src/agents/vscode.test.ts` — each apply function writes decrypted content to expected path
- [x] T028 [P] [US5] Add `dryRun: true` tests to each agent apply function — assert zero files created or modified on disk after the call

**Checkpoint**: All apply tests pass with and without `dryRun`; coverage remains ≥70% for all agent modules.

---

## Phase 8: User Story 6 — IPC Server and Client Communicate Reliably (Priority: P6)

**Goal**: Prove `IpcServer`/`IpcClient` roundtrip, unknown-command handling, timeout, and stale-socket recovery.

**Independent Test**: `bun test src/core/ipc.test.ts` — socket in tmpdir, no encryption or git.

- [x] T029 [US6] Create `src/core/ipc.test.ts` — server registered handler returns `{ ok: true, data }` to matching client command; socket created inside `tmpDir` (isolation per research Decision 5)
- [x] T030 [P] [US6] Add to `src/core/ipc.test.ts` — unknown command returns `{ ok: false, error: <message> }`
- [x] T031 [P] [US6] Add to `src/core/ipc.test.ts` — no daemon at socket path: `IpcClient` rejects within 5 s
- [x] T032 [P] [US6] Add to `src/core/ipc.test.ts` — stale socket file exists when `IpcServer.listen` is called: stale file removed, server starts successfully

**Checkpoint**: `bun test src/core/ipc.test.ts` passes; coverage ≥70% on `src/core/ipc.ts`.

---

## Phase 9: User Story 7 — File Watcher Debounces and Triggers Callbacks Correctly (Priority: P7)

**Goal**: Prove `Watcher` fires callback exactly once for rapid changes, respects `remove`, and stops on `close`.

**Independent Test**: `bun test src/core/watcher.test.ts` — short debounce + `Bun.sleep` sync (research Decision 7).

- [x] T033 [US7] Create `src/core/watcher.test.ts` — watched file modified 5× within 50 ms with 100 ms debounce: callback fires exactly once after window elapses (use `await Bun.sleep(120)` as sync boundary). Note: 100 ms is a test-only override for speed; production daemon MUST pass ≥300 ms per constitution §III.
- [x] T034 [P] [US7] Add to `src/core/watcher.test.ts` — `Watcher.remove` on watched path: subsequent writes do not trigger callback
- [x] T035 [P] [US7] Add to `src/core/watcher.test.ts` — `Watcher.close` stops all watchers: writes after close invoke no callbacks

**Checkpoint**: `bun test src/core/watcher.test.ts` passes; debounce test consistent across 10 runs; coverage ≥70% on `src/core/watcher.ts`.

---

## Phase 10: User Story 8 — CLI Commands Produce Correct End-to-End Outcomes (Priority: P8)

**Goal**: Prove the full CLI command surface (`init`, `push`, `pull`, `status`, `doctor`, `key`) works against a local bare git repo with a tmpdir HOME.

**Independent Test**: `bun test src/commands/integration.test.ts` — local bare repo remote, no network, no real user config.

- [x] T036 [US8] Create `src/core/git.test.ts` — `GitClient` clone, pull, push, status against local bare repo (research Decision 6: `git init --bare <tmpDir>/remote.git`)
- [x] T037 [US8] Create `src/commands/shared.test.ts` — `resolveRuntimeContext` returns correct paths from tmpdir HOME; `loadPrivateKey` reads identity from expected path and rejects missing file
- [x] T038 [US8] Create `src/commands/integration.test.ts` — `init` command: bare repo URL + no existing vault → age keypair generated, `agentsync.toml` written, vault pushed
- [x] T039 [P] [US8] Add to `src/commands/integration.test.ts` — `push` command: enabled agent with local config → encrypted `.age` file in vault, git commit recorded
- [x] T052 [P] [US8] Add to `src/commands/integration.test.ts` — `push` abort-on-secret: agent config file containing a value matching a secret pattern (e.g., `sk-…`) causes `push` to exit with error, zero `.age` files written to vault, no git commit created (constitution §I)
- [x] T040 [P] [US8] Add to `src/commands/integration.test.ts` — `pull` command: vault contains `.age` file → decrypted content written to correct local path
- [x] T041 [P] [US8] Add to `src/commands/integration.test.ts` — `status` command: vault matches local → `synced`; local file modified after push → `local-changed`
- [x] T042 [P] [US8] Add to `src/commands/integration.test.ts` — `doctor` command: all prerequisite checks satisfied → all 7 checks pass
- [x] T043 [P] [US8] Add to `src/commands/integration.test.ts` — `key add`: new recipient added to config, all `.age` files re-encrypted for expanded list
- [x] T044 [P] [US8] Add to `src/commands/integration.test.ts` — `key rotate`: new identity generated, old key file overwritten, all `.age` files re-encrypted and pushed

**Checkpoint**: `bun test src/commands/integration.test.ts` passes end-to-end; full suite `bun run check` (typecheck + biome + test) exits 0.

---

## Phase 11: Daemon Installer Tests — Cross-Platform Mocking

**Goal**: Prove installer logic is correct without invoking real OS service commands (macOS `launchctl`, Linux `systemctl`, Windows `schtasks`).

**Independent Test**: `bun test src/daemon/installer-*.test.ts` — all OS calls mocked via `spyOn`.

- [x] T045 [P] Create `src/daemon/installer-macos.test.ts` — mock `child_process.execFile` via `spyOn`; test `install`, `uninstall`, `status`, `enable`, `disable` — assert correct command strings are invoked and plist file is written/removed
- [x] T046 [P] Create `src/daemon/installer-linux.test.ts` — same pattern for `systemctl` calls; assert `.service` unit file is written/removed
- [x] T047 [P] Create `src/daemon/installer-windows.test.ts` — same pattern for `schtasks`/`sc` calls; assert XML task file is written/removed

**Checkpoint**: `bun test src/daemon/` passes; no real OS service modification occurs; coverage ≥70% on all three installer modules.

---

## Phase 12: Polish & Cross-Cutting Concerns

**Goal**: Ensure full suite runs clean, coverage thresholds are met, and Biome reports zero issues.

- [x] T048 Run `bun test --coverage` and verify `src/core/encryptor.ts` ≥90%, `src/core/sanitizer.ts` ≥90%, `src/config/schema.ts` ≥90%, all others ≥70%
- [x] T049 [P] Create `src/lib/debug.test.ts` — `isDebug` returns `false` when `DEBUG` env var unset; returns `true` when `DEBUG=agentsync`; `debug` writes to stderr only when `isDebug()` is true
- [x] T050 [P] Run `bunx biome ci .` across all new `*.test.ts` files — fix any formatting or lint violations before merge
- [x] T051 [P] Run full CI gate `bun run check` (typecheck + lint + test) — all passes, no `any` type errors

**Checkpoint**: `bun run check` exits 0; coverage report confirms thresholds; no Biome violations.

---

## Dependencies

```
T001 (fixture helper) ← T024, T025, T026, T027, T028 (apply tests need age encryption)
T002, T003 (foundational) ← T038–T044, T052 (integration tests need schema/sanitizer correct first)
T004–T007 (encryptor) ← T024–T028 (apply tests encrypt/decrypt vault files)
T008–T011 (tar) ← T020, T026 (Copilot snapshot/apply uses tarballs)
T036 (git.test) ← T038 (init integration test uses GitClient)
T037 (shared.test) ← T038–T044 (integration tests use resolveRuntimeContext)
T038 (init) ← T039–T044 (push/pull/status/key require an initialised vault)
```

User story completion order (due to dependencies):
`US1 → US2 → US3 → US4 → US5 → US6/US7 (parallel) → US8`

US6 and US7 can be implemented in parallel with each other after US5.

---

## Parallel Execution Examples

### Within User Story 4 (snapshot tests — all different files):

```bash
# These can be written in parallel by different developers:
bun test src/agents/claude.test.ts       # T018
bun test src/agents/codex.test.ts        # T019
bun test src/agents/copilot.test.ts      # T020
bun test src/agents/cursor.test.ts       # T021
bun test src/agents/vscode.test.ts       # T022
```

### Within User Story 8 (integration sub-commands — all same file, but independent describe blocks):

```bash
# After T038 (init baseline), T039–T044 can be added concurrently:
bun test --test-name-pattern "push"
bun test --test-name-pattern "pull"
bun test --test-name-pattern "status"
```

### Daemon installers (all different files, no shared state):

```bash
bun test src/daemon/installer-macos.test.ts    # T045
bun test src/daemon/installer-linux.test.ts    # T046
bun test src/daemon/installer-windows.test.ts  # T047
```

---

## Implementation Strategy

**MVP scope** (User Stories 1–3): Complete T001–T016 first. After T016, the security baseline and config layer are verified — this is the minimum viable test coverage for a security-sensitive tool.

**Incremental delivery**:

1. T001–T003: Foundation (shared helper + extend existing files)
2. T004–T007: US1 — encryption (highest risk, highest priority)
3. T008–T016: US2+US3 — archive + config (unblocks snapshot/apply)
4. T017–T028: US4+US5 — all agent snapshot + apply
5. T029–T035: US6+US7 — IPC + watcher (can be parallel)
6. T036–T044: US8 — CLI integration (requires all above)
7. T045–T051: Daemon installers + polish

---

## Summary

| Phase               | Stories     | Tasks     | Parallelizable         |
| ------------------- | ----------- | --------- | ---------------------- |
| Setup               | —           | T001      | —                      |
| Foundational        | —           | T002–T003 | T002, T003             |
| US1 Security        | P1          | T004–T007 | T005, T006, T007       |
| US2 Archive         | P2          | T008–T011 | T009, T010, T011       |
| US3 Config          | P3          | T012–T016 | T013, T014, T015, T016 |
| US4 Snapshots       | P4          | T017–T023 | T018–T023              |
| US5 Apply           | P5          | T024–T028 | T025–T028              |
| US6 IPC             | P6          | T029–T032 | T030, T031, T032       |
| US7 Watcher         | P7          | T033–T035 | T034, T035             |
| US8 CLI Integration | P8          | T036–T044 | T039–T044              |
| Daemon Installers   | P8-adjacent | T045–T047 | T045, T046, T047       |
| Polish              | —           | T048–T051 | T049, T050, T051       |

**Total tasks**: 51  
**Parallelizable tasks**: 35  
**Sequential gates**: T001, T004, T008, T012, T017, T024, T029, T033, T036, T037, T038, T048
