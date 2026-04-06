/**
 * Tests for installer-linux: installLinux, uninstallLinux, startLinux, stopLinux,
 * isInstalledLinux, buildUnit, isRegisteredLinux
 *
 * Strategy
 * --------
 * SERVICE_PATH is baked from homedir() at module import time. Same approach as the
 * macOS tests: mock node:child_process + node:fs/promises before importing the module.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const fsWrites = new Map<string, string>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];

// Control is-enabled output for isRegisteredLinux tests
let isEnabledStdout = "";
let isEnabledShouldFail = false;

// Build the execFile mock with custom promisify support so that
// `promisify(execFile)` returns { stdout, stderr } rather than just stdout.
const execFileMock = (
  cmd: string,
  args: string[],
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => {
  execFileCalls.push({ cmd, args });
  if (cmd === "systemctl" && args.includes("is-enabled")) {
    if (isEnabledShouldFail) {
      callback(new Error("not enabled"), "", "");
      return;
    }
    callback(null, isEnabledStdout, "");
    return;
  }
  callback(null, "", "");
};

const { promisify } = require("node:util") as typeof import("node:util");
(execFileMock as unknown as Record<symbol, unknown>)[promisify.custom] = (
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFileMock(cmd, args, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

mock.module("node:child_process", () => ({
  execFile: execFileMock,
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

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  fsWrites.clear();
  execFileCalls.length = 0;
  isEnabledStdout = "";
  isEnabledShouldFail = false;
});

// T034: buildUnit emits correct ExecStart
describe("buildUnit", () => {
  test("produces ExecStart with each arg joined by space plus daemon _run (T034)", () => {
    const unit = m.buildUnit(["bun", "/path/cli.js"]);
    expect(unit).toContain("ExecStart=bun /path/cli.js daemon _run");
  });

  test("single-element args produce correct ExecStart", () => {
    const unit = m.buildUnit(["/usr/local/bin/agentsync"]);
    expect(unit).toContain("ExecStart=/usr/local/bin/agentsync daemon _run");
  });
});

describe("installLinux", () => {
  test("writes a systemd unit file with the correct service name", async () => {
    await m.installLinux(["/usr/local/bin/agentsync"]);

    const written = [...fsWrites.entries()].find(([p]) => p.endsWith(".service"));
    expect(written).toBeDefined();
    if (!written) return;
    const [, content] = written;
    expect(content).toContain("AgentSync daemon");
    expect(content).toContain("/usr/local/bin/agentsync");
  });

  test("calls systemctl daemon-reload and enable --now", async () => {
    await m.installLinux(["/usr/local/bin/agentsync"]);

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
    await m.installLinux(["/usr/local/bin/agentsync"]);
    expect(await m.isInstalledLinux()).toBe(true);
  });
});

describe("uninstallLinux", () => {
  test("calls systemctl disable --now and daemon-reload", async () => {
    await m.installLinux(["/usr/local/bin/agentsync"]);
    execFileCalls.length = 0;

    await m.uninstallLinux();

    const disableNow = execFileCalls.find(
      (c) => c.cmd === "systemctl" && c.args.includes("disable") && c.args.includes("--now"),
    );
    expect(disableNow).toBeDefined();
  });

  test("isInstalledLinux returns false after uninstall", async () => {
    await m.installLinux(["/usr/local/bin/agentsync"]);
    await m.uninstallLinux();
    expect(await m.isInstalledLinux()).toBe(false);
  });
});

describe("startLinux / stopLinux", () => {
  test("startLinux throws when not registered", async () => {
    isEnabledShouldFail = true;
    await expect(m.startLinux()).rejects.toThrow("Service not bootstrapped");
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

describe("isRegisteredLinux", () => {
  test("returns true when systemctl is-enabled outputs 'enabled'", async () => {
    isEnabledStdout = "enabled\n";
    expect(await m.isRegisteredLinux()).toBe(true);
  });

  test("returns false when systemctl is-enabled outputs anything else", async () => {
    isEnabledStdout = "disabled\n";
    expect(await m.isRegisteredLinux()).toBe(false);
  });

  test("returns false when systemctl is-enabled fails", async () => {
    isEnabledShouldFail = true;
    expect(await m.isRegisteredLinux()).toBe(false);
  });
});
