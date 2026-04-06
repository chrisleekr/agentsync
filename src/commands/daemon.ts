import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { resolveDaemonSocketPath } from "../config/paths";
import { DaemonStatusSchema } from "../config/schema";
import { IpcClient } from "../core/ipc";

/**
 * Detect whether a file path resolves into a session-scoped temporary directory
 * (created by bunx or the OS). Such paths are not stable across reboots.
 */
function isEphemeralPath(filePath: string): boolean {
  // Check the raw path first — bunx creates paths like /tmp/bunx-<uid>-<hash>/...
  // which may not exist on disk during tests or after the bunx process exits.
  if (filePath.includes("bunx-")) return true;
  try {
    const resolved = realpathSync(filePath);
    const tmp = realpathSync(tmpdir());
    return resolved.startsWith(tmp);
  } catch {
    return false;
  }
}

/**
 * Resolve the full executable invocation the service manager should use.
 * Returns an array where each element becomes a separate `<string>` in the
 * service definition (required by launchd and Task Scheduler).
 * @throws {Error} when the script path is inside a temporary directory (e.g. bunx).
 */
export function getExecutableArgs(): string[] {
  const isBun = process.argv[0].endsWith("bun") || process.argv[0].endsWith("bun.exe");
  if (isBun) {
    if (isEphemeralPath(process.argv[1])) {
      throw new Error(
        "Executable is in a temporary directory. " +
          "Install the package globally first: bun install -g @chrisleekr/agentsync",
      );
    }
    return [process.argv[0], process.argv[1]];
  }
  return [process.execPath];
}

/**
 * Platform-specific service hooks used by the daemon management subcommands.
 * Each method maps to the corresponding OS service manager operation.
 */
interface PlatformInstaller {
  install(args: string[]): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isInstalled(): Promise<boolean>;
  isRegistered(): Promise<boolean>;
}

/** Load the installer implementation that matches the current operating system. */
async function getInstaller(): Promise<PlatformInstaller> {
  const platform = process.platform;
  if (platform === "darwin") {
    const m = await import("../daemon/installer-macos");
    return {
      install: m.installMacOs,
      uninstall: m.uninstallMacOs,
      start: m.startMacOs,
      stop: m.stopMacOs,
      isInstalled: m.isInstalledMacOs,
      isRegistered: m.isRegisteredMacOs,
    };
  }
  if (platform === "linux") {
    const m = await import("../daemon/installer-linux");
    return {
      install: m.installLinux,
      uninstall: m.uninstallLinux,
      start: m.startLinux,
      stop: m.stopLinux,
      isInstalled: m.isInstalledLinux,
      isRegistered: m.isRegisteredLinux,
    };
  }
  if (platform === "win32") {
    const m = await import("../daemon/installer-windows");
    return {
      install: m.installWindows,
      uninstall: m.uninstallWindows,
      start: m.startWindows,
      stop: m.stopWindows,
      isInstalled: m.isInstalledWindows,
      isRegistered: m.isInstalledWindows,
    };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/** Expose daemon lifecycle commands and the hidden worker entry point. */
export const daemonCommand = defineCommand({
  meta: {
    name: "daemon",
    description: "Manage the background daemon",
  },
  subCommands: {
    // Hidden internal subcommand — called by the system service
    _run: defineCommand({
      meta: { description: "Run the daemon process (internal)" },
      async run() {
        const { startDaemon } = await import("../daemon/index");
        await startDaemon();
      },
    }),

    install: defineCommand({
      meta: { description: "Install and start the daemon as a system service" },
      async run() {
        const installer = await getInstaller();
        const args = getExecutableArgs();
        await installer.install(args);
      },
    }),

    start: defineCommand({
      meta: { description: "Start the daemon service" },
      async run() {
        const installer = await getInstaller();
        if (!(await installer.isRegistered())) {
          log.error("Service not bootstrapped — run `agentsync daemon install` first.");
          process.exitCode = 1;
          return;
        }
        await installer.start();
        log.success("Daemon started.");
      },
    }),

    stop: defineCommand({
      meta: { description: "Stop the daemon service" },
      async run() {
        const installer = await getInstaller();
        await installer.stop();
        log.success("Daemon stopped.");
      },
    }),

    status: defineCommand({
      meta: { description: "Show daemon status via IPC" },
      async run() {
        const client = new IpcClient();
        try {
          const response = await client.send("status", {}, resolveDaemonSocketPath());
          if (response.ok) {
            const parsed = DaemonStatusSchema.safeParse(response.data);
            const pid = parsed.success ? parsed.data.pid : (response.data as { pid: number }).pid;
            const failures = parsed.success ? parsed.data.consecutiveFailures : 0;
            const lastErr = parsed.success ? parsed.data.lastError : null;
            log.success(`Daemon is running (pid: ${pid})`);
            if (failures > 0) {
              log.warn(`Consecutive failures: ${failures}. Last error: ${lastErr ?? "unknown"}`);
            }
          } else {
            log.error(`Daemon error: ${response.error}`);
            process.exitCode = 1;
          }
        } catch {
          log.error("Daemon is not running.");
          process.exitCode = 1;
        }
      },
    }),

    uninstall: defineCommand({
      meta: { description: "Stop and remove the daemon service" },
      async run() {
        const installer = await getInstaller();
        await installer.uninstall();
      },
    }),
  },
});
