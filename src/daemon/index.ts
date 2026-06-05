import { access, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "@clack/prompts";
import { performPull } from "../commands/pull";
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
import { SyncQueue } from "../core/sync-queue";
import { Watcher } from "../core/watcher";

/** Format daemon log timestamps consistently across lifecycle events. */
const ts = () => new Date().toISOString();

// ── Failure tracking ─────────────────────────────────────────────────────
let consecutiveFailures = 0;
let lastError: string | null = null;

/** Reset failure counters after a successful sync operation. */
function recordSuccess(): void {
  consecutiveFailures = 0;
  lastError = null;
}

/**
 * Increment the consecutive failure counter and capture the error message.
 * The operation type is always included in `lastError` for diagnostics.
 * `lastError` MUST NOT include key file content — only paths and error codes.
 */
function recordFailure(op: "push" | "pull", msg: string): void {
  consecutiveFailures += 1;
  lastError = `[${op}] ${msg}`;
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

/**
 * Start the IPC server, file watchers, and periodic pull loop for background sync.
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
      consecutiveFailures,
      lastError,
    }),
  );

  ipc.on("push", async () => {
    return queue.enqueue(async () => {
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
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordFailure("push", msg);
        throw err;
      }
    });
  });

  ipc.on("pull", async () => {
    return queue.enqueue(async () => {
      try {
        const result = await withRetry(() => performPull());
        if (result.fatal) {
          for (const err of result.errors) {
            log.error(`${ts()} ${err}`);
          }
          recordFailure("pull", result.errors.join("; "));
        } else {
          recordSuccess();
        }
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        recordFailure("pull", msg);
        throw err;
      }
    });
  });

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
    watcher.add(target, debounceMs, async () => {
      await queue
        .enqueue(async () => {
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
            const msg = err instanceof Error ? err.message : String(err);
            recordFailure("push", msg);
          }
        })
        .catch(() => {
          // Queue closed during shutdown — safe to ignore
        });
    });
  }

  // No periodic pull: the vault is push-only backup. Each machine's local
  // config is its own source of truth, so the daemon only auto-pushes on change.
  // A manual pull remains available over IPC.

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
