# IPC Contract: `status` Command

**Branch**: `20260406-094347-stabilise-daemon` | **Date**: 2026-04-06

The `status` IPC command is the primary health-check interface between the CLI and the running daemon. This document defines the request/response contract after the daemon stabilisation changes.

---

## Request

```jsonc
// IpcRequest envelope (unchanged)
{
  "id": "<uuid-v4>",
  "cmd": "status",
  "args": {}   // no arguments required
}
```

## Response (success — daemon running)

```jsonc
// IpcResponse envelope
{
  "id": "<uuid-v4>",      // echoes request id
  "ok": true,
  "data": {
    "pid": 12345,                    // number — daemon process ID
    "consecutiveFailures": 3,        // number (≥0) — failures since last success
    "lastError": "remote: not found" // string | null — null if no recent failure
  }
}
```

**Zod schema** (source of truth in `src/config/schema.ts`):

```typescript
export const DaemonStatusSchema = z.object({
  pid: z.number().int().positive(),
  consecutiveFailures: z.number().int().min(0),
  lastError: z.string().nullable(),
});
```

## Response (error — command failed internally)

```jsonc
{
  "id": "<uuid-v4>",
  "ok": false,
  "error": "descriptive error message"
}
```

## Response (connection refused — daemon not running)

The IpcClient `send()` call throws (socket `ECONNREFUSED`). The CLI catches this and displays "Daemon is not running."

---

## Backward Compatibility

The `pid` field existed in the previous implementation (`{ ok: true, pid: number }`). The `consecutiveFailures` and `lastError` fields are **additive**. Existing callers that only read `pid` remain valid. New fields are validated via `DaemonStatusSchema` before use.

---

## `push` and `pull` Command Responses (unchanged contract)

These commands return the existing `{ applied: number; errors: string[]; fatal: boolean }` shape. No change to this contract in this feature.
