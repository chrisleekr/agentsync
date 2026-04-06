# Tasks: Stabilise Daemon Process

**Input**: Design documents from `/specs/20260406-094347-stabilise-daemon/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ipc-status.md, quickstart.md

**Tests**: Automated tests are required for all modified and new modules per Constitution Principle II. Tests are written before implementation (TDD) and must fail before the implementation task is started.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US4, maps to spec.md priorities P1–P4)
- Exact file paths are included in every description

---

## Phase 1: Setup (New Files)

**Purpose**: Create new source files and test files so that all later tasks have a concrete target to fill in. Start with empty/stub implementations so TypeScript compiles from the beginning.

- [ ] T001 Create stub `src/core/sync-queue.ts` exporting an empty `SyncQueue` class with `enqueue` and `whenIdle` method signatures
- [ ] T002 Create stub `src/core/__tests__/sync-queue.test.ts` with a `describe("SyncQueue")` block and a single failing placeholder test

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Interface and schema changes that EVERY user story depends on. No user story work can begin until this phase is complete.

**⚠️ CRITICAL**: The `getExecutableArgs(): string[]` rename and installer `install(args: string[])` signature change are breaking — all call sites and tests must compile before Phase 3 can start.

- [ ] T003 Add `DaemonStatusSchema` and `DaemonStatus` type to `src/config/schema.ts` using Zod: fields `pid` (positive int), `consecutiveFailures` (non-negative int), `lastError` (string or null)
- [ ] T004 Rename `getExecutablePath(): string` to `getExecutableArgs(): string[]` in `src/commands/daemon.ts`; implement ephemeral-path detection using `os.tmpdir()` comparison and `bunx-` guard; throw with "Install the package globally first: `bun install -g @chrisleekr/agentsync`" if the script path is in a temp directory
- [ ] T004a ⚠️ Write tests in `src/commands/__tests__/daemon.test.ts` for `getExecutableArgs()`: (1) when `process.argv[0]` does not end with `bun`/`bun.exe`, returns single-element array containing `process.execPath`; (2) when running as bun with a non-ephemeral script path, returns `[process.argv[0], process.argv[1]]`; (3) when the script path is inside `os.tmpdir()` or contains `bunx-`, throws an `Error` whose message includes "Install the package globally first" — verifies Constitution Principle II coverage for the new ephemeral-path branch (C3)
- [ ] T005 Update `PlatformInstaller` interface in `src/commands/daemon.ts`: change `install(exe: string)` to `install(args: string[])`; update the `install` subcommand to call `getExecutableArgs()` and pass the result to `installer.install(args)`
- [ ] T005a Extend `PlatformInstaller` interface in `src/commands/daemon.ts` to add `isRegistered(): Promise<boolean>`; add stub implementations that return `Promise.resolve(false)` in `installer-macos.ts`, `installer-linux.ts`, and `installer-windows.ts` so TypeScript compiles; the real implementations will replace the stubs in T035 (macOS), T039 (Linux), and the existing `isInstalledWindows` alias in T041 — resolves I1 (T042 references this method but no prior task defined it)
- [ ] T006 Update `buildPlist` signature to `buildPlist(args: string[], logDir: string)` in `src/daemon/installer-macos.ts`; emit one `<string>` XML element per entry in `[...args, "daemon", "_run"]` (fixes Bug 1 — confirmed root cause of `EX_CONFIG 78`)
- [ ] T007 Update `installMacOs(args: string[])` signature in `src/daemon/installer-macos.ts`; add bootout step before writing plist: call `launchctl bootout gui/<uid> <PLIST_PATH>` and swallow errors (fixes Bug 3 — idempotent re-install)
- [ ] T008 [P] Update `buildUnit` signature to `buildUnit(args: string[])` and `installLinux(args: string[])` in `src/daemon/installer-linux.ts`; construct `ExecStart` as `[...args, "daemon", "_run"].join(" ")` (systemd tokenises correctly; this is for interface consistency)
- [ ] T009 [P] Update `buildXml` signature to `buildXml(args: string[])` and `installWindows(args: string[])` in `src/daemon/installer-windows.ts`; put `args[0]` in `<Command>` and join `[...args.slice(1), "daemon", "_run"]` into `<Arguments>` (fixes Bug 1 for Windows)
- [ ] T010 Implement the full `SyncQueue` class body in `src/core/sync-queue.ts`: `tail: Promise<void>` chain, `enqueue<T>(fn: () => Promise<T>): Promise<T>`, and `whenIdle(): Promise<void>` returning the current tail
- [ ] T010a ⚠️ Write test in `src/daemon/__tests__/index.test.ts`: when `startDaemon()` is called and a running daemon is already listening on the socket path, the startup code attempts an IPC health-ping and receives a valid response; it then logs a message containing "already running" and calls `process.exit(1)` without disrupting the running daemon — covers FR-009 and SC-005 (C2)
- [ ] T010b Implement second-instance detection in `src/daemon/index.ts`: at the top of the startup sequence, before calling `ipc.listen()`, attempt a `status` command via `IpcClient` on the existing socket path; if a valid response is received, log `"Daemon is already running (pid: X)"` and call `process.exit(1)`; if `ECONNREFUSED` is caught (stale socket — file exists but no server), call `unlink(socketPath)` to remove it before proceeding to `ipc.listen()` (satisfies FR-003); if `ENOENT` is caught (no socket file), continue directly — this is the clean-start path

**Checkpoint**: `bun run typecheck` must pass with zero errors before proceeding to Phase 3.

---

## Phase 3: User Story 1 — Clean Shutdown Without Data Loss (Priority: P1) 🎯 MVP

**Goal**: SIGTERM/SIGINT causes the daemon to drain in-flight sync operations, close the IPC server, remove the socket file, then exit — leaving no partial commits and no stale socket for the next start.

**Independent Test**: Install daemon, trigger a push, immediately send SIGTERM; verify push completes, socket file absent, next `daemon start` succeeds without "address in use" error.

### Tests for User Story 1 ⚠️ Write first — verify they FAIL before implementation

- [ ] T011 [US1] Write test in `src/daemon/__tests__/index.test.ts`: given SIGTERM received while queue is busy, `ipc.close()` is called before `process.exit(0)`
- [ ] T012 [US1] Write test in `src/daemon/__tests__/index.test.ts`: given SIGTERM received, the IPC socket path is unlinked (spy on `unlink`) before `process.exit(0)`
- [ ] T013 [US1] Write test in `src/core/__tests__/sync-queue.test.ts`: two enqueued operations run serially (second starts only after first resolves)
- [ ] T014 [US1] Write test in `src/core/__tests__/sync-queue.test.ts`: `whenIdle()` resolves only after all enqueued work settles

### Implementation for User Story 1

- [ ] T015 [US1] Integrate `SyncQueue` into `src/daemon/index.ts`: import `SyncQueue`, create a module-level `queue` instance, wrap every `performPush()` and `runPull()` call so they are enqueued rather than called directly
- [ ] T016 [US1] Update the `shutdown` function in `src/daemon/index.ts`: (1) call `ipc.close()`; (2) await `Promise.race([queue.whenIdle(), delay(10_000)])`; (3) await `watcher.close()`; (4) call `unlink(socketPath)` and swallow ENOENT; (5) then call `process.exit(0)`
- [ ] T017 [US1] Update the existing shutdown test in `src/daemon/__tests__/index.test.ts` to confirm `watcherClosed`, `clearedIntervalToken`, IPC close, and socket unlink all occur before `exitCode === 0`

**Checkpoint**: `bun test src/daemon/__tests__/index.test.ts` and `bun test src/core/__tests__/sync-queue.test.ts` pass. `bun run typecheck` clean.

---

## Phase 4: User Story 2 — Sync Errors Are Visible and Actionable (Priority: P2)

**Goal**: Every sync failure is logged with timestamp and operation type. `daemon status` returns `consecutiveFailures` (resets on success) and `lastError` so operators can self-diagnose without reading raw logs.

**Independent Test**: Break remote URL, wait one pull interval, run `agentsync daemon status`; expect `consecutiveFailures >= 1` and `lastError` is a non-empty string. Restore URL, trigger sync, verify status resets to `consecutiveFailures: 0, lastError: null`.

### Tests for User Story 2 ⚠️ Write first — verify they FAIL before implementation

- [ ] T018 [US2] Write test in `src/daemon/__tests__/index.test.ts`: after a failed pull, `consecutiveFailures` increments to 1 and `lastError` is non-null
- [ ] T019 [US2] Write test in `src/daemon/__tests__/index.test.ts`: after a successful pull following a failure, `consecutiveFailures` resets to 0 and `lastError` is null
- [ ] T020 [US2] Write test in `src/daemon/__tests__/index.test.ts`: `status` IPC handler returns an object matching `DaemonStatusSchema` with current `consecutiveFailures` and `lastError`

### Implementation for User Story 2

- [ ] T021 [US2] Add module-level failure state to `src/daemon/index.ts`: `let consecutiveFailures = 0; let lastError: string | null = null;` and helper functions `recordSuccess()` (resets both) and `recordFailure(op: "push" | "pull", msg: string)` (increments count, sets `lastError` to `"[push] msg"` or `"[pull] msg"` so that the operation type is always present in the stored error per FR-004 — U1 fix)
- [ ] T022 [US2] Update the queued push/pull wrappers in `src/daemon/index.ts` to call `recordSuccess()` when the operation completes without a fatal error; call `recordFailure("push", msg)` in the push wrapper and `recordFailure("pull", msg)` in the pull wrapper when either fails or returns `fatal: true`; the literal string `"push"` or `"pull"` is chosen at the call site, never inferred inside `recordFailure`
- [ ] T023 [US2] Update the `status` IPC handler in `src/daemon/index.ts` to return `DaemonStatusSchema.parse({ pid: process.pid, consecutiveFailures, lastError })`
- [ ] T024 [P] [US2] Update `daemon status` display in `src/commands/daemon.ts`: on success, print pid plus failure count and last error if `consecutiveFailures > 0`

**Checkpoint**: Status IPC now carries failure data. `bun test src/daemon/__tests__/index.test.ts` passes.

---

## Phase 5: User Story 3 — Automatic Recovery After Transient Failure (Priority: P3)

**Goal**: Every failed sync is retried exactly once immediately. If the retry also fails, the error is logged and the daemon waits for the next natural trigger. Recovery is automatic — no manual restart needed.

**Independent Test**: Block remote for two intervals; restore it; verify the next triggered sync succeeds without restart.

### Tests for User Story 3 ⚠️ Write first — verify they FAIL before implementation

- [ ] T025 [US3] Write test in `src/daemon/__tests__/index.test.ts`: when a push fails on first attempt but succeeds on second, the operation is called exactly twice and `consecutiveFailures` stays at 0
- [ ] T026 [US3] Write test in `src/daemon/__tests__/index.test.ts`: when both the initial attempt and retry fail, `consecutiveFailures` increments to 1 (not 2); also assert that `process.exit` is NOT called — the daemon must remain alive for the next scheduled trigger (verifies SC-004: daemon survives consecutive failures without exiting)

### Implementation for User Story 3

- [ ] T027 [US3] Add `withRetry<T>(fn: () => Promise<T>): Promise<T>` helper to `src/daemon/index.ts`: calls `fn()` once; on failure calls `fn()` again and lets the second result propagate
- [ ] T028 [US3] Wrap every `performPush()` and `runPull()` call inside the queue enqueue callback with `withRetry(...)` in `src/daemon/index.ts`

**Checkpoint**: Retry behaviour verified. `bun test src/daemon/__tests__/index.test.ts` all green.

---

## Phase 6: User Story 4 — Clear Install and Start Failure Reporting (Priority: P4)

**Goal**: `daemon install` via bunx is blocked with a clear error. A working install always uses separate `<string>` elements in the plist (not one space-joined string). `daemon install` is idempotent. `daemon start` never hangs — it checks registration state first and times out in 10 seconds. Daemon startup validates that the vault and encryption key are accessible before proceeding; missing resources cause an immediate exit with an actionable message (FR-006, FR-007, SC-006).

**Independent Test**: Run `agentsync daemon install` via bunx → expect blocking error. Run `agentsync daemon install` globally twice → expect success both times. Run `agentsync daemon start` with no daemon registered → expect error within 2 seconds.

### Tests for User Story 4 ⚠️ Write first — verify they FAIL before implementation

- [ ] T029 [P] [US4] Write test in `src/daemon/__tests__/installer-macos.test.ts`: `buildPlist(["bun", "/path/cli.js"], logDir)` produces a plist where `<ProgramArguments>` contains separate `<string>bun</string>` and `<string>/path/cli.js</string>` entries (not one combined string)
- [ ] T030 [P] [US4] Write test in `src/daemon/__tests__/installer-macos.test.ts`: `installMacOs(args)` calls `launchctl bootout` before `launchctl bootstrap` (verify call order via mock)
- [ ] T031 [P] [US4] Write test in `src/daemon/__tests__/installer-macos.test.ts`: when `launchctl bootstrap` rejects, `installMacOs` throws an `Error` whose message contains the service manager stderr but not an internal stack trace
- [ ] T032 [P] [US4] Write test in `src/daemon/__tests__/installer-macos.test.ts`: `startMacOs()` throws immediately with "Service not bootstrapped" message when `isRegisteredMacOs()` returns false (no kickstart call made)
- [ ] T033 [P] [US4] Write test in `src/daemon/__tests__/installer-windows.test.ts`: `buildXml(["bun", "/path/cli.js"])` produces XML where `<Command>` holds only `bun` (escaped) and `<Arguments>` holds `/path/cli.js daemon _run`
- [ ] T034 [P] [US4] Write test in `src/daemon/__tests__/installer-linux.test.ts`: `buildUnit(["bun", "/path/cli.js"])` produces a unit file where `ExecStart=bun /path/cli.js daemon _run`
- [ ] T034a [P] [US4] Write test in `src/daemon/__tests__/index.test.ts`: when `startDaemon()` is called with a mock that throws "vault directory not found" during config/vault load, the process calls `process.exit(1)` and the log output contains "vault" — covers FR-006 and SC-006 (C1)
- [ ] T034b [P] [US4] Write test in `src/daemon/__tests__/index.test.ts`: when `startDaemon()` is called with a mock that throws "key file not found" or "permission denied" during encryption key load, the process calls `process.exit(1)` and the log output identifies the key issue — covers FR-007 and SC-006 (C1)

### Implementation for User Story 4

- [ ] T035 [US4] Add `isRegisteredMacOs(): Promise<boolean>` to `src/daemon/installer-macos.ts`: runs `launchctl print gui/<uid>/com.agentsync.daemon`; returns `true` on exit 0, `false` otherwise
- [ ] T036 [US4] Add `extractServiceManagerError(err: unknown): string` helper to `src/daemon/installer-macos.ts`: reads `stderr` property from the error object and returns it; falls back to `String(err)` if absent
- [ ] T037 [US4] Update `installMacOs` in `src/daemon/installer-macos.ts` to wrap `launchctl bootstrap` in try/catch and re-throw with `extractServiceManagerError` output + a platform hint (no stack trace)
- [ ] T038 [US4] Update `startMacOs()` in `src/daemon/installer-macos.ts`: call `isRegisteredMacOs()` first; throw "Service not bootstrapped — run `agentsync daemon install` first." if false; wrap `kickstart` in `Promise.race` with a 10-second timeout that throws "Service manager start timed out."
- [ ] T039 [US4] Add `isRegisteredLinux(): Promise<boolean>` to `src/daemon/installer-linux.ts`: runs `systemctl --user is-enabled agentsync`; returns `true` only when stdout is `enabled`
- [ ] T040 [US4] Update `startLinux()` in `src/daemon/installer-linux.ts`: call `isRegisteredLinux()` first with same guard pattern as macOS; wrap `systemctl --user start` in 10-second timeout
- [ ] T041 [US4] Update `startWindows()` in `src/daemon/installer-windows.ts`: use `isInstalledWindows()` as the registration check; wrap `schtasks /Run` in 10-second timeout
- [ ] T041a [US4] Add startup validation to `startDaemon()` in `src/daemon/index.ts`: at the top of the function, wrap the vault directory existence check and encryption key load in a try-catch; on failure, log `"Startup failed: <specific resource> — <actionable hint>"` and call `process.exit(1)`; the exit must occur within 3 seconds to satisfy SC-006 — this fills the FR-006 and FR-007 coverage gap (C1)
- [ ] T042 [US4] Update `daemon start` subcommand in `src/commands/daemon.ts`: replace `installer.isInstalled()` check with the new `isRegistered()` method defined in the `PlatformInstaller` interface (added by T005a); the error message must include "run `agentsync daemon install` first"
- [ ] T043 [P] [US4] Update existing tests in `src/daemon/__tests__/installer-macos.test.ts` for the new `string[]` parameter signature (all `installMacOs`, `buildPlist` call sites)
- [ ] T044 [P] [US4] Update existing tests in `src/daemon/__tests__/installer-linux.test.ts` for the new `string[]` parameter signature
- [ ] T045 [P] [US4] Update existing tests in `src/daemon/__tests__/installer-windows.test.ts` for the new `string[]` parameter signature

**Checkpoint**: All four user stories independently functional. `bun test` passes across all modified test files.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, diagram validation, full CI gate, and live integration validation.

- [ ] T046 [P] Create `docs/daemon.md` with a GitHub-compatible Mermaid stateDiagram-v2 covering all lifecycle states: Starting → Running → Syncing → Running (success) / Error (retry) → Running, and Running → ShuttingDown → Stopped; use high-contrast hex colour pairs per CLAUDE.md diagram rules
- [ ] T047 [P] Add JSDoc comments to all new and modified exported symbols per Constitution Principle V: `SyncQueue`, `getExecutableArgs`, `isRegisteredMacOs`, `isRegisteredLinux`, `DaemonStatusSchema`, `withRetry`, `recordSuccess`, `recordFailure` (new); `installMacOs`, `buildPlist`, `installLinux`, `buildUnit`, `installWindows`, `buildXml` (signature-changed — existing JSDoc must be updated to reflect the new `args: string[]` parameter)
- [ ] T048 Validate the Mermaid diagram in `docs/daemon.md` renders correctly in GitHub Markdown preview (open PR draft or use local renderer — required blocker per quickstart.md Scenario 8)
- [ ] T049 Run `bun run check` (typecheck + biome lint + full test suite) and confirm zero errors
- [ ] T050 Execute quickstart.md Scenario 1 on macOS host: fresh global install → `daemon install` → `daemon status` shows running with `consecutiveFailures: 0`
- [ ] T051 Execute quickstart.md Scenario 2: run `daemon install` a second time → expect success, no "Bootstrap failed: 5" error
- [ ] T052 Execute quickstart.md Scenario 3: run via bunx → expect ephemeral path error, no plist written
- [ ] T053 Execute quickstart.md Scenario 4: run `daemon start` without registration → expect error within 2 seconds
- [ ] T054 Execute quickstart.md Scenario 5: stop daemon → verify socket file absent → restart succeeds
- [ ] T055 Execute quickstart.md Scenario 6: break remote URL → verify `daemon status` shows `consecutiveFailures >= 1` → restore and confirm reset

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (stub files exist). **BLOCKS all user stories.**
- **US1–US4 (Phases 3–6)**: All depend on Foundational completion. Can then proceed in priority order (P1→P2→P3→P4) or in parallel if staffed.
- **Polish (Phase 7)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **US1 (P1)**: Depends only on Foundational. No dependency on US2/US3/US4.
- **US2 (P2)**: Depends only on Foundational. Adds failure tracking on top of US1's queue — best implemented after US1 but independently testable.
- **US3 (P3)**: Depends only on Foundational. The `withRetry()` wrapper composes with both the queue (US1) and failure tracking (US2) — implement after both for coherent unit tests.
- **US4 (P4)**: Depends only on Foundational (installer signature changes already in Phase 2). Fully independent of US1/US2/US3.

### Within Each User Story

1. Write tests first (they must fail)
2. Implement to make tests pass
3. Run `bun run typecheck` after each implementation task
4. Verify story's independent test criteria before moving to next story

### Parallel Opportunities

- T008 and T009 (Linux/Windows installer signatures) can run in parallel — different files
- T011, T012 (shutdown tests) can be written in parallel — same file, same describe block, no conflict
- T013, T014 (SyncQueue tests) are in a different file — can run in parallel with T011/T012
- T029–T034b (US4 tests across all installers and startup) are all in different test files — fully parallel
- T043, T044, T045 (existing test updates) — fully parallel across installer files
- T046 (docs), T047 (JSDoc) — parallel in Polish phase

---

## Parallel Example: Phase 2

```bash
# These can be implemented simultaneously (different files):
T003  →  src/config/schema.ts          (add DaemonStatusSchema)
T008  →  src/daemon/installer-linux.ts  (update buildUnit signature)
T009  →  src/daemon/installer-windows.ts (update buildXml signature)
T010  →  src/core/sync-queue.ts         (fill SyncQueue body)

# Then T004, T005, T006, T007 sequentially (all touch daemon.ts or installer-macos.ts)
```

---

## Implementation Strategy

### MVP: User Story 1 Only (Clean Shutdown)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T010)
3. Complete Phase 3: US1 (T011–T017)
4. **STOP and VALIDATE**: `bun test`, `bun run typecheck`, quickstart.md Scenario 5 (socket cleanup)
5. The daemon now shuts down cleanly — the highest-priority real-world failure is addressed

### Incremental Delivery

1. Phase 1 + 2 → Foundation ready
2. Phase 3 (US1) → Clean shutdown ✓ — validate independently
3. Phase 4 (US2) → Visible errors ✓ — validate independently
4. Phase 5 (US3) → Auto-recovery ✓ — validate independently
5. Phase 6 (US4) → Install reliability ✓ — validate independently (includes the confirmed Bug 1/2/3 fixes)
6. Phase 7 → Polish, full CI gate, live macOS scenarios

---

## Notes

- `[P]` tasks have no dependencies on incomplete sibling tasks and touch different files
- `[Story]` label maps each task to the user story it serves for traceability to spec.md
- US4 (installer bugs) fixes are partially in Phase 2 (signature change, plist format) and partially in Phase 6 (registration check, error surfacing) — this split ensures TypeScript compiles throughout
- Constitution Principle II requires tests to fail before implementation; `bun run typecheck` must be clean after every Foundational task
- Commit after each phase checkpoint; use `fix:` prefix for bug-fix commits and `feat:` for new capability commits per Conventional Commits
- **Remediation additions** (from `/speckit-analyze` findings): T004a (C3 — `getExecutableArgs` tests), T005a (I1 — `PlatformInstaller.isRegistered()` interface), T010a/T010b (C2 — second-instance detection), T034a/T034b/T041a (C1 — startup validation for FR-006/FR-007); T021/T022 updated for U1 (operation type in failure log); spec.md FR-014/FR-015 reordered to fix I2
