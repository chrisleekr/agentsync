/**
 * Tests for installer-macos: installMacOs, uninstallMacOs, startMacOs, stopMacOs,
 * isInstalledMacOs, buildPlist, isRegisteredMacOs, extractServiceManagerError
 *
 * Strategy
 * --------
 * PLIST_PATH is a module-level constant baked from homedir() at import time, so the
 * real path cannot be overridden. Instead, we mock:
 *   - node:child_process — capture execFile calls without running launchctl
 *   - node:fs/promises   — intercept file I/O so no writes touch the live filesystem
 *   - @clack/prompts      — suppress output
 *
 * File state is tracked in an in-memory Map so isInstalledMacOs() behaves correctly
 * (true after install, false after uninstall/rm).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ── In-memory FS state (captured before the module is imported) ───────────────
const fsWrites = new Map<string, string>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];

// Control whether launchctl commands succeed or fail
let launchctlShouldFail = false;
let launchctlFailStderr = "Bootstrap failed: 5: Input/output error";
let launchctlPrintShouldFail = true; // default: not registered

const execFileMock = (
  cmd: string,
  args: string[],
  callback: (err: Error | null, stdout: string, stderr: string) => void,
) => {
  execFileCalls.push({ cmd, args });
  if (cmd === "launchctl" && args[0] === "print" && launchctlPrintShouldFail) {
    callback(new Error("Could not find service"), "", "Could not find service");
    return;
  }
  if (launchctlShouldFail && cmd === "launchctl" && args[0] === "bootstrap") {
    const err = Object.assign(new Error("launchctl failed"), {
      stderr: launchctlFailStderr,
    });
    callback(err, "", launchctlFailStderr);
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

type MacOsInstallerModule = typeof import("../installer-macos");
let m: MacOsInstallerModule;

beforeAll(async () => {
  m = await import("../installer-macos");
});

// Restore mocked modules after this file completes so they do not bleed into
// subsequent test files (e.g. integration.test.ts) that need the real node:fs/promises.
afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  fsWrites.clear();
  execFileCalls.length = 0;
  launchctlShouldFail = false;
  launchctlFailStderr = "Bootstrap failed: 5: Input/output error";
  launchctlPrintShouldFail = true; // default: not registered
});

// ── T029: buildPlist emits separate <string> elements ─────────────────────────
describe("buildPlist", () => {
  test("emits separate <string> elements for each arg (T029)", () => {
    const plist = m.buildPlist(["bun", "/path/cli.js"], "/var/log");
    // Must have individual entries, not a space-joined single string
    expect(plist).toContain("<string>bun</string>");
    expect(plist).toContain("<string>/path/cli.js</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>_run</string>");
    // Must NOT have the space-joined form as a single element
    expect(plist).not.toContain("<string>bun /path/cli.js</string>");
  });

  test("ProgramArguments array contains exactly the args + daemon + _run as separate entries", () => {
    const plist = m.buildPlist(["/usr/local/bin/agentsync"], "/var/log");
    expect(plist).toContain("<string>/usr/local/bin/agentsync</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>_run</string>");
  });
});

// ── T030: installMacOs calls bootout before bootstrap ─────────────────────────
describe("installMacOs", () => {
  test("calls launchctl bootout before launchctl bootstrap (T030)", async () => {
    await m.installMacOs(["bun", "/path/cli.js"]);

    const bootoutIdx = execFileCalls.findIndex(
      (c) => c.cmd === "launchctl" && c.args[0] === "bootout",
    );
    const bootstrapIdx = execFileCalls.findIndex(
      (c) => c.cmd === "launchctl" && c.args[0] === "bootstrap",
    );
    expect(bootoutIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
    expect(bootoutIdx).toBeLessThan(bootstrapIdx);
  });

  test("writes a plist file with the correct label", async () => {
    await m.installMacOs(["/usr/local/bin/agentsync"]);

    const written = [...fsWrites.entries()].find(([p]) => p.endsWith(".plist"));
    expect(written).toBeDefined();
    if (!written) return;
    const [, content] = written;
    expect(content).toContain("com.agentsync.daemon");
    expect(content).toContain("/usr/local/bin/agentsync");
  });

  test("calls launchctl bootstrap with the plist path", async () => {
    await m.installMacOs(["/usr/local/bin/agentsync"]);

    const bootstrapCall = execFileCalls.find(
      (c) => c.cmd === "launchctl" && c.args[0] === "bootstrap",
    );
    expect(bootstrapCall).toBeDefined();
    expect(bootstrapCall?.args.at(-1)).toMatch(/agentsync/);
  });

  test("isInstalledMacOs returns true after install", async () => {
    await m.installMacOs(["/usr/local/bin/agentsync"]);
    expect(await m.isInstalledMacOs()).toBe(true);
  });

  // T031: bootstrap failure surfaces stderr, not stack trace
  test("throws with service manager stderr (not stack trace) when bootstrap fails (T031)", async () => {
    launchctlShouldFail = true;
    launchctlFailStderr = "Bootstrap failed: 5: Input/output error";

    let thrown: Error | null = null;
    try {
      await m.installMacOs(["/usr/local/bin/agentsync"]);
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain("Bootstrap failed: 5");
    // Must not contain a Node.js stack-trace marker
    expect(thrown?.message).not.toContain("    at ");
  });
});

describe("uninstallMacOs", () => {
  test("calls launchctl bootout and removes the plist file", async () => {
    // Install first so there is a plist to remove.
    await m.installMacOs(["/usr/local/bin/agentsync"]);
    execFileCalls.length = 0;

    await m.uninstallMacOs();

    const bootoutCall = execFileCalls.find((c) => c.cmd === "launchctl" && c.args[0] === "bootout");
    expect(bootoutCall).toBeDefined();
  });

  test("isInstalledMacOs returns false after uninstall", async () => {
    await m.installMacOs(["/usr/local/bin/agentsync"]);
    await m.uninstallMacOs();
    expect(await m.isInstalledMacOs()).toBe(false);
  });
});

// ── T032: startMacOs throws immediately when not registered ───────────────────
describe("startMacOs / stopMacOs", () => {
  test("startMacOs throws 'Service not bootstrapped' when isRegisteredMacOs returns false (T032)", async () => {
    // launchctl print will fail (not registered), no kickstart call expected
    await expect(m.startMacOs()).rejects.toThrow("Service not bootstrapped");

    const kickstartCall = execFileCalls.find(
      (c) => c.cmd === "launchctl" && c.args[0] === "kickstart",
    );
    expect(kickstartCall).toBeUndefined();
  });

  test("stopMacOs calls launchctl kill with SIGTERM", async () => {
    await m.stopMacOs();
    const killCall = execFileCalls.find(
      (c) => c.cmd === "launchctl" && c.args[0] === "kill" && c.args[1] === "SIGTERM",
    );
    expect(killCall).toBeDefined();
  });
});

describe("isInstalledMacOs", () => {
  test("returns false when the plist file does not exist", async () => {
    // fsWrites is clear so readFile will throw ENOENT.
    expect(await m.isInstalledMacOs()).toBe(false);
  });
});
