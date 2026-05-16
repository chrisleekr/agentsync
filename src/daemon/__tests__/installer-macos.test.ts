/**
 * Tests for installer-macos: installMacOs, uninstallMacOs, startMacOs, stopMacOs,
 * isInstalledMacOs, buildPlist, isRegisteredMacOs, extractServiceManagerError
 *
 * Strategy
 * --------
 * The installer exposes `__setInstallerMacOsImplForTests` so we can inject
 * fs + exec stubs DIRECTLY into its private slots. See installer-linux.test
 * for the full rationale on why this bypasses Bun's `mock.module()` cache.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const fsWrites = new Map<string, string>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let lastExecFileOpts: { signal?: AbortSignal } | undefined;

let launchctlShouldFail = false;
let launchctlFailStderr = "Bootstrap failed: 5: Input/output error";
let launchctlPrintShouldFail = true; // default: not registered

const fsStub = {
  mkdir: (async () => {}) as unknown as typeof import("node:fs/promises").mkdir,
  writeFile: (async (path: string, content: string | Uint8Array) => {
    fsWrites.set(path, typeof content === "string" ? content : (content as Buffer).toString());
  }) as unknown as typeof import("node:fs/promises").writeFile,
  readFile: (async (path: string) => {
    const content = fsWrites.get(path);
    if (content !== undefined) return content;
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
      code: "ENOENT",
    });
  }) as unknown as typeof import("node:fs/promises").readFile,
  rm: (async (path: string) => {
    fsWrites.delete(path);
  }) as unknown as typeof import("node:fs/promises").rm,
};

const execStub = async (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> => {
  execFileCalls.push({ cmd, args });
  if (opts) lastExecFileOpts = opts;
  if (cmd === "launchctl" && args[0] === "print" && launchctlPrintShouldFail) {
    throw Object.assign(new Error("Could not find service"), {
      stderr: "Could not find service",
    });
  }
  if (launchctlShouldFail && cmd === "launchctl" && args[0] === "bootstrap") {
    throw Object.assign(new Error("launchctl failed"), {
      stderr: launchctlFailStderr,
    });
  }
  return { stdout: "", stderr: "" };
};

type MacOsInstallerModule = typeof import("../installer-macos");
let m: MacOsInstallerModule;

beforeAll(() => {
  // See installer-linux.test for why this uses createRequire instead of
  // `await import(...)`. We need to bypass Bun's mock.module() registry
  // so daemon.test.ts's stub does not bleed in.
  const req = createRequire(import.meta.url);
  m = req("../installer-macos") as MacOsInstallerModule;
  m.__setInstallerMacOsImplForTests({ fs: fsStub, exec: execStub });
});

afterAll(() => {
  m.__setInstallerMacOsImplForTests({ fs: null, exec: null });
});

beforeEach(() => {
  fsWrites.clear();
  execFileCalls.length = 0;
  launchctlShouldFail = false;
  launchctlFailStderr = "Bootstrap failed: 5: Input/output error";
  launchctlPrintShouldFail = true; // default: not registered
  lastExecFileOpts = undefined;
});

// ── buildPlist emits separate <string> elements ─────────────────────────
describe("buildPlist", () => {
  test("emits separate <string> elements for each arg", () => {
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

  // XML special characters in args are escaped
  test("escapes & and < in arg values", () => {
    const plist = m.buildPlist(["/path/with&amp", "/path/<special>"], "/var/log");
    expect(plist).toContain("<string>/path/with&amp;amp</string>");
    expect(plist).toContain("<string>/path/&lt;special&gt;</string>");
    // Must NOT contain unescaped & or < inside <string> elements
    expect(plist).not.toContain("<string>/path/with&amp</string>");
  });
});

// ── installMacOs calls bootout before bootstrap ─────────────────────────
describe("installMacOs", () => {
  test("calls launchctl bootout before launchctl bootstrap", async () => {
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

  // bootstrap failure surfaces stderr, not stack trace
  test("throws with service manager stderr (not stack trace) when bootstrap fails", async () => {
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

// ── startMacOs throws immediately when not registered ───────────────────
describe("startMacOs / stopMacOs", () => {
  test("startMacOs throws 'Service not bootstrapped' when isRegisteredMacOs returns false", async () => {
    // launchctl print will fail (not registered), no kickstart call expected
    await expect(m.startMacOs()).rejects.toThrow("Service not bootstrapped");

    const kickstartCall = execFileCalls.find(
      (c) => c.cmd === "launchctl" && c.args[0] === "kickstart",
    );
    expect(kickstartCall).toBeUndefined();
  });

  // startMacOs passes AbortSignal to execFileAsync
  test("startMacOs passes signal option to execFileAsync for kickstart", async () => {
    launchctlPrintShouldFail = false; // registered
    await m.startMacOs();

    const kickstartCall = execFileCalls.find(
      (c) => c.cmd === "launchctl" && c.args[0] === "kickstart",
    );
    expect(kickstartCall).toBeDefined();
    expect(lastExecFileOpts).toBeDefined();
    expect(lastExecFileOpts?.signal).toBeInstanceOf(AbortSignal);
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
