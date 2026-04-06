# Data Model: Stabilise Daemon Process

**Branch**: `20260406-094347-stabilise-daemon` | **Date**: 2026-04-06

---

## Entities

### DaemonState (in-memory, `daemon/index.ts`)

Holds the daemon's runtime mutable state. Not persisted across restarts.

| Field | Type | Description |
|-------|------|-------------|
| `consecutiveFailures` | `number` | Count of sync operations that have failed consecutively since the last success. Reset to `0` on any successful push or pull. |
| `lastError` | `string \| null` | Human-readable message from the most recent sync failure. `null` if no failure has occurred since startup or since the last successful sync. |

**Invariants**:
- `consecutiveFailures >= 0`
- If `consecutiveFailures === 0` then `lastError` is `null` (reset together)

---

### DaemonStatusResponse (IPC message, crosses trust boundary)

Returned by the `status` IPC command handler. Validated with Zod schema `DaemonStatusSchema` in `src/config/schema.ts`.

| Field | Type | Description |
|-------|------|-------------|
| `ok` | `true` | Always `true` for a successful status response (outer IPC envelope uses `ok: boolean`) |
| `pid` | `number` | Process ID of the running daemon |
| `consecutiveFailures` | `number` | From `DaemonState` |
| `lastError` | `string \| null` | From `DaemonState` |

**Zod schema** (to be added to `src/config/schema.ts`):
```typescript
export const DaemonStatusSchema = z.object({
  pid: z.number().int().positive(),
  consecutiveFailures: z.number().int().min(0),
  lastError: z.string().nullable(),
});
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;
```

---

### SyncOperation (in-flight, `core/sync-queue.ts`)

Represents a single async operation enqueued in the `SyncQueue`. Not stored — exists only as a queued promise.

| Field | Type | Description |
|-------|------|-------------|
| `fn` | `() => Promise<T>` | The sync work to execute (push or pull) |
| `result` | `Promise<T>` | Resolves when the operation completes; rejects on failure |

**Lifecycle**: Enqueued → waiting → executing → settled (resolved or rejected).

---

### ExecutableArgs (installer input, `commands/daemon.ts`)

Replaces the previous `string` return type of `getExecutablePath()`. Returned by `getExecutableArgs()`.

| Field | Type | Description |
|-------|------|-------------|
| `args` | `string[]` | Ordered list: `args[0]` is the binary path; `args[1]` (if present) is the script path. Always length ≥ 1. |

**Invariants**:
- `args[0]` is an absolute path to a stable, persistent executable
- If `args.length === 2`, `args[1]` is the script entrypoint passed to the interpreter
- Neither element contains a path inside a temporary or session-scoped directory

---

## State Transitions

### Daemon Lifecycle

```
[Startup]
    │
    ▼
[Initialising] ──── config/vault missing ──→ [Exit non-zero: FR-006/FR-007]
    │
    ▼
[Binding IPC socket] ─── stale socket ──→ [Remove stale socket → retry bind]
    │
    ▼
[Running]
    │
    ├── file-change event ──→ [Syncing: push] ──→ success → reset failure record → [Running]
    │                                          └→ failure → retry once → success → reset → [Running]
    │                                                                  └→ failure → log + increment → [Running]
    │
    ├── pull interval tick ─→ [Syncing: pull] ──→ (same as push above)
    │
    ├── IPC: push ──────────→ [Syncing: push] ──→ (same as push above)
    │
    ├── IPC: pull ──────────→ [Syncing: pull] ──→ (same as pull above)
    │
    ├── IPC: status ─────────→ return { pid, consecutiveFailures, lastError } → [Running]
    │
    └── SIGTERM / SIGINT ───→ [Shutting Down]
                                    │
                                    ├── stop pull interval
                                    ├── close IPC server
                                    ├── drain sync queue (≤10s)
                                    ├── close file watchers
                                    ├── unlink IPC socket file
                                    └── process.exit(0)
```

### SyncOperation Lifecycle

```
enqueue(fn) → [Waiting] → [Executing] → [Success: reset failure record]
                                      → [Failure: retry once immediately]
                                                    → [Success: reset failure record]
                                                    → [Final failure: log + increment consecutiveFailures]
```
