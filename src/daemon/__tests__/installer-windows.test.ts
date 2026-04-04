/**
 * T047 — installer-windows: installWindows, uninstallWindows, startWindows, stopWindows,
 * isInstalledWindows
 *
 * Strategy
 * --------
 * installWindows uses process.env.TEMP (evaluated at call time, not baked), so we can
 * set it freely. All schtasks calls are captured via a mocked node:child_process.
 * node:fs/promises is mocked in-memory so no real files are written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const fsWrites = new Map<string, string>();
const fsRms = new Set<string>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];

// isInstalledWindows checks schtasks /Query exit code; simulate it via the mock.
// We use a flag to control the success/failure of /Query calls.
let queryExitCode = 0; // 0 = installed, non-zero = not installed

mock.module("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execFileCalls.push({ cmd, args });
    if (cmd === "schtasks" && args[0] === "/Query") {
      if (queryExitCode !== 0) {
        callback(new Error("schtasks query failed"), "", "ERROR: task not found");
        return;
      }
    }
    callback(null, "", "");
  },
}));

mock.module("node:fs/promises", () => ({
  writeFile: async (path: string, content: string | Uint8Array) => {
    fsWrites.set(
      path,
      typeof content === "string"
        ? content
        : Buffer.from(content as Uint8Array).toString("utf16le"),
    );
  },
  rm: async (path: string) => {
    fsRms.add(path);
  },
}));

mock.module("@clack/prompts", () => ({
  log: { success: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

type WindowsInstallerModule = typeof import("../installer-windows");
let m: WindowsInstallerModule;

const originalTemp = process.env.TEMP;

beforeAll(async () => {
  process.env.TEMP = "/tmp/agent-sync-test";
  m = await import("../installer-windows");
});

// Restore mocked modules after this file completes so they do not bleed into
// subsequent test files (e.g. integration.test.ts) that need the real node:fs/promises.
afterAll(() => {
  process.env.TEMP = originalTemp;
  mock.restore();
});

beforeEach(() => {
  fsWrites.clear();
  fsRms.clear();
  execFileCalls.length = 0;
  queryExitCode = 0;
});

describe("installWindows", () => {
  test("writes a task XML file containing the executable path", async () => {
    await m.installWindows("C:\\Program Files\\agentsync.exe");

    // A temporary XML file must have been written.
    const xmlEntry = [...fsWrites.entries()].find(([p]) => p.endsWith(".xml"));
    expect(xmlEntry).toBeDefined();
    if (!xmlEntry) return;
    const [, content] = xmlEntry;
    expect(content).toContain("agentsync.exe");
    expect(content).toContain("AgentSync daemon");
  });

  test("calls schtasks /Create with the task name", async () => {
    await m.installWindows("C:\\Program Files\\agentsync.exe");

    const createCall = execFileCalls.find((c) => c.cmd === "schtasks" && c.args[0] === "/Create");
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain("AgentSync");
  });

  test("calls schtasks /Run after creating the task", async () => {
    await m.installWindows("C:\\Program Files\\agentsync.exe");

    const runCall = execFileCalls.find((c) => c.cmd === "schtasks" && c.args[0] === "/Run");
    expect(runCall).toBeDefined();
    expect(runCall?.args).toContain("AgentSync");
  });

  test("removes the temporary XML file after creating the task", async () => {
    await m.installWindows("C:\\Program Files\\agentsync.exe");

    const xmlEntry = [...fsRms].find((p) => p.endsWith(".xml"));
    expect(xmlEntry).toBeDefined();
  });
});

describe("uninstallWindows", () => {
  test("calls schtasks /Delete /F with the task name", async () => {
    await m.uninstallWindows();

    const deleteCall = execFileCalls.find((c) => c.cmd === "schtasks" && c.args[0] === "/Delete");
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.args).toContain("AgentSync");
    expect(deleteCall?.args).toContain("/F");
  });
});

describe("startWindows / stopWindows", () => {
  test("startWindows calls schtasks /Run with the task name", async () => {
    await m.startWindows();
    const runCall = execFileCalls.find((c) => c.cmd === "schtasks" && c.args[0] === "/Run");
    expect(runCall).toBeDefined();
    expect(runCall?.args).toContain("AgentSync");
  });

  test("stopWindows calls schtasks /End with the task name", async () => {
    await m.stopWindows();
    const endCall = execFileCalls.find((c) => c.cmd === "schtasks" && c.args[0] === "/End");
    expect(endCall).toBeDefined();
    expect(endCall?.args).toContain("AgentSync");
  });
});

describe("isInstalledWindows", () => {
  test("returns true when schtasks /Query succeeds", async () => {
    queryExitCode = 0;
    expect(await m.isInstalledWindows()).toBe(true);
  });

  test("returns false when schtasks /Query fails", async () => {
    queryExitCode = 1;
    expect(await m.isInstalledWindows()).toBe(false);
  });
});
