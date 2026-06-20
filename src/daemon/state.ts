import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveAgentSyncHome } from "../config/paths";

/**
 * Durable daemon health state, persisted to disk so `daemon status` and
 * `doctor` can report last-success/last-error and a stuck condition even after
 * the daemon process has exited or crashed. The in-memory daemon mirrors this
 * and writes it on every success/failure.
 */
export const DaemonStateSchema = z.object({
  /** PID of the daemon that last wrote this file, or null when never run. */
  pid: z.number().int().positive().nullable().default(null),
  /** ISO timestamp the current daemon process started, or null. */
  startedAt: z.string().datetime().nullable().default(null),
  // Validated as ISO so a hand-edited non-date value fails the whole parse and
  // degrades to EMPTY_DAEMON_STATE, rather than reaching Date.parse as NaN and
  // being silently mis-reported by doctor/status.
  /** ISO timestamp of the last successful push, or null when none has succeeded. */
  lastSuccessAt: z.string().datetime().nullable().default(null),
  /** ISO timestamp of the last failed push, or null. */
  lastErrorAt: z.string().datetime().nullable().default(null),
  /** Last failure message (paths/codes only — never key material), or null. */
  lastError: z.string().nullable().default(null),
  consecutiveFailures: z.number().int().min(0).default(0),
  /**
   * True when the vault has diverged (DIVERGED_HISTORY): the daemon cannot make
   * progress until a human resets the vault. Set so `doctor`/`status` escalate
   * loudly and the daemon backs off instead of hammering a doomed push.
   */
  stuck: z.boolean().default(false),
});

export type DaemonState = z.infer<typeof DaemonStateSchema>;

/** The shape returned when no state has ever been persisted. */
export const EMPTY_DAEMON_STATE: DaemonState = {
  pid: null,
  startedAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  stuck: false,
};

function statePath(): string {
  return join(resolveAgentSyncHome(), "daemon-state.json");
}

/**
 * Read durable daemon state. A missing, truncated, or hand-edited file degrades
 * to {@link EMPTY_DAEMON_STATE} rather than throwing — status/doctor must never
 * crash because the state file is unreadable.
 */
export async function readDaemonState(): Promise<DaemonState> {
  try {
    const parsed = DaemonStateSchema.safeParse(JSON.parse(await readFile(statePath(), "utf8")));
    return parsed.success ? parsed.data : EMPTY_DAEMON_STATE;
  } catch {
    return EMPTY_DAEMON_STATE;
  }
}

/**
 * Best-effort persist of daemon state. A write failure is swallowed: losing the
 * state file only costs status/doctor visibility, never the sync itself.
 */
export async function writeDaemonState(state: DaemonState): Promise<void> {
  try {
    await mkdir(resolveAgentSyncHome(), { recursive: true });
    // Write to a temp file then rename: rename(2) is atomic on a single
    // filesystem, so a crash or two overlapping writes never leave a torn
    // half-written JSON that readDaemonState would discard.
    const dest = statePath();
    const tmp = `${dest}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, dest);
  } catch {
    // Intentionally ignored — see doc comment.
  }
}

/**
 * True when a push error message indicates the vault has diverged. The
 * GitReconciliationError for DIVERGED_HISTORY always contains "diverged"; this
 * is the marker the daemon uses to flip into the stuck/back-off state.
 */
export function isDivergence(message: string): boolean {
  return /diverged/i.test(message);
}

/** Apply a successful sync: clears failures and any stuck condition. */
export function applySuccess(state: DaemonState, nowIso: string): DaemonState {
  return {
    ...state,
    lastSuccessAt: nowIso,
    consecutiveFailures: 0,
    lastError: null,
    stuck: false,
  };
}

/**
 * Apply a failed sync: bumps the failure counter, records the message, and
 * latches `stuck` when the failure is a divergence (a divergence does not heal
 * on its own — only a human resetting the vault, then a success, clears it).
 */
export function applyFailure(
  state: DaemonState,
  op: string,
  message: string,
  nowIso: string,
): DaemonState {
  return {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1,
    lastErrorAt: nowIso,
    lastError: `[${op}] ${message}`,
    stuck: state.stuck || isDivergence(message),
  };
}

/** Render a millisecond age as a coarse human duration ("9m", "3h", "2d"). */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Fire a best-effort desktop notification. Used to escalate a stuck daemon (a
 * silent backup failure is the worst outcome for a backup tool). Never throws:
 * a missing `osascript`/`notify-send`, or Windows where neither exists, is a
 * silent no-op. Fire-and-forget — the daemon does not await delivery.
 */
export function notifyDesktop(title: string, body: string): void {
  try {
    if (process.platform === "darwin") {
      Bun.spawn(
        [
          "osascript",
          "-e",
          `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
    } else if (process.platform === "linux") {
      Bun.spawn(["notify-send", title, body], { stdout: "ignore", stderr: "ignore" });
    }
    // Windows has no built-in CLI toast; skip rather than depend on PowerShell.
  } catch {
    // Best-effort only.
  }
}
