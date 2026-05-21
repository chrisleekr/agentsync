/**
 * Tests for installer-windows: installWindows, uninstallWindows, startWindows, stopWindows,
 * isInstalledWindows, buildXml
 *
 * Strategy
 * --------
 * Inject fs + exec stubs through the installer's globalThis-backed slot
 * (`__setInstallerWindowsImplForTests`). Bypasses Bun's mock.module()
 * entirely so daemon.test.ts's installer overrides cannot bleed in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

const fsWrites = new Map<string, string>();
const fsRms = new Set<string>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let lastExecFileOpts: { signal?: AbortSignal } | undefined;

let queryExitCode = 0;

const fsStub = {
  writeFile: (async (path: string, content: string | Uint8Array) => {
    fsWrites.set(
      path,
      typeof content === "string"
        ? content
        : Buffer.from(content as Uint8Array).toString("utf16le"),
    );
  }) as unknown as typeof import("node:fs/promises").writeFile,
  rm: (async (path: string) => {
    fsRms.add(path);
  }) as unknown as typeof import("node:fs/promises").rm,
};

const execStub = async (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> => {
  execFileCalls.push({ cmd, args });
  if (opts) lastExecFileOpts = opts;
  if (cmd === "schtasks" && args[0] === "/Query" && queryExitCode !== 0) {
    throw Object.assign(new Error("schtasks query failed"), {
      stderr: "ERROR: task not found",
    });
  }
  return { stdout: "", stderr: "" };
};

type WindowsInstallerModule = typeof import("../installer-windows");
let m: WindowsInstallerModule;

const originalTemp = process.env.TEMP;

beforeAll(async () => {
  process.env.TEMP = "/tmp/agent-sync-test";
  m = await import("../installer-windows");
  m.__setInstallerWindowsImplForTests({ fs: fsStub, exec: execStub });
});

afterAll(() => {
  process.env.TEMP = originalTemp;
  m.__setInstallerWindowsImplForTests({ fs: null, exec: null });
});

beforeEach(() => {
  fsWrites.clear();
  fsRms.clear();
  execFileCalls.length = 0;
  queryExitCode = 0;
  lastExecFileOpts = undefined;
});

// buildXml puts args[0] in <Command>, rest + daemon _run in <Arguments>
describe("buildXml", () => {
  test("<Command> holds only the binary, <Arguments> holds script + daemon _run", () => {
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

  // args with spaces are quoted for Windows command-line parsing
  test("args containing spaces are double-quoted in <Arguments>", () => {
    const xml = m.buildXml(["bun", "C:\\Program Files\\cli.js"]);
    expect(xml).toContain("<Command>bun</Command>");
    // The script path should be quoted because it contains a space
    expect(xml).toContain('"C:\\Program Files\\cli.js"');
    expect(xml).toContain("daemon _run");
  });

  test("args containing double quotes are escaped with backslash", () => {
    const xml = m.buildXml(["bun", '/path/with"quote']);
    const args = xml.match(/<Arguments>(.*?)<\/Arguments>/)?.[1] ?? "";
    expect(args).toContain('\\"');
  });

  // trailing backslashes are doubled per CommandLineToArgvW
  test("args with trailing backslash have it doubled inside quotes", () => {
    const xml = m.buildXml(["bun", "C:\\path\\"]);
    const args = xml.match(/<Arguments>(.*?)<\/Arguments>/)?.[1] ?? "";
    // Trailing \ before closing " must be doubled: "C:\path\\" → Windows sees C:\path\
    expect(args).toContain('"C:\\path\\\\"');
  });

  // backslashes before quotes are doubled
  test("backslashes immediately before a quote are doubled", () => {
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

  // Regression guard: the install path must always resolve under os.tmpdir().
  // Hand-rolling `process.env.TEMP ?? "C:\\Temp"` previously produced a path
  // whose parent does not exist on stock Windows, aborting installWindows()
  // with ENOENT before schtasks /Create ever ran.
  test("writes XML under os.tmpdir() with the agentsync-task.xml filename", async () => {
    await m.installWindows(["C:\\agentsync.exe"]);

    const xmlPath = [...fsWrites.keys()].find((p) => p.endsWith("agentsync-task.xml"));
    expect(xmlPath).toBeDefined();
    if (!xmlPath) return;
    expect(xmlPath.startsWith(tmpdir())).toBe(true);
  });

  // Regression guard: an exported-but-empty TEMP env var must not collapse
  // the write path to drive root. `??` would short-circuit only on undefined,
  // letting "" through; os.tmpdir() treats blanks as unset and falls through
  // its own resolution chain.
  test("resolves under os.tmpdir() even when TEMP is set to empty string", async () => {
    const saved = process.env.TEMP;
    process.env.TEMP = "";
    try {
      await m.installWindows(["C:\\agentsync.exe"]);

      const xmlPath = [...fsWrites.keys()].find((p) => p.endsWith("agentsync-task.xml"));
      expect(xmlPath).toBeDefined();
      if (!xmlPath) return;
      expect(xmlPath.startsWith(tmpdir())).toBe(true);
      // Defence-in-depth: must not be the drive-root regression
      expect(xmlPath).not.toBe("\\agentsync-task.xml");
    } finally {
      process.env.TEMP = saved;
    }
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

  // startWindows passes AbortSignal to execFileAsync
  test("startWindows passes signal option to execFileAsync for /Run", async () => {
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
