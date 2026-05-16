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
import { createRequire } from "node:module";

const fsWrites = new Map<string, string>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let lastExecFileOpts: Record<string, unknown> | undefined;

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
  ...fnArgs: unknown[]
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const cmd = fnArgs[0] as string;
    const args = fnArgs[1] as string[];
    if (fnArgs.length > 2 && typeof fnArgs[2] === "object" && fnArgs[2] !== null) {
      lastExecFileOpts = fnArgs[2] as Record<string, unknown>;
    }
    execFileMock(cmd, args, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

// Spread the real module so `spawnSync` and every other export survive the
// mock — a bare `() => ({ execFile })` would replace the module in bun's
// cache with a 1-key object, and later test files in the run that do
// `import { spawnSync } from "node:child_process"` would fail to load with
// `SyntaxError: Export named 'spawnSync' not found`. See PR #26 for the
// cross-file bleed this guards against.
const actualChildProcess = require("node:child_process") as typeof import("node:child_process");
mock.module("node:child_process", () => ({
  ...actualChildProcess,
  execFile: execFileMock,
}));

// Spread the real fs/promises so unrelated exports (stat, readdir, etc.)
// remain available to modules loaded in other test files that share Bun's
// module cache during a multi-file run. Without this, the mock returns a
// 4-key object and any subsequent `import { stat } from "node:fs/promises"`
// (e.g. from src/commands/destroy.test.ts) errors with
// `Export named 'stat' not found`.
const actualFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
mock.module("node:fs/promises", () => ({
  ...actualFsPromises,
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
  // Bust the require cache so the module's top-level imports re-bind
  // to THIS file's fs/promises + child_process mocks instead of stale
  // closures left over from another suite. Bun's mock.module() does not
  // invalidate the import cache on its own.
  const req = createRequire(import.meta.url);
  try {
    const resolved = req.resolve("../installer-linux");
    delete req.cache?.[resolved];
  } catch {
    // ignore — first run, nothing to invalidate
  }
  m = await import("../installer-linux");
});

afterAll(() => {
  // Re-mock back to the real implementations BEFORE mock.restore() so any
  // test file loaded later in the same Bun run sees an unmocked fs/promises.
  // mock.restore() alone leaves the cached fs/promises pointing at our
  // override, which breaks unrelated tests that call readFile/stat
  // (e.g. destroy.test.ts going through loadConfig).
  mock.module("node:fs/promises", () => actualFsPromises);
  mock.module("node:child_process", () => actualChildProcess);
  mock.restore();
});

beforeEach(() => {
  fsWrites.clear();
  execFileCalls.length = 0;
  isEnabledStdout = "";
  isEnabledShouldFail = false;
  lastExecFileOpts = undefined;
});

// buildUnit emits correct ExecStart
describe("buildUnit", () => {
  test("produces ExecStart with each arg quoted plus daemon _run", () => {
    const unit = m.buildUnit(["bun", "/path/cli.js"]);
    expect(unit).toContain('ExecStart="bun" "/path/cli.js" "daemon" "_run"');
  });

  test("single-element args produce correct ExecStart", () => {
    const unit = m.buildUnit(["/usr/local/bin/agentsync"]);
    expect(unit).toContain('ExecStart="/usr/local/bin/agentsync" "daemon" "_run"');
  });

  // args containing spaces are quoted per systemd.syntax(7)
  test("args containing spaces are quoted for systemd", () => {
    const unit = m.buildUnit(["bun", "/home/user/My Program/cli.js"]);
    expect(unit).toContain('"bun"');
    expect(unit).toContain('"/home/user/My Program/cli.js"');
    expect(unit).toContain('"daemon"');
    expect(unit).toContain('"_run"');
  });

  test("args containing backslashes and quotes are C-style escaped", () => {
    const unit = m.buildUnit(['/path/with"quote', "/path/with\\backslash"]);
    expect(unit).toContain('"/path/with\\"quote"');
    expect(unit).toContain('"/path/with\\\\backslash"');
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

  // startLinux passes AbortSignal to execFileAsync
  test("startLinux passes signal option to execFileAsync for start", async () => {
    isEnabledStdout = "enabled\n";
    await m.startLinux();

    const startCall = execFileCalls.find((c) => c.cmd === "systemctl" && c.args.includes("start"));
    expect(startCall).toBeDefined();
    expect(lastExecFileOpts).toBeDefined();
    expect(lastExecFileOpts?.signal).toBeInstanceOf(AbortSignal);
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
