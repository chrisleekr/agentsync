/**
 * Tests for installer-windows: installWindows, uninstallWindows, startWindows, stopWindows,
 * isInstalledWindows, buildXml
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
let queryExitCode = 0; // 0 = installed, non-zero = not installed

const execFileMock = (
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

// T033: buildXml puts args[0] in <Command>, rest + daemon _run in <Arguments>
describe("buildXml", () => {
  test("<Command> holds only the binary, <Arguments> holds script + daemon _run (T033)", () => {
    const xml = m.buildXml(["bun", "/path/cli.js"]);
    expect(xml).toContain("<Command>bun</Command>");
    expect(xml).toContain("<Arguments>/path/cli.js daemon _run</Arguments>");
  });

  test("single-element args put binary in <Command> and 'daemon _run' in <Arguments>", () => {
    const xml = m.buildXml(["C:\\agentsync.exe"]);
    // & is XML-escaped
    expect(xml).toContain("<Command>C:\\agentsync.exe</Command>");
    expect(xml).toContain("<Arguments>daemon _run</Arguments>");
  });
});

describe("installWindows", () => {
  test("writes a task XML file containing the executable path", async () => {
    await m.installWindows(["C:\\Program Files\\agentsync.exe"]);

    const xmlEntry = [...fsWrites.entries()].find(([p]) => p.endsWith(".xml"));
    expect(xmlEntry).toBeDefined();
    if (!xmlEntry) return;
    const [, content] = xmlEntry;
    expect(content).toContain("agentsync.exe");
    expect(content).toContain("AgentSync daemon");
  });

  test("calls schtasks /Create with the task name", async () => {
    await m.installWindows(["C:\\Program Files\\agentsync.exe"]);

    const createCall = execFileCalls.find((c) => c.cmd === "schtasks" && c.args[0] === "/Create");
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain("AgentSync");
  });

  test("calls schtasks /Run after creating the task", async () => {
    await m.installWindows(["C:\\Program Files\\agentsync.exe"]);

    const runCall = execFileCalls.find((c) => c.cmd === "schtasks" && c.args[0] === "/Run");
    expect(runCall).toBeDefined();
    expect(runCall?.args).toContain("AgentSync");
  });

  test("removes the temporary XML file after creating the task", async () => {
    await m.installWindows(["C:\\Program Files\\agentsync.exe"]);

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
  test("startWindows throws when not registered", async () => {
    queryExitCode = 1;
    await expect(m.startWindows()).rejects.toThrow("Service not bootstrapped");
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
