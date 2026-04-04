# Data Model: Initial Function Testing

**Feature**: `001-initial-function-testing`
**Date**: 2026-04-04
**Status**: Final

---

## Overview

This feature adds no new runtime data models — it is a test-only implementation. The "data model" here describes the **test fixture schema** (how each test sets up its isolated environment) and the **coverage target table** (per-module thresholds mandated by the constitution).

---

## 1. Core Test Fixture

Every test file that exercises filesystem or process I/O is built on a shared fixture pattern. The fixture is scoped per-test and cleaned up after each test.

```text
TestFixture {
  tmpDir:      string          // absolute path under os.tmpdir() — created by mkdtemp()
  identity:    string          // AGE secret key — generated fresh by generateIdentity()
  recipient:   string          // AGE public key — derived via identityToRecipient(identity)
}
```

**Lifecycle**:

```typescript
// In each *.test.ts that needs isolation:
let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "agentsync-test-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});
```

**Constraints**:
- `tmpDir` must NOT be a path under `~/.config/agentsync` or any real agent config location.
- `identity` and `recipient` are throwaway values; they must NOT be committed as constants.

---

## 2. Extended Fixture Variants

### 2a. Encryption Fixture (encryptor.test.ts)

```text
EncryptionFixture extends TestFixture {
  identity:   string  // age secret key identity string (AGE-SECRET-KEY-1...)
  recipient:  string  // age recipient public key (age1...)
}
```

### 2b. Git Integration Fixture (integration.test.ts, git.test.ts)

```text
GitFixture extends TestFixture {
  remoteDir:  string  // path to local bare git repo: <tmpDir>/remote.git
  workDir:    string  // path to working checkout: <tmpDir>/work
}
```

**Creation**:
```typescript
remoteDir = join(tmpDir, "remote.git");
execSync(`git init --bare "${remoteDir}"`);

workDir = join(tmpDir, "work");
await mkdir(workDir, { recursive: true });
execSync(`git init "${workDir}"`);
execSync(`git remote add origin "${remoteDir}"`, { cwd: workDir });
```

### 2c. IPC Fixture (ipc.test.ts)

```text
IpcFixture extends TestFixture {
  socketPath: string      // <tmpDir>/daemon.sock
  server:     IpcServer   // running server bound to socketPath
  client:     IpcClient   // connected client
}
```

### 2d. Watcher Fixture (watcher.test.ts)

```text
WatcherFixture extends TestFixture {
  watchDir:    string    // <tmpDir>/watch — directory under observation
  debounceMs:  number    // low value for tests (e.g., 50 ms)
  events:      string[]  // accumulator for emitted change events
}
```

---

## 3. Configuration Fixture Schema

Config tests need a valid `AgentSyncConfig` object. The minimal valid shape for tests is:

```typescript
import type { AgentSyncConfig } from "../../config/schema";

const minimalConfig: AgentSyncConfig = {
  remote: "file:///tmp/remote.git",
  recipients: ["age1testrecipient"],
};
```

Invalid shapes exercised:
- Missing `remote` field
- `remote` is not a string
- `recipients` is empty array (if schema enforces min items)
- Extra fields (passthrough vs strict behavior)

---

## 4. Coverage Target Table

> Mandated by `constitution.md` §II — Test Coverage

| Source Module | Min Line Coverage | Category |
|---|---|---|
| `src/core/encryptor.ts` | **≥ 90%** | Security-critical |
| `src/core/sanitizer.ts` | **≥ 90%** | Security-critical |
| `src/config/schema.ts` | **≥ 90%** | Security-critical |
| `src/core/tar.ts` | ≥ 70% | Core utility |
| `src/core/ipc.ts` | ≥ 70% | Core utility |
| `src/core/git.ts` | ≥ 70% | Core utility |
| `src/core/watcher.ts` | ≥ 70% | Core utility |
| `src/config/loader.ts` | ≥ 70% | Config |
| `src/config/paths.ts` | ≥ 70% | Config |
| `src/agents/_utils.ts` | ≥ 70% | Agent utility |
| `src/agents/claude.ts` | ≥ 70% | Agent |
| `src/agents/codex.ts` | ≥ 70% | Agent |
| `src/agents/copilot.ts` | ≥ 70% | Agent |
| `src/agents/cursor.ts` | ≥ 70% | Agent |
| `src/agents/vscode.ts` | ≥ 70% | Agent |
| `src/agents/registry.ts` | ≥ 70% | Agent registry |
| `src/commands/shared.ts` | ≥ 70% | Command infrastructure |
| `src/daemon/installer-macos.ts` | ≥ 70% | Daemon installer |
| `src/daemon/installer-linux.ts` | ≥ 70% | Daemon installer |
| `src/daemon/installer-windows.ts` | ≥ 70% | Daemon installer |
| `src/lib/debug.ts` | ≥ 70% | Debug utility |

> `src/cli.ts`, `src/daemon/index.ts`, and `src/commands/*.ts` (other than `shared.ts`) are tested via integration tests; exact coverage measured by `bun test --coverage`.

---

## 5. Test File → Source Module Map

| New Test File | Source Module(s) Covered |
|---|---|
| `src/core/encryptor.test.ts` [NEW] | `src/core/encryptor.ts` |
| `src/core/sanitizer.test.ts` [EXTEND] | `src/core/sanitizer.ts` |
| `src/core/tar.test.ts` [NEW] | `src/core/tar.ts` |
| `src/core/ipc.test.ts` [NEW] | `src/core/ipc.ts` |
| `src/core/watcher.test.ts` [NEW] | `src/core/watcher.ts` |
| `src/core/git.test.ts` [NEW] | `src/core/git.ts` |
| `src/config/schema.test.ts` [EXTEND] | `src/config/schema.ts` |
| `src/config/loader.test.ts` [NEW] | `src/config/loader.ts` |
| `src/config/paths.test.ts` [NEW] | `src/config/paths.ts` |
| `src/agents/_utils.test.ts` [NEW] | `src/agents/_utils.ts` |
| `src/agents/claude.test.ts` [NEW] | `src/agents/claude.ts` |
| `src/agents/codex.test.ts` [NEW] | `src/agents/codex.ts` |
| `src/agents/copilot.test.ts` [NEW] | `src/agents/copilot.ts` |
| `src/agents/cursor.test.ts` [NEW] | `src/agents/cursor.ts` |
| `src/agents/vscode.test.ts` [NEW] | `src/agents/vscode.ts` |
| `src/agents/registry.test.ts` [NEW] | `src/agents/registry.ts` |
| `src/commands/shared.test.ts` [NEW] | `src/commands/shared.ts` |
| `src/commands/integration.test.ts` [NEW] | `src/commands/{init,push,pull,status,doctor,key}.ts`, `src/daemon/index.ts`, `src/cli.ts` |
| `src/daemon/installer-macos.test.ts` [NEW] | `src/daemon/installer-macos.ts` |
| `src/daemon/installer-linux.test.ts` [NEW] | `src/daemon/installer-linux.ts` |
| `src/daemon/installer-windows.test.ts` [NEW] | `src/daemon/installer-windows.ts` |

**Total new files**: 19 (17 new + 2 extend)  
**Total source modules exercised**: 21

---

## 6. State Transitions

No persistent state machines in the project. Runtime state transitions relevant to testing:

| Module | State Flow |
|---|---|
| `IpcServer` | `unbound` → `listening` → `closed` |
| `Watcher` | `active` → `debouncing` → `fires callback` → `active` |
| `GitClient` | local commits → `push` → remote bare repo |
| `Encryptor` | plaintext → `encrypt` → ciphertext → `decrypt` → plaintext |
