# Research: Initial Function Testing

**Feature**: `001-initial-function-testing`
**Date**: 2026-04-04
**Status**: Complete — all NEEDS CLARIFICATION resolved

---

## Decision 1: Test Runner

**Decision**: `bun test` (built-in to Bun, uses `bun:test` module)

**Rationale**: Confirmed by two routes:
1. Existing test files (`src/config/schema.test.ts`, `src/core/sanitizer.test.ts`) both import from `"bun:test"`.
2. `package.json` scripts: `"test": "bun test"`, `"test:coverage": "bun test --coverage"`.
3. Constitution §II states: "The project uses `bun test` as its sole test runner."

**Alternatives considered**: Vitest (referenced in the spec's Assumptions section) — **rejected**. The spec assumption was incorrect; the constitution and codebase both mandate `bun test`.

**Correction applied**: Plan uses `bun test` exclusively. The spec's Assumptions section had a Vitest reference that this plan overrides per constitution §Governance ("constitution takes precedence").

---

## Decision 2: Coverage Thresholds

**Decision**: ≥90% line coverage for security-critical modules (`encryptor.ts`, `sanitizer.ts`, `config/schema.ts`); ≥70% for all other modules.

**Rationale**: Constitution §II explicit mandate. The spec stated a blanket 80% target (SC-002), which was an approximation. The plan uses the constitution's split thresholds as they are stricter for security modules and more lenient for infrastructure glue code.

**Alternatives considered**: Blanket 80% — superseded by constitution.

---

## Decision 3: Temporary Fixture Creation Pattern

**Decision**: Use `import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"` with `os.tmpdir()` as the base. Each test creates a unique tmpdir in `beforeEach` and removes it recursively in `afterEach`.

**Rationale**: `bun:test` runs tests in the same process; shared state in the real home directory would cause cross-test contamination. `mkdtemp` produces a unique-per-test directory with no collision risk. Bun's Node.js compatibility layer fully supports `node:fs/promises` and `node:os`.

**Pattern**:
```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "agentsync-test-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```

---

## Decision 4: Age Identity Creation in Tests

**Decision**: Call `generateIdentity()` + `identityToRecipient()` directly in the test setup. Use fresh throwaway keys per test; never embed hard-coded key material.

**Rationale**: Constitution §I forbids hard-coded private key material. `generateIdentity` is fast (<5 ms) and pure-crypto — acceptable to call in each test.

**Pattern**:
```typescript
import { generateIdentity, identityToRecipient } from "../../core/encryptor";

let identity: string;
let recipient: string;
beforeEach(async () => {
  identity = await generateIdentity();
  recipient = await identityToRecipient(identity);
});
```

---

## Decision 5: IPC Testing Pattern

**Decision**: Bind `IpcServer` to a socket inside the per-test tmpdir (e.g., `<tmpDir>/daemon.sock`). Start the server, run the test, then call `server.close()` in `afterEach`. Use `IpcClient` pointing to the same socket path.

**Rationale**: Using a tmpdir path avoids conflicts with any real daemon socket at `~/.config/agentsync/daemon.sock`. The `IpcServer` removes stale sockets on `listen()`, so placing it in the tmpdir also validates that path cleanup path.

**Pattern**:
```typescript
import { join } from "node:path";
import { IpcServer, IpcClient } from "../../core/ipc";

let server: IpcServer;
let socketPath: string;
beforeEach(async () => {
  socketPath = join(tmpDir, "daemon.sock");
  server = new IpcServer();
  await server.listen(socketPath);
});
afterEach(async () => { await server.close(); });
```

---

## Decision 6: Local Bare Git Repository for Integration Tests

**Decision**: Create a bare git repository with `git init --bare <tmpDir>/remote.git` using `node:child_process` `execSync` inside `beforeAll`. The `GitClient` is pointed at this bare repo as its remote.

**Rationale**: `simple-git` exercises real git operations; mocking it would not verify the actual push/pull semantics tested by the CLI integration story. A local bare repo eliminates all network dependency.

**Pattern**:
```typescript
import { execSync } from "node:child_process";
import { join } from "node:path";

let remoteDir: string;
beforeAll(async () => {
  remoteDir = join(tmpDir, "remote.git");
  execSync(`git init --bare "${remoteDir}"`);
});
```

---

## Decision 7: Debounce Timer Testing

**Decision**: Use `bun:test`'s `mock.setSystemTime` to advance virtual time. Set the debounce to a small value (100 ms) in tests, trigger file writes, then advance the virtual clock past the debounce window using `mock.setSystemTime(Date.now() + 200)`.

**Rationale**: `bun:test` provides `mock.setSystemTime` (analogous to Jest's `useFakeTimers`) for controlling `Date.now()`. However, `setTimeout` may need Bun's `--fake-timers` flag or `setSystemTime`. Need to verify watcher actually uses `setTimeout` for debounce (confirmed in `src/core/watcher.ts`).

**Alternative considered**: Sleep for real debounce window (e.g., `await Bun.sleep(150)`) — acceptable for short windows in test but slower. Use real sleep for watcher tests since the debounce is filesystem-event driven and `setSystemTime` does not affect `setTimeout` completion in real FS watch mode. Use 50 ms or lower debounce values in watcher tests and `await Bun.sleep(duration + 20)` as the synchronization mechanism.

---

## Decision 8: Daemon Installer Mocking

**Decision**: Use `spyOn` from `bun:test` to mock the `execFile`/`exec` function from `node:child_process` before importing the installer module. Restore the original after each test.

**Rationale**: Running real `launchctl`, `systemctl`, or `schtasks` during tests would modify the OS. `bun:test` supports standard `spyOn`/`mock` patterns from Jest-compatible API.

**Pattern**:
```typescript
import { spyOn } from "bun:test";
import * as childProcess from "node:child_process";

beforeEach(() => {
  spyOn(childProcess, "execFile").mockResolvedValue({ stdout: "", stderr: "" });
});
```

---

## Decision 9: Zip-Slip Test Approach

**Decision**: Manually construct a malicious tar archive using the `tar` npm package inside the test itself, embedding entries with absolute paths and `../` traversal segments. Pass the resulting Buffer to `extractArchive` and assert no files appeared outside the target directory.

**Rationale**: Testing the rejection path requires a crafted archive; there is no external test vector needed since the `tar` package itself is used to create the archive.

---

## Decision 10: Contracts Directory

**Decision**: Skip `contracts/` entirely.

**Rationale**: `agent-sync` is a CLI tool that exposes no external API surface to other programs. The only "contract" is the CLI argument interface, which is defined by the `citty` command tree and covered by the integration tests. Generating API contract documents (OpenAPI, JSON Schema, etc.) does not apply.

---

## Summary of All Resolved Unknowns

| Unknown | Resolution |
|---|---|
| Test runner | `bun test` (constitution + existing files) |
| Coverage thresholds | 90% security modules, 70% others (constitution §II) |
| Temp fixture pattern | `mkdtemp` + `afterEach` cleanup |
| Age key generation in tests | Call `generateIdentity()` per test; no hard-coded keys |
| IPC test isolation | Socket in per-test tmpdir |
| Git integration tests | Local `git init --bare` remote |
| Debounce test strategy | Short window + `await Bun.sleep` sync |
| Installer tests | `spyOn` on `child_process` |
| Zip-slip test | Craft malicious tar Buffer inside test |
| Contracts directory | Not applicable for CLI tool |
