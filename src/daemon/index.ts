import { access, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "@clack/prompts";
import { performPush } from "../commands/push";
import { resolveRuntimeContext } from "../commands/shared";
import {
  formatConfigError,
  isConfigParseError,
  loadConfig,
  resolveConfigPath,
} from "../config/loader";
import { AgentPaths } from "../config/paths";
import { DaemonStatusSchema } from "../config/schema";
import { IpcClient, IpcServer } from "../core/ipc";
import { shouldNeverSync } from "../core/sanitizer";
import { SyncQueue } from "../core/sync-queue";
import { Watcher } from "../core/watcher";
import {
  applyFailure,
  applySuccess,
  type DaemonState,
  EMPTY_DAEMON_STATE,
  notifyDesktop,
  readDaemonState,
  writeDaemonState,
} from "./state";

/** Format daemon log timestamps consistently across lifecycle events. */
const ts = () => new Date().toISOString();

// While stuck (vault diverged), a watcher-driven push is RE-ENQUEUED at most
// this often, so a divergent vault is not hammered on every keystroke. A manual
// (IPC) push is never throttled — the user asked for it explicitly.
const STUCK_BACKOFF_MS = 5 * 60 * 1000;

// ── Durable health state ─────────────────────────────────────────────────
// Mirrors the on-disk daemon-state.json so `daemon status` and `doctor` can
// report health even after the daemon exits. Initialised in startDaemon.
let state: DaemonState = EMPTY_DAEMON_STATE;
let lastWatchAttemptAt = 0;

/** Record a successful sync: clear failures, clear stuck, persist. */
function recordSuccess(): void {
  state = applySuccess(state, ts());
  void writeDaemonState(state);
}

/**
 * Record a failed sync: bump the counter, latch `stuck` on divergence, persist,
 * and fire ONE desktop notification on the transition into stuck — a silently
 * stalled backup is the worst failure mode for a backup tool.
 */
function recordFailure(op: "push", msg: string): void {
  const wasStuck = state.stuck;
  state = applyFailure(state, op, msg, ts());
  void writeDaemonState(state);
  if (!wasStuck && state.stuck) {
    notifyDesktop(
      "AgentSync: auto-sync stuck",
      "Vault history diverged — auto-sync is paused until you reset the vault. Run `agentsync doctor`.",
    );
  }
}

// ── Retry logic ──────────────────────────────────────────────────────────

/**
 * Calls `fn` once; on failure retries exactly once.
 * The second attempt's result (resolve or reject) propagates to the caller.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

/** Run one push through the queue, recording success/failure into durable state. */
async function runSyncOnce(): Promise<void> {
  try {
    const result = await withRetry(() => performPush());
    if (result.fatal) {
      for (const err of result.errors) {
        log.error(`${ts()} ${err}`);
      }
      recordFailure("push", result.errors.join("; "));
    } else {
      recordSuccess();
    }
  } catch (err) {
    recordFailure("push", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Start the IPC server and file watchers for push-only background sync.
 * @returns A promise that resolves once the daemon has bound its IPC socket and registered watchers.
 */
export async function startDaemon(): Promise<void> {
  // ── Startup validation ──────────────────────────
  let runtime: Awaited<ReturnType<typeof resolveRuntimeContext>> | undefined;
  try {
    runtime = await resolveRuntimeContext();
    // Eagerly load config to validate vault accessibility
    await loadConfig(resolveConfigPath(runtime.vaultDir));
    // Validate encryption key is readable
    await access(runtime.privateKeyPath);
  } catch (err) {
    // A schema/TOML failure here would otherwise log a multi-line Zod/Toml blob
    // into the launchd/systemd journal; collapse it to one parseable line.
    const msg =
      runtime && isConfigParseError(err)
        ? formatConfigError(err, resolveConfigPath(runtime.vaultDir))
        : err instanceof Error
          ? err.message
          : String(err);
    log.error(`${ts()} Startup failed: ${msg}`);
    process.exit(1);
    return; // unreachable but satisfies TS control flow
  }

  // Initialise durable state: keep prior last-success/last-error/stuck so status
  // and doctor stay accurate across restart, but stamp this process's
  // pid/startedAt and reset the per-session failure counter.
  const prior = await readDaemonState();
  state = { ...prior, pid: process.pid, startedAt: ts(), consecutiveFailures: 0 };
  void writeDaemonState(state);

  const config = await loadConfig(resolveConfigPath(runtime.vaultDir));
  const socketPath = (await import("../config/paths")).resolveDaemonSocketPath();

  // ── Second-instance detection ───────────────────────────
  const client = new IpcClient();
  try {
    const response = await client.send("status", {}, socketPath);
    if (response.ok) {
      const pid = (response.data as { pid?: number })?.pid ?? "unknown";
      log.info(`${ts()} Daemon is already running (pid: ${pid})`);
      process.exit(1);
      return;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ECONNREFUSED") {
      // Stale socket — unlink before proceeding
      try {
        await unlink(socketPath);
      } catch {
        // ENOENT is fine — socket already gone
      }
    }
    // ENOENT = no socket file, clean start — continue
  }

  // ── SyncQueue ──────────────────────────────────────────────────────
  const queue = new SyncQueue();

  const ipc = new IpcServer();

  ipc.on("status", async () =>
    DaemonStatusSchema.parse({
      pid: process.pid,
      consecutiveFailures: state.consecutiveFailures,
      lastError: state.lastError,
      lastSuccessAt: state.lastSuccessAt,
      startedAt: state.startedAt,
      stuck: state.stuck,
    }),
  );

  // A manual (IPC) push is never throttled — the user asked for it.
  ipc.on("push", async () => queue.enqueue(runSyncOnce));

  await ipc.listen(socketPath);
  log.info(`${ts()} AgentSync daemon started (pid ${process.pid}, socket ${socketPath})`);

  // Watch agent config directories and push on change
  const watcher = new Watcher();
  const debounceMs = 2000;

  const watchTargets: string[] = [];
  if (config.agents.claude) watchTargets.push(dirname(AgentPaths.claude.claudeMd));
  if (config.agents.cursor) watchTargets.push(dirname(AgentPaths.cursor.mcpGlobal));
  if (config.agents.codex) watchTargets.push(AgentPaths.codex.root);
  if (config.agents.copilot) watchTargets.push(AgentPaths.copilot.instructionsDir);

  for (const target of watchTargets) {
    watcher.add(
      target,
      debounceMs,
      async () => {
        // Back off while stuck so a divergent vault is not hammered on every
        // change; a manual `agentsync push` (IPC) still goes through immediately.
        if (state.stuck && Date.now() - lastWatchAttemptAt < STUCK_BACKOFF_MS) return;
        lastWatchAttemptAt = Date.now();
        await queue.enqueue(runSyncOnce).catch(() => {
          // Queue closed during shutdown — safe to ignore
        });
      },
      // Pre-filter never-sync paths at the watch layer so high-churn dirs
      // (sessions, history) never reset the debounce or wake a no-op push.
      shouldNeverSync,
    );
  }

  // No periodic pull and no pull IPC handler: the vault is push-only backup.
  // Each machine's local config is its own source of truth, so the daemon only
  // auto-pushes on change. Bringing vault content down is an explicit, manual
  // `agentsync copy`, never a daemon action.

  // ── Graceful shutdown ──────────────────────────────────────────────
  const shutdown = async () => {
    ipc.close();
    queue.close();
    // Drain in-flight sync operations with a hard timeout
    await Promise.race([queue.whenIdle(), delay(10_000)]);
    await watcher.close();
    try {
      await unlink(socketPath);
    } catch {
      // ENOENT is fine — socket already gone
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/** Simple delay helper for shutdown timeout. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
