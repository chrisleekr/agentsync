# Implementation Plan: Stabilise Daemon Process

**Branch**: `20260406-094347-stabilise-daemon` | **Date**: 2026-04-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/20260406-094347-stabilise-daemon/spec.md`

---

## Summary

Fix three confirmed installer bugs (malformed `ProgramArguments` on macOS/Windows, ephemeral bunx path allowed through, non-idempotent re-install) and harden the daemon runtime (sync operation queue with serialisation and retry-once, failure tracking surfaced via IPC, clean shutdown that drains in-flight operations and removes the socket file). Add a `DaemonStatusSchema` Zod schema, a `SyncQueue` utility, updated platform installer contracts, a daemon lifecycle Mermaid diagram, and full test coverage for all new behaviours.

---

## Technical Context

**Language/Version**: TypeScript 6.x, strict mode (`"strict": true`)
**Runtime**: Bun 1.3.9 (Node.js compat layer for `node:fs`, `node:net`, `node:child_process`)
**Primary Dependencies**: citty 0.2.x, @clack/prompts 1.2.x, zod 4.x, simple-git 3.x, age-encryption 0.3.x
**Storage**: File system only (plist, systemd unit, IPC socket)
**Testing**: `bun test` (`bun:test`), `__tests__/*.test.ts` co-located with modules
**Target Platform**: macOS (launchd), Linux (systemd user), Windows (Task Scheduler)
**Project Type**: CLI tool + background daemon
**Performance Goals**: Shutdown ≤10s (SC-001), daemon start ≤10s (SC-007), startup error ≤3s (SC-006)
**Constraints**: No new runtime dependencies; Zod required for all IPC message shapes crossing trust boundaries (Constitution IV)

---

## Constitution Check

*GATE: Must pass before implementation begins.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Security-First | PASS | No credential handling changes; age key paths not touched |
| II. Test Coverage | REQUIRED — see below | All modified modules need updated/new tests |
| III. Cross-Platform Daemon Reliability | DIRECTLY ADDRESSED | This feature fixes violations of this principle |
| IV. Code Quality / Zod | REQUIRED | `DaemonStatusSchema` must be added; IPC status response validated with Zod |
| V. Documentation / Mermaid | REQUIRED | `docs/daemon.md` with lifecycle state diagram (FR-010) |

**Test coverage obligations (Principle II)**:

- `src/core/sync-queue.ts` — new module, must have `__tests__/sync-queue.test.ts` covering success path + serialisation + drain
- `src/daemon/index.ts` — existing tests must be updated to cover: queue serialisation, retry-once on failure, failure count increment/reset, socket cleanup on shutdown, drain-before-exit
- `src/commands/daemon.ts` — `getExecutableArgs()` must be tested: compiled binary path, bun+script path, ephemeral path detection/rejection
- `src/daemon/installer-macos.ts` — tests must cover: separate `<string>` elements in plist, bootout+bootstrap sequence, clean error surfacing from launchctl
- `src/daemon/installer-linux.ts` — tests must cover: updated `string[]` signature, registration check in `startLinux`
- `src/daemon/installer-windows.ts` — tests must cover: `<Command>` = binary only, `<Arguments>` = remaining args + daemon _run

**Documentation gate (Principle V)**:

- `docs/daemon.md` must include a Mermaid state diagram validated in GitHub Markdown preview before merge
- Diagram validation is a blocker for PR approval (documented in quickstart.md Scenario 8)

---

## Project Structure

### Documentation (this feature)

```text
specs/20260406-094347-stabilise-daemon/
├── plan.md           ← this file
├── research.md       ← Phase 0 output
├── data-model.md     ← Phase 1 output
├── quickstart.md     ← Phase 1 output (manual validation steps)
├── contracts/
│   └── ipc-status.md ← IPC status command contract
└── tasks.md          ← Phase 2 output (/speckit.tasks — not yet created)
```

### Source Code Changes

```text
src/
├── commands/
│   └── daemon.ts              MODIFY — getExecutableArgs(): string[], ephemeral check,
│                                       isRegistered() per-platform, start timeout
├── config/
│   └── schema.ts              MODIFY — add DaemonStatusSchema + DaemonStatus type
├── core/
│   ├── sync-queue.ts          NEW    — SyncQueue class
│   └── __tests__/
│       └── sync-queue.test.ts NEW    — SyncQueue unit tests
└── daemon/
    ├── index.ts               MODIFY — queue, retry-once, failure tracking, clean shutdown
    ├── installer-macos.ts     MODIFY — buildPlist(args: string[]), bootout→bootstrap,
    │                                   launchctl print for isRegistered, clean errors
    ├── installer-linux.ts     MODIFY — buildUnit(args: string[]), isRegistered via
    │                                   systemctl is-enabled, clean errors
    ├── installer-windows.ts   MODIFY — buildXml(args: string[]), split Command/Arguments
    └── __tests__/
        ├── index.test.ts      MODIFY — cover new behaviours
        ├── installer-macos.test.ts    MODIFY
        ├── installer-linux.test.ts    MODIFY
        └── installer-windows.test.ts  MODIFY

docs/
└── daemon.md                  NEW    — daemon lifecycle Mermaid state diagram
```

---

## Phase 0: Research Output

Research complete. See [research.md](./research.md). All NEEDS CLARIFICATION resolved:

| Topic | Decision | Reference |
|-------|----------|-----------|
| macOS ProgramArguments format | Each element = separate `<string>` | R-001, `launchd.plist(5)` |
| Windows Command/Arguments split | `<Command>` = binary only | R-002, Task Scheduler XML schema |
| Linux ExecStart | No change needed — systemd tokenises correctly | R-003, `systemd.service(5)` |
| macOS idempotent re-install | `bootout` (ignore error) → write plist → `bootstrap` | R-004 |
| Ephemeral path detection | `os.tmpdir()` comparison + `bunx-` guard | R-005 |
| macOS bootstrap state check | `launchctl print gui/<uid>/<label>` | R-006 |
| Linux registration check | `systemctl --user is-enabled agentsync` | R-007 |
| Sync serialisation | `SyncQueue` promise-chain, no new dep | R-008 |
| Retry-once wrapper | Local `withRetry(fn)` helper | R-009 |
| Failure record | In-memory `{ consecutiveFailures, lastError }` | R-010 |
| Shutdown drain | `queue.whenIdle()` + `ipc.close()` + `unlink(socket)` | R-011 |

---

## Phase 1: Design Details

### 1.1 — `getExecutableArgs()` in `src/commands/daemon.ts`

**Rename** `getExecutablePath(): string` → `getExecutableArgs(): string[]`.

**Logic**:

```typescript
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

function isEphemeralPath(filePath: string): boolean {
  try {
    const resolved = realpathSync(filePath);
    const tmp = realpathSync(tmpdir());
    return resolved.startsWith(tmp) || resolved.includes("bunx-");
  } catch {
    return false;
  }
}

function getExecutableArgs(): string[] {
  const isBun =
    process.argv[0].endsWith("bun") || process.argv[0].endsWith("bun.exe");
  if (isBun) {
    if (isEphemeralPath(process.argv[1])) {
      throw new Error(
        "Executable is in a temporary directory. " +
          "Install the package globally first: bun install -g @chrisleekr/agentsync"
      );
    }
    return [process.argv[0], process.argv[1]];
  }
  return [process.execPath];
}
```

**Callers** (`install` subcommand):

```typescript
const args = getExecutableArgs(); // string[]
await installer.install(args);    // signature changes from (exe: string) to (args: string[])
```

---

### 1.2 — `PlatformInstaller` interface update

Two changes to the `PlatformInstaller` interface in `daemon.ts`:

1. `install(exe: string)` → `install(args: string[])` — receives the full executable args array instead of a single concatenated string.
2. Add `isRegistered(): Promise<boolean>` — each platform module implements this to check whether the service is currently registered with the OS service manager (`launchctl print`, `systemctl is-enabled`, `schtasks /Query`). The `daemon start` subcommand calls this before attempting to start; the `daemon install` subcommand does not (it always registers). Stub implementations returning `Promise.resolve(false)` are added first (Phase 2) so TypeScript compiles; real implementations follow in Phase 6 (T035, T039, T041).

---

### 1.3 — `src/daemon/installer-macos.ts`

**`buildPlist(args: string[], logDir: string): string`**

Replace the single `<string>${executablePath}</string>` with a loop:

```typescript
function buildPlist(args: string[], logDir: string): string {
  const programArgs = [...args, "daemon", "_run"]
    .map((a) => `    <string>${a}</string>`)
    .join("\n");
  // ... plist template with ${programArgs} in the <array> block
}
```

**`installMacOs(args: string[]): Promise<void>`**

```typescript
export async function installMacOs(args: string[]): Promise<void> {
  // 1. bootout existing service (ignore ENOENT / not-loaded errors)
  try {
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
  } catch { /* not loaded — expected */ }

  // 2. write plist
  const plist = buildPlist(args, logDir);
  await writeFile(PLIST_PATH, plist, "utf8");

  // 3. bootstrap — surface clean error on failure
  try {
    await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
  } catch (err) {
    const msg = extractServiceManagerError(err);
    throw new Error(`launchd bootstrap failed: ${msg}\nHint: Check that the executable path exists and is not in a temporary directory.`);
  }
  log.success(`Installed launchd service: ${PLIST_LABEL}`);
}
```

**`extractServiceManagerError(err: unknown): string`** — a local helper that reads `(err as { stderr?: string }).stderr ?? String(err)` and strips internal stack frames. Returns only the service manager's stderr line.

**`isRegisteredMacOs(): Promise<boolean>`** — runs `launchctl print gui/<uid>/com.agentsync.daemon` and returns `true` on exit code 0.

**`startMacOs()`** — call `isRegisteredMacOs()` first; throw with actionable message if false. Wrap `kickstart` in `Promise.race` with a 10-second timeout.

---

### 1.4 — `src/daemon/installer-linux.ts`

**`buildUnit(args: string[]): string`**

```typescript
// ExecStart uses space-separated tokens; systemd tokenises correctly
const execStart = [...args, "daemon", "_run"].join(" ");
return `[Unit]\nDescription=...\n[Service]\nType=simple\nExecStart=${execStart}\n...`;
```

**`isRegisteredLinux(): Promise<boolean>`** — runs `systemctl --user is-enabled agentsync`. Returns `true` if stdout is `enabled`; `false` if `not-found` or `disabled`.

**`startLinux()`** — check `isRegisteredLinux()` first; throw with actionable message if false. Wrap `systemctl --user start` in a 10-second timeout.

---

### 1.5 — `src/daemon/installer-windows.ts`

**`buildXml(args: string[]): string`**

```typescript
const command = escapeXml(args[0]);
const scriptAndSubcmd = [...args.slice(1), "daemon", "_run"]
  .map(escapeXml)
  .join(" ");
// <Command>${command}</Command>
// <Arguments>${scriptAndSubcmd}</Arguments>
```

**`isInstalledWindows()`** — already queries `schtasks /Query`; this doubles as a registration check. **`startWindows()`** — check `isInstalledWindows()` first; wrap `schtasks /Run` in a 10-second timeout.

---

### 1.6 — `src/core/sync-queue.ts` (new file)

```typescript
/** Serialises async operations so only one runs at a time. */
export class SyncQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Enqueue fn; it will run only after any currently running operation settles. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Resolves when no operations are in progress or queued. */
  whenIdle(): Promise<void> {
    return this.tail;
  }
}
```

---

### 1.7 — `src/config/schema.ts` — add `DaemonStatusSchema`

```typescript
export const DaemonStatusSchema = z.object({
  pid: z.number().int().positive(),
  consecutiveFailures: z.number().int().min(0),
  lastError: z.string().nullable(),
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;
```

---

### 1.8 — `src/daemon/index.ts` — runtime hardening

**Key changes**:

```typescript
import { unlink } from "node:fs/promises";
import { SyncQueue } from "../core/sync-queue";
import { DaemonStatusSchema } from "../config/schema";

// Failure record
let consecutiveFailures = 0;
let lastError: string | null = null;

function recordSuccess(): void {
  consecutiveFailures = 0;
  lastError = null;
}

function recordFailure(err: string): void {
  consecutiveFailures++;
  lastError = err;
}

// Retry-once wrapper
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return fn(); // second attempt; throws if it also fails
  }
}

// Sync queue
const queue = new SyncQueue();

// Updated status handler
ipc.on("status", async () =>
  DaemonStatusSchema.parse({ pid: process.pid, consecutiveFailures, lastError })
);

// Wrap every push/pull call with queue + retry + record
async function runSyncOp(op: () => Promise<SyncResult>): Promise<SyncResult> {
  return queue.enqueue(async () => {
    try {
      const result = await withRetry(op);
      if (!result.fatal) recordSuccess();
      else recordFailure(result.errors.join("; "));
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordFailure(msg);
      throw err;
    }
  });
}

// Clean shutdown
const shutdown = async () => {
  clearInterval(pullTimer);
  ipc.close();
  // Drain in-flight ops, max 10s
  await Promise.race([queue.whenIdle(), new Promise<void>((r) => setTimeout(r, 10_000))]);
  await watcher.close();
  try { await unlink(socketPath); } catch { /* already gone */ }
  process.exit(0);
};
```

---

### 1.9 — `docs/daemon.md` (new file)

Must include a GitHub-compatible Mermaid state diagram. High-contrast colour pairs per the global CLAUDE.md rules. See quickstart.md Scenario 8 for validation requirements.

State diagram covers: `Starting` → `Running` → `Syncing` → `Running` (success) / `Error` (retry) → `Running`, and `Running` → `ShuttingDown` → `Stopped`.

---

## Complexity Tracking

No constitution violations requiring justification. All changes are additions or fixes within the existing module structure. No new project, no repository pattern, no abstraction layers beyond `SyncQueue` (which is 12 lines and has zero dependencies).
