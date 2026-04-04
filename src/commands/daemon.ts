import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { resolveDaemonSocketPath } from "../config/paths";
import { IpcClient } from "../core/ipc";

function getExecutablePath(): string {
  // When compiled: process.execPath; during dev with `bun run src/cli.ts`: reconstruct
  if (process.argv[0].endsWith("bun") || process.argv[0].endsWith("bun.exe")) {
    return `${process.argv[0]} ${process.argv[1]}`;
  }
  return process.execPath;
}

interface PlatformInstaller {
  install(exe: string): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  isInstalled(): Promise<boolean>;
}

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
    };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

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
        const exe = getExecutablePath();
        await installer.install(exe);
      },
    }),

    start: defineCommand({
      meta: { description: "Start the daemon service" },
      async run() {
        const installer = await getInstaller();
        if (!(await installer.isInstalled())) {
          log.error("Daemon not installed. Run: agentsync daemon install");
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
            log.success(`Daemon is running (pid: ${(response.data as { pid: number }).pid})`);
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
