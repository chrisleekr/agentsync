/**
 * Tests for src/commands/daemon.ts
 *
 * Covers getExecutableArgs() and the daemon subcommands (install, start, stop, status, uninstall).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { log } from "@clack/prompts";
import { IpcClient } from "../../core/ipc";

// ── getExecutableArgs tests ────────────────────────────────────────────────────

const originalArgv0 = process.argv[0];
const originalArgv1 = process.argv[1];

function withArgv(argv0: string, argv1: string, fn: () => void | Promise<void>) {
  return async () => {
    Object.defineProperty(process, "argv", {
      value: [argv0, argv1, ...process.argv.slice(2)],
      writable: true,
      configurable: true,
    });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, "argv", {
        value: [originalArgv0, originalArgv1, ...process.argv.slice(2)],
        writable: true,
        configurable: true,
      });
    }
  };
}

describe("getExecutableArgs", () => {
  test(
    "returns [process.execPath] when argv[0] is not bun",
    withArgv("/usr/local/bin/agentsync", "/irrelevant/path", async () => {
      const { getExecutableArgs } = await import("../daemon");
      const result = getExecutableArgs();
      expect(result).toEqual([process.execPath]);
    }),
  );

  test(
    "returns [argv[0], argv[1]] when argv[0] ends with 'bun' and path is non-ephemeral",
    withArgv(
      "/home/user/.bun/bin/bun",
      "/home/user/.bun/install/global/node_modules/.bin/cli.js",
      async () => {
        const { getExecutableArgs } = await import("../daemon");
        const result = getExecutableArgs();
        expect(result).toEqual([
          "/home/user/.bun/bin/bun",
          "/home/user/.bun/install/global/node_modules/.bin/cli.js",
        ]);
      },
    ),
  );

  test(
    "throws with install hint when argv[1] contains 'bunx-'",
    withArgv("/home/user/.bun/bin/bun", "/tmp/bunx-501-abc/node_modules/.bin/cli.js", async () => {
      const { getExecutableArgs } = await import("../daemon");
      expect(() => getExecutableArgs()).toThrow("Install the package globally first");
    }),
  );
});

// ── Daemon subcommand tests ────────────────────────────────────────────────────

// Mock installer functions — we don't want to actually call launchctl/systemctl
const mockInstall = mock(async (_args: string[]) => {});
const mockUninstall = mock(async () => {});
const mockStart = mock(async () => {});
const mockStop = mock(async () => {});
const mockIsInstalled = mock(async () => true);
const mockIsRegistered = mock(async () => true);

// Mock all platform installer modules so tests pass on any OS
mock.module("../../daemon/installer-macos", () => ({
  installMacOs: mockInstall,
  uninstallMacOs: mockUninstall,
  startMacOs: mockStart,
  stopMacOs: mockStop,
  isInstalledMacOs: mockIsInstalled,
  isRegisteredMacOs: mockIsRegistered,
}));

mock.module("../../daemon/installer-linux", () => ({
  installLinux: mockInstall,
  uninstallLinux: mockUninstall,
  startLinux: mockStart,
  stopLinux: mockStop,
  isInstalledLinux: mockIsInstalled,
  isRegisteredLinux: mockIsRegistered,
}));

mock.module("../../daemon/installer-windows", () => ({
  installWindows: mockInstall,
  uninstallWindows: mockUninstall,
  startWindows: mockStart,
  stopWindows: mockStop,
  isInstalledWindows: mockIsInstalled,
  isRegisteredWindows: mockIsRegistered,
}));

const successLogs: string[] = [];
const errorLogs: string[] = [];
const warnLogs: string[] = [];

let successSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let ipcClientSendSpy: ReturnType<typeof spyOn>;

beforeAll(() => {
  successSpy = spyOn(log, "success").mockImplementation((msg: string) => {
    successLogs.push(msg);
  });
  errorSpy = spyOn(log, "error").mockImplementation((msg: string) => {
    errorLogs.push(msg);
  });
  warnSpy = spyOn(log, "warn").mockImplementation((msg: string) => {
    warnLogs.push(msg);
  });
  ipcClientSendSpy = spyOn(IpcClient.prototype, "send");
});

afterAll(() => {
  successSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  ipcClientSendSpy.mockRestore();
  mock.restore();
});

beforeEach(() => {
  successLogs.length = 0;
  errorLogs.length = 0;
  warnLogs.length = 0;
  mockInstall.mockClear();
  mockUninstall.mockClear();
  mockStart.mockClear();
  mockStop.mockClear();
  mockIsInstalled.mockClear();
  mockIsRegistered.mockClear();
  process.exitCode = undefined;
});

// Helper: resolve citty subcommands (may be Resolvable)
async function getSubCmd(name: string): Promise<{ run: () => Promise<void> }> {
  const { daemonCommand } = await import("../daemon");
  const subs = (await daemonCommand.subCommands) as Record<
    string,
    { run: () => Promise<void> } | undefined
  >;
  const cmd = subs[name];
  if (!cmd) throw new Error(`subcommand "${name}" not found`);
  return cmd;
}

describe("daemonCommand subcommands", () => {
  test("install subcommand calls installer.install with args array", async () => {
    const cmd = await getSubCmd("install");
    await cmd.run();

    expect(mockInstall).toHaveBeenCalledTimes(1);
    const callArgs = mockInstall.mock.calls[0][0];
    expect(Array.isArray(callArgs)).toBe(true);
  });

  test("start subcommand calls installer.start when registered", async () => {
    mockIsRegistered.mockResolvedValueOnce(true);
    const cmd = await getSubCmd("start");
    await cmd.run();

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(successLogs.some((m) => m.includes("Daemon started"))).toBe(true);
  });

  test("start subcommand errors when not registered", async () => {
    mockIsRegistered.mockResolvedValueOnce(false);
    const cmd = await getSubCmd("start");
    await cmd.run();

    expect(mockStart).not.toHaveBeenCalled();
    expect(errorLogs.some((m) => m.includes("not bootstrapped"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("stop subcommand calls installer.stop", async () => {
    const cmd = await getSubCmd("stop");
    await cmd.run();

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(successLogs.some((m) => m.includes("Daemon stopped"))).toBe(true);
  });

  test("uninstall subcommand calls installer.uninstall", async () => {
    const cmd = await getSubCmd("uninstall");
    await cmd.run();

    expect(mockUninstall).toHaveBeenCalledTimes(1);
  });

  test("status subcommand shows running daemon info", async () => {
    ipcClientSendSpy.mockResolvedValueOnce({
      id: "test",
      ok: true,
      data: { pid: 12345, consecutiveFailures: 0, lastError: null },
    });
    const cmd = await getSubCmd("status");
    await cmd.run();

    expect(successLogs.some((m) => m.includes("12345"))).toBe(true);
  });

  test("status subcommand shows failure info when consecutiveFailures > 0", async () => {
    ipcClientSendSpy.mockResolvedValueOnce({
      id: "test",
      ok: true,
      data: { pid: 12345, consecutiveFailures: 3, lastError: "[pull] remote not reachable" },
    });
    const cmd = await getSubCmd("status");
    await cmd.run();

    expect(warnLogs.some((m) => m.includes("3"))).toBe(true);
  });

  test("status subcommand shows 'not running' when IPC fails", async () => {
    ipcClientSendSpy.mockRejectedValueOnce(new Error("ENOENT"));
    const cmd = await getSubCmd("status");
    await cmd.run();

    expect(errorLogs.some((m) => m.includes("not running"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });

  test("status subcommand handles error response from daemon", async () => {
    ipcClientSendSpy.mockResolvedValueOnce({
      id: "test",
      ok: false,
      error: "internal error",
    });
    const cmd = await getSubCmd("status");
    await cmd.run();

    expect(errorLogs.some((m) => m.includes("internal error"))).toBe(true);
    expect(process.exitCode).toBe(1);
  });
});
