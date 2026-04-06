# Research: Stabilise Daemon Process

**Branch**: `20260406-094347-stabilise-daemon` | **Date**: 2026-04-06

---

## R-001: macOS launchd ProgramArguments Format

**Decision**: Each element of `ProgramArguments` must be a separate `<string>` XML node. The first element is used as the binary path passed to `execv()`; there is no automatic shell tokenisation.

**Rationale**: Confirmed from `launchd.plist(5)` man page and live evidence (`last exit code = 78: EX_CONFIG`). The current `buildPlist()` puts `"bun /path/cli.js"` into one `<string>`, so `execv()` is called with a path containing a literal space — no such file exists.

**Fix**: `getExecutablePath()` must return `string[]`. `buildPlist()` must emit one `<string>` per element.

**Reference**: `man launchd.plist` — "ProgramArguments: This key maps to the first argument of execv(3)."

---

## R-002: Windows Task Scheduler Command/Arguments Split

**Decision**: The `<Command>` XML element holds the binary path only; `<Arguments>` holds all subsequent tokens space-separated. Combining both into `<Command>` causes `CreateProcess` to look for a binary at a path with spaces.

**Rationale**: Windows Task Scheduler XML schema separates binary from arguments. The current `buildXml()` puts `"bun /path/cli.js"` into `<Command>`, which fails identically to the macOS bug.

**Fix**: `buildXml(args: string[])` should use `args[0]` as `<Command>` and join `[...args.slice(1), "daemon", "_run"]` as `<Arguments>`.

**Reference**: Microsoft Task Scheduler XML schema — `Exec.Command` element holds the application name; `Exec.Arguments` holds the command-line arguments.

---

## R-003: Linux systemd ExecStart (No Change Required)

**Decision**: Linux is not affected by the executable path format bug. No change to path handling is needed for Linux.

**Rationale**: systemd's `ExecStart` uses shell-like space tokenisation. `ExecStart=/path/to/bun /path/to/cli.js daemon _run` correctly resolves to binary=`/path/to/bun`, args=`["/path/to/cli.js", "daemon", "_run"]`. Confirmed by reading `systemd.service(5)` man page.

**Alternatives considered**: Migrating Linux to `string[]` for interface consistency — accepted as a minor refactor but not required for correctness.

**Reference**: `man systemd.service` — "ExecStart: Takes a command line, which are split by whitespace."

---

## R-004: macOS launchctl Idempotent Re-install Pattern

**Decision**: Use `bootout` (ignoring error if service not loaded) → write plist → `bootstrap`. This makes `daemon install` idempotent.

**Rationale**: `launchctl bootstrap` on an already-registered service returns error code 5 ("Bootstrap failed: Input/output error"). The correct re-install sequence is `bootout` first. `launchctl bootout` returns a non-zero code if the service isn't loaded, which must be swallowed.

**Reference**: Apple developer docs on launchd — `launchctl bootout` removes a service from the bootstrap namespace; `launchctl bootstrap` adds it.

---

## R-005: Detecting Ephemeral / Temp Executable Paths

**Decision**: Compare the resolved script path against `os.tmpdir()` (after `fs.realpathSync`) to detect bunx temp directories. Also check for `bunx-` in the path as a belt-and-suspenders guard.

**Rationale**: On macOS, `os.tmpdir()` returns the user-scoped temp dir (`/var/folders/{x}/{hash}/T`), which is exactly the bunx cache location. `process.argv[1]` when running via `bunx` is always inside this directory.

**Fix**: In `getExecutablePath()` (renamed `getExecutableArgs()`), after detecting the bun case, call `isEphemeralPath(process.argv[1])`. If true, throw an error directing the user to install globally: `bun install -g @chrisleekr/agentsync`.

---

## R-006: macOS launchctl Bootstrap State Check for `daemon start`

**Decision**: Run `launchctl print gui/<uid>/com.agentsync.daemon` to check registration state before calling `kickstart`. A non-zero exit code means the service is not registered.

**Rationale**: `isInstalledMacOs()` currently only checks whether the plist file exists on disk — not whether launchd has the service registered. A plist file can exist from a failed install. Querying `launchctl print` is the authoritative check.

**Reference**: `launchctl print gui/<uid>/<label>` exits non-zero if the service is not in the bootstrap namespace.

---

## R-007: Linux systemd Registration Check for `daemon start`

**Decision**: Run `systemctl --user is-enabled agentsync` before calling `systemctl --user start`. A result of `not-found` means unregistered.

**Rationale**: `isInstalledLinux()` only checks file presence. `systemctl is-enabled` queries the live systemd state.

**Reference**: `man systemctl` — `is-enabled`: "Checks whether any of the specified unit files are enabled." Outputs `enabled`, `disabled`, or `not-found`.

---

## R-008: SyncQueue — Promise Serialisation Without New Dependencies

**Decision**: Implement a minimal `SyncQueue` class in `src/core/sync-queue.ts` using a promise chain. No new runtime dependency needed.

**Rationale**: The requirement is to serialise push and pull operations so only one runs at a time. A simple `tail: Promise<void>` that each new enqueue appends to is the standard pattern. The class also exposes a `whenIdle()` promise for graceful shutdown drain.

**Pattern**:
```typescript
class SyncQueue {
  private tail: Promise<void> = Promise.resolve();
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  whenIdle(): Promise<void> { return this.tail; }
}
```

**Alternatives considered**: Using a third-party queue library (rejected — adds a dependency for trivial logic); using a mutex semaphore (more complex, same outcome).

---

## R-009: Retry-Once Wrapper

**Decision**: Implement a local `withRetry(fn)` helper inside `daemon/index.ts` that calls `fn()` once, and on failure calls `fn()` again before re-throwing.

**Rationale**: The retry policy (FR-014) is "retry exactly once immediately, then give up until next trigger." A standalone helper is cleaner than duplicating try/catch at every call site.

---

## R-010: Failure Record in Daemon State

**Decision**: Maintain `{ consecutiveFailures: number; lastError: string | null }` in module scope in `daemon/index.ts`. Reset to `{ consecutiveFailures: 0, lastError: null }` on any successful sync. Expose via `status` IPC handler.

**Rationale**: In-memory is sufficient — the spec says the counter resets on restart (implicit from "in memory"). No persistence layer needed.

**Schema (FR-004, Constitution Principle IV)**: The `status` IPC response crosses a trust boundary, so it must be validated with Zod. Add `DaemonStatusSchema` to `src/config/schema.ts`.

---

## R-011: Shutdown — Wait for In-Flight Operations Before Exit

**Decision**: In the `shutdown` handler, call `queue.whenIdle()` before `process.exit(0)`, with a 10-second max wait (matching SC-001). Also call `ipc.close()` and `unlink(socketPath)` (swallowing ENOENT).

**Rationale**: `process.exit(0)` is called synchronously in the current shutdown handler, terminating any running push/pull mid-write. `queue.whenIdle()` returns a promise that resolves only when all queued operations have settled.
