import { dirname } from "node:path";
import { log } from "@clack/prompts";
import { performPull } from "../commands/pull";
import { performPush } from "../commands/push";
import { resolveRuntimeContext } from "../commands/shared";
import { loadConfig, resolveConfigPath } from "../config/loader";
import { AgentPaths } from "../config/paths";
import { IpcServer } from "../core/ipc";
import { Watcher } from "../core/watcher";

/** Delegate pull requests through the shared command pipeline used by the CLI. */
async function runPull(): Promise<{ applied: number; errors: string[]; fatal: boolean }> {
  const result = await performPull();
  if (result.fatal) {
    for (const err of result.errors) {
      log.error(`${ts()} ${err}`);
    }
  }
  return result;
}

/** Format daemon log timestamps consistently across lifecycle events. */
const ts = () => new Date().toISOString();

/**
 * Start the IPC server, file watchers, and periodic pull loop for background sync.
 * @returns A promise that resolves once the daemon has bound its IPC socket and registered watchers.
 */
export async function startDaemon(): Promise<void> {
  const runtime = await resolveRuntimeContext();
  const config = await loadConfig(resolveConfigPath(runtime.vaultDir));
  const socketPath = (await import("../config/paths")).resolveDaemonSocketPath();

  const pullIntervalMs = config.sync.pullIntervalMs ?? 5 * 60 * 1000;

  const ipc = new IpcServer();

  ipc.on("status", async () => ({ ok: true, pid: process.pid }));

  ipc.on("push", async () => {
    const result = await performPush();
    if (result.fatal) {
      for (const err of result.errors) {
        log.error(`${ts()} ${err}`);
      }
    }
    return result;
  });

  ipc.on("pull", async () => {
    const result = await runPull();
    return result;
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
      const result = await performPush();
      if (result.fatal) {
        for (const err of result.errors) {
          log.error(`${ts()} ${err}`);
        }
      }
    });
  }

  // Periodic pull using interval from config
  const pullTimer = setInterval(async () => {
    await runPull();
  }, pullIntervalMs);

  // Graceful shutdown
  const shutdown = async () => {
    clearInterval(pullTimer);
    await watcher.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
