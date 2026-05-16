/**
 * Tests for installer-linux: installLinux, uninstallLinux, startLinux, stopLinux,
 * isInstalledLinux, buildUnit, isRegisteredLinux
 *
 * Strategy
 * --------
 * The installer module exposes `__setInstallerLinuxImplForTests` so we can
 * inject fs + exec stubs DIRECTLY into its private slots. This bypasses
 * Bun's mock.module() cache entirely — which is necessary because the
 * cache does not retro-update bindings already captured by daemon.test.ts
 * (which loads installer-linux before this file runs in CI's file order).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const fsWrites = new Map<string, string>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
let lastExecFileOpts: { signal?: AbortSignal } | undefined;

let isEnabledStdout = "";
let isEnabledShouldFail = false;

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
  if (cmd === "systemctl" && args.includes("is-enabled")) {
    if (isEnabledShouldFail) throw new Error("not enabled");
    return { stdout: isEnabledStdout, stderr: "" };
  }
  return { stdout: "", stderr: "" };
};

type LinuxInstallerModule = typeof import("../installer-linux");
let m: LinuxInstallerModule;

beforeAll(async () => {
  const req = createRequire(import.meta.url);
  m = req("../installer-linux") as LinuxInstallerModule;
  // Diagnostic: log which functions we received so CI logs surface
  // whether mock.module() pollution is happening.
  // biome-ignore lint/suspicious/noConsole: diagnostic for CI flake
  console.log(
    `[installer-linux.test] m.installLinux.name=${m.installLinux.name} ` +
      `hasSetImpl=${typeof m.__setInstallerLinuxImplForTests}`,
  );
  m.__setInstallerLinuxImplForTests({ fs: fsStub, exec: execStub });

  // Probe: trigger installLinux with a sentinel arg and assert the stub
  // wrote to fsWrites. If this fails, every subsequent test would fail
  // too — fail loudly with diagnostic data instead.
  fsWrites.clear();
  try {
    await m.installLinux(["__probe__"]);
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: diagnostic
    console.error(`[installer-linux.test] probe threw: ${(err as Error).message}`);
  }
  // biome-ignore lint/suspicious/noConsole: diagnostic
  console.log(
    `[installer-linux.test] probe wrote ${fsWrites.size} files; ` +
      `keys=${[...fsWrites.keys()].join(",")}`,
  );
  fsWrites.clear();
});

afterAll(() => {
  // Restore real implementations on the global slot so any later test file
  // that exercises installer-linux for real sees clean defaults.
  m.__setInstallerLinuxImplForTests({ fs: null, exec: null });
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
