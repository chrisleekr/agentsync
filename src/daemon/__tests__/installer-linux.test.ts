/**
 * T046 — installer-linux: installLinux, uninstallLinux, startLinux, stopLinux, isInstalledLinux
 *
 * Strategy
 * --------
 * SERVICE_PATH is baked from homedir() at module import time. Same approach as the
 * macOS tests: mock node:child_process + node:fs/promises before importing the module.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const fsWrites = new Map<string, string>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];

mock.module("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execFileCalls.push({ cmd, args });
    callback(null, "", "");
  },
}));

mock.module("node:fs/promises", () => ({
  mkdir: async () => {},
  writeFile: async (path: string, content: string | Uint8Array) => {
    fsWrites.set(path, typeof content === "string" ? content : (content as Buffer).toString());
  },
  readFile: async (path: string) => {
    const content = fsWrites.get(path);
    if (content !== undefined) return content;
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: "ENOENT",
    });
  },
  rm: async (path: string) => {
    fsWrites.delete(path);
  },
}));

mock.module("@clack/prompts", () => ({
  log: { success: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

type LinuxInstallerModule = typeof import("../installer-linux");
let m: LinuxInstallerModule;

beforeAll(async () => {
  m = await import("../installer-linux");
});

// Restore mocked modules after this file completes so they do not bleed into
// subsequent test files (e.g. integration.test.ts) that need the real node:fs/promises.
afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  fsWrites.clear();
  execFileCalls.length = 0;
});

describe("installLinux", () => {
  test("writes a systemd unit file with the correct service name", async () => {
    await m.installLinux("/usr/local/bin/agentsync");

    const written = [...fsWrites.entries()].find(([p]) => p.endsWith(".service"));
    expect(written).toBeDefined();
    if (!written) return;
    const [, content] = written;
    expect(content).toContain("AgentSync daemon");
    expect(content).toContain("/usr/local/bin/agentsync");
  });

  test("calls systemctl daemon-reload and enable --now", async () => {
    await m.installLinux("/usr/local/bin/agentsync");

    const daemonReload = execFileCalls.find(
      (c) => c.cmd === "systemctl" && c.args.includes("daemon-reload"),
    );
    const enableNow = execFileCalls.find(
      (c) => c.cmd === "systemctl" && c.args.includes("enable") && c.args.includes("--now"),
    );
    expect(daemonReload).toBeDefined();
    expect(enableNow).toBeDefined();
  });

  test("isInstalledLinux returns true after install", async () => {
    await m.installLinux("/usr/local/bin/agentsync");
    expect(await m.isInstalledLinux()).toBe(true);
  });
});

describe("uninstallLinux", () => {
  test("calls systemctl disable --now and daemon-reload", async () => {
    await m.installLinux("/usr/local/bin/agentsync");
    execFileCalls.length = 0;

    await m.uninstallLinux();

    const disableNow = execFileCalls.find(
      (c) => c.cmd === "systemctl" && c.args.includes("disable") && c.args.includes("--now"),
    );
    expect(disableNow).toBeDefined();
  });

  test("isInstalledLinux returns false after uninstall", async () => {
    await m.installLinux("/usr/local/bin/agentsync");
    await m.uninstallLinux();
    expect(await m.isInstalledLinux()).toBe(false);
  });
});

describe("startLinux / stopLinux", () => {
  test("startLinux calls systemctl start <service>", async () => {
    await m.startLinux();
    const startCall = execFileCalls.find((c) => c.cmd === "systemctl" && c.args.includes("start"));
    expect(startCall).toBeDefined();
    expect(startCall?.args).toContain("agentsync");
  });

  test("stopLinux calls systemctl stop <service>", async () => {
    await m.stopLinux();
    const stopCall = execFileCalls.find((c) => c.cmd === "systemctl" && c.args.includes("stop"));
    expect(stopCall).toBeDefined();
    expect(stopCall?.args).toContain("agentsync");
  });
});

describe("isInstalledLinux", () => {
  test("returns false when the service file does not exist", async () => {
    expect(await m.isInstalledLinux()).toBe(false);
  });
});
