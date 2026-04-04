/**
 * T045 — installer-macos: installMacOs, uninstallMacOs, startMacOs, stopMacOs, isInstalledMacOs
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
});

describe("installMacOs", () => {
  test("writes a plist file with the correct label", async () => {
    await m.installMacOs("/usr/local/bin/agentsync");

    const written = [...fsWrites.entries()].find(([p]) => p.endsWith(".plist"));
    expect(written).toBeDefined();
    if (!written) return;
    const [, content] = written;
    expect(content).toContain("com.agentsync.daemon");
    expect(content).toContain("/usr/local/bin/agentsync");
  });

  test("calls launchctl bootstrap with the plist path", async () => {
    await m.installMacOs("/usr/local/bin/agentsync");

    const bootstrapCall = execFileCalls.find(
      (c) => c.cmd === "launchctl" && c.args[0] === "bootstrap",
    );
    expect(bootstrapCall).toBeDefined();
    expect(bootstrapCall?.args.at(-1)).toMatch(/agentsync/);
  });

  test("isInstalledMacOs returns true after install", async () => {
    await m.installMacOs("/usr/local/bin/agentsync");
    expect(await m.isInstalledMacOs()).toBe(true);
  });
});

describe("uninstallMacOs", () => {
  test("calls launchctl bootout and removes the plist file", async () => {
    // Install first so there is a plist to remove.
    await m.installMacOs("/usr/local/bin/agentsync");
    execFileCalls.length = 0;

    await m.uninstallMacOs();

    const bootoutCall = execFileCalls.find((c) => c.cmd === "launchctl" && c.args[0] === "bootout");
    expect(bootoutCall).toBeDefined();
  });

  test("isInstalledMacOs returns false after uninstall", async () => {
    await m.installMacOs("/usr/local/bin/agentsync");
    await m.uninstallMacOs();
    expect(await m.isInstalledMacOs()).toBe(false);
  });
});

describe("startMacOs / stopMacOs", () => {
  test("startMacOs calls launchctl kickstart", async () => {
    await m.startMacOs();
    const kickstartCall = execFileCalls.find(
      (c) => c.cmd === "launchctl" && c.args[0] === "kickstart",
    );
    expect(kickstartCall).toBeDefined();
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
