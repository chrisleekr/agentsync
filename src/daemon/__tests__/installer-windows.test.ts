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
let lastExecFileOpts: Record<string, unknown> | undefined;

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
  lastExecFileOpts = undefined;
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

  // T065: args with spaces are quoted for Windows command-line parsing
  test("args containing spaces are double-quoted in <Arguments> (T065)", () => {
    const xml = m.buildXml(["bun", "C:\\Program Files\\cli.js"]);
    expect(xml).toContain("<Command>bun</Command>");
    // The script path should be quoted because it contains a space
    expect(xml).toContain('"C:\\Program Files\\cli.js"');
    expect(xml).toContain("daemon _run");
  });

  test("args containing double quotes are escaped with backslash (T065)", () => {
    const xml = m.buildXml(["bun", '/path/with"quote']);
    const args = xml.match(/<Arguments>(.*?)<\/Arguments>/)?.[1] ?? "";
    expect(args).toContain('\\"');
  });

  // T074a: trailing backslashes are doubled per CommandLineToArgvW
  test("args with trailing backslash have it doubled inside quotes (T074a)", () => {
    const xml = m.buildXml(["bun", "C:\\path\\"]);
    const args = xml.match(/<Arguments>(.*?)<\/Arguments>/)?.[1] ?? "";
    // Trailing \ before closing " must be doubled: "C:\path\\" → Windows sees C:\path\
    expect(args).toContain('"C:\\path\\\\"');
  });

  // T074a: backslashes before quotes are doubled
  test("backslashes immediately before a quote are doubled (T074a)", () => {
    const xml = m.buildXml(["bun", 'C:\\path\\"name']);
    const args = xml.match(/<Arguments>(.*?)<\/Arguments>/)?.[1] ?? "";
    // The \" sequence: backslash must be doubled so Windows sees literal \ + literal "
    expect(args).toContain('\\\\\\"');
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

  // T071: startWindows passes AbortSignal to execFileAsync
  test("startWindows passes signal option to execFileAsync for /Run (T071)", async () => {
    queryExitCode = 0; // installed
    await m.startWindows();

    const runCall = execFileCalls.find((c) => c.cmd === "schtasks" && c.args[0] === "/Run");
    expect(runCall).toBeDefined();
    expect(lastExecFileOpts).toBeDefined();
    expect(lastExecFileOpts?.signal).toBeInstanceOf(AbortSignal);
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
