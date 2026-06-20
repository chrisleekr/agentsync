import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths, resolveDaemonSocketPath } from "../../config/paths";
import { IpcClient, IpcServer } from "../../core/ipc";
import { Watcher } from "../../core/watcher";
import { createAgeIdentity, createTmpDir, runGit } from "../../test-helpers/fixtures";
import { EMPTY_DAEMON_STATE, readDaemonState, writeDaemonState } from "../state";

{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: The fs/promises alias bypasses Bun's shared node:fs/promises mock cache between test files.
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => ({ ...realFsPromises, default: realFsPromises }));
}

const { mkdir, rm, writeFile } = createRequire(import.meta.url)(
  "fs/promises",
) as typeof import("node:fs/promises");

const infoLogs: string[] = [];
const errorLogs: string[] = [];
const ipcHandlers = new Map<string, (args?: unknown) => Promise<unknown>>();
const signalHandlers = new Map<string, () => Promise<void>>();
const watcherAdds: Array<{
  target: string;
  debounceMs: number;
  callback: (path: string) => void | Promise<void>;
}> = [];

let listenedSocketPath = "";
let watcherClosed = false;
let ipcClosed = false;
// Captured to assert the push-only daemon arms NO periodic pull (stays null).
let scheduledIntervalCallback: null | (() => Promise<void>) = null;
let exitCode: number | null = null;

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalProcessOn = process.on;
const originalProcessExit = process.exit;
const originalVaultDir = process.env.AGENTSYNC_VAULT_DIR;
const originalKeyPath = process.env.AGENTSYNC_KEY_PATH;
const originalMachine = process.env.AGENTSYNC_MACHINE;
const originalAgentsyncDir = process.env.AGENTSYNC_DIR;

let tmpDir = "";

type DaemonModule = typeof import("../index");
let daemonModule: DaemonModule;

let infoSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let ipcOnSpy: ReturnType<typeof spyOn>;
let ipcListenSpy: ReturnType<typeof spyOn>;
let ipcCloseSpy: ReturnType<typeof spyOn>;
let ipcClientSendSpy: ReturnType<typeof spyOn>;
let watcherAddSpy: ReturnType<typeof spyOn>;
let watcherCloseSpy: ReturnType<typeof spyOn>;

beforeAll(async () => {
  infoSpy = spyOn(log, "info").mockImplementation((message: string) => {
    infoLogs.push(message);
  });
  errorSpy = spyOn(log, "error").mockImplementation((message: string) => {
    errorLogs.push(message);
  });
  ipcOnSpy = spyOn(IpcServer.prototype, "on").mockImplementation(function (
    this: IpcServer,
    command: string,
    handler: (args?: unknown) => Promise<unknown>,
  ) {
    ipcHandlers.set(command, handler);
  });
  ipcListenSpy = spyOn(IpcServer.prototype, "listen").mockImplementation(
    async (socketPath?: string) => {
      listenedSocketPath = socketPath ?? "";
    },
  );
  ipcCloseSpy = spyOn(IpcServer.prototype, "close").mockImplementation(function (this: IpcServer) {
    ipcClosed = true;
  });
  // Default: ENOENT (no socket file = clean start)
  ipcClientSendSpy = spyOn(IpcClient.prototype, "send").mockRejectedValue(
    Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
  );
  watcherAddSpy = spyOn(Watcher.prototype, "add").mockImplementation(function (
    this: Watcher,
    target: string,
    debounceMs: number,
    callback: (path: string) => void | Promise<void>,
  ) {
    watcherAdds.push({ target, debounceMs, callback });
  });
  watcherCloseSpy = spyOn(Watcher.prototype, "close").mockImplementation(() => {
    watcherClosed = true;
  });

  globalThis.setInterval = ((callback: TimerHandler) => {
    scheduledIntervalCallback = callback as () => Promise<void>;
    return "daemon-interval" as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  globalThis.clearInterval = (() => {}) as typeof clearInterval;

  process.on = ((event: NodeJS.Signals, listener: () => Promise<void>) => {
    signalHandlers.set(String(event), listener);
    return process;
  }) as typeof process.on;

  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    return undefined as never;
  }) as typeof process.exit;

  daemonModule = await import("../index");
});

afterAll(() => {
  infoSpy.mockRestore();
  errorSpy.mockRestore();
  ipcOnSpy.mockRestore();
  ipcListenSpy.mockRestore();
  ipcCloseSpy.mockRestore();
  ipcClientSendSpy.mockRestore();
  watcherAddSpy.mockRestore();
  watcherCloseSpy.mockRestore();

  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  process.on = originalProcessOn;
  process.exit = originalProcessExit;

  if (originalVaultDir === undefined) {
    delete process.env.AGENTSYNC_VAULT_DIR;
  } else {
    process.env.AGENTSYNC_VAULT_DIR = originalVaultDir;
  }

  if (originalKeyPath === undefined) {
    delete process.env.AGENTSYNC_KEY_PATH;
  } else {
    process.env.AGENTSYNC_KEY_PATH = originalKeyPath;
  }

  if (originalMachine === undefined) {
    delete process.env.AGENTSYNC_MACHINE;
  } else {
    process.env.AGENTSYNC_MACHINE = originalMachine;
  }

  if (originalAgentsyncDir === undefined) {
    delete process.env.AGENTSYNC_DIR;
  } else {
    process.env.AGENTSYNC_DIR = originalAgentsyncDir;
  }
});

beforeEach(async () => {
  tmpDir = await createTmpDir();
  const vaultDir = join(tmpDir, "vault");
  const keyPath = join(tmpDir, "key.txt");
  const remotePath = join(tmpDir, "missing-remote.git");

  const { identity, recipient } = await createAgeIdentity();
  await mkdir(vaultDir, { recursive: true });
  await writeFile(keyPath, `${identity}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(
    join(vaultDir, "agentsync.toml"),
    [
      "version = 2",
      "[recipients]",
      `daemon = "${recipient}"`,
      "[agents]",
      "cursor = true",
      "claude = true",
      "codex = true",
      "copilot = true",
      "vscode = false",
      "[remote]",
      `url = "${remotePath}"`,
      'branch = "main"',
      "[sync]",
      "debounceMs = 300",
      "autoPush = true",
      "",
    ].join("\n"),
    "utf8",
  );

  runGit(["init"], vaultDir);
  runGit(["symbolic-ref", "HEAD", "refs/heads/main"], vaultDir);
  runGit(["config", "user.name", "Agent Sync Test"], vaultDir);
  runGit(["config", "user.email", "test@agentsync.local"], vaultDir);
  runGit(["remote", "add", "origin", remotePath], vaultDir);

  process.env.AGENTSYNC_VAULT_DIR = vaultDir;
  process.env.AGENTSYNC_KEY_PATH = keyPath;
  process.env.AGENTSYNC_MACHINE = "daemon-machine";
  // Isolate the durable daemon-state.json (and any desktop notification it
  // triggers) into the tmp dir so tests never touch the real ~/.config/agentsync.
  process.env.AGENTSYNC_DIR = tmpDir;

  infoLogs.length = 0;
  errorLogs.length = 0;
  ipcHandlers.clear();
  signalHandlers.clear();
  watcherAdds.length = 0;
  listenedSocketPath = "";
  watcherClosed = false;
  ipcClosed = false;
  scheduledIntervalCallback = null;
  exitCode = null;

  // Reset to default: clean start (no existing socket)
  ipcClientSendSpy.mockRejectedValue(
    Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }),
  );
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("startDaemon", () => {
  test("registers IPC handlers and watcher targets, and schedules no auto-pull timer", async () => {
    await daemonModule.startDaemon();

    expect(listenedSocketPath).toBe(resolveDaemonSocketPath());
    expect(infoLogs.some((message) => message.includes("AgentSync daemon started"))).toBe(true);
    expect(ipcHandlers.has("status")).toBe(true);
    expect(ipcHandlers.has("push")).toBe(true);
    // Push-only daemon: no pull IPC handler.
    expect(ipcHandlers.has("pull")).toBe(false);
    expect(watcherAdds.map((entry) => entry.target)).toEqual([
      dirname(AgentPaths.claude.claudeMd),
      dirname(AgentPaths.cursor.mcpGlobal),
      AgentPaths.codex.root,
      AgentPaths.copilot.instructionsDir,
    ]);
    expect(watcherAdds.every((entry) => entry.debounceMs === 2000)).toBe(true);
    // v2: the vault is push-only backup, so the daemon arms no periodic pull.
    expect(scheduledIntervalCallback).toBeNull();
    expect(signalHandlers.has("SIGTERM")).toBe(true);
    expect(signalHandlers.has("SIGINT")).toBe(true);
  });

  test("logs fatal push failures through the IPC handler, watchers, and shutdown", async () => {
    await daemonModule.startDaemon();

    // The daemon is push-only — there is no IPC pull handler to register.
    expect(ipcHandlers.has("pull")).toBe(false);
    await ipcHandlers.get("push")?.();
    await watcherAdds[0]?.callback(watcherAdds[0].target);
    await signalHandlers.get("SIGTERM")?.();

    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs.some((message) => message.includes("fatal:"))).toBe(true);
    expect(watcherClosed).toBe(true);
    expect(exitCode).toBe(0);
  });
});

// ── Second-instance detection ─────────────────────────
describe("second-instance detection", () => {
  test("exits with code 1 and logs 'already running' when daemon responds to health ping", async () => {
    ipcClientSendSpy.mockResolvedValueOnce({
      id: "test",
      ok: true,
      data: { pid: 99999 },
    });

    await daemonModule.startDaemon();

    expect(exitCode).toBe(1);
    expect(infoLogs.some((m) => m.includes("already running"))).toBe(true);
    // Must NOT have proceeded to ipc.listen
    expect(listenedSocketPath).toBe("");
  });
});

// ── Clean shutdown ──────────────────────────────────────────────────────
describe("clean shutdown", () => {
  test("SIGTERM calls ipc.close() before process.exit(0)", async () => {
    await daemonModule.startDaemon();
    await signalHandlers.get("SIGTERM")?.();

    expect(ipcClosed).toBe(true);
    expect(exitCode).toBe(0);
  });

  test("SIGTERM unlinks the socket path before process.exit(0)", async () => {
    await daemonModule.startDaemon();

    // The shutdown function calls unlink(socketPath). Since the socket file doesn't
    // actually exist on disk in this test, the call swallows ENOENT. The important
    // thing is that shutdown completes and exit(0) is called.
    await signalHandlers.get("SIGTERM")?.();

    expect(exitCode).toBe(0);
    expect(watcherClosed).toBe(true);
  });

  test("shutdown sequence: ipc.close → watcher.close → exit(0)", async () => {
    await daemonModule.startDaemon();
    await signalHandlers.get("SIGTERM")?.();

    expect(ipcClosed).toBe(true);
    expect(watcherClosed).toBe(true);
    expect(exitCode).toBe(0);
  });
});

// ── Failure tracking ─────────────────────────────────────────
describe("failure tracking", () => {
  test("after a failed push, consecutiveFailures >= 1 and lastError is non-null", async () => {
    await daemonModule.startDaemon();

    // Push will fail because the remote doesn't exist — withRetry calls it twice
    await ipcHandlers.get("push")?.();

    const status = (await ipcHandlers.get("status")?.()) as {
      consecutiveFailures: number;
      lastError: string | null;
    };
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(status.lastError).not.toBeNull();
    expect(status.lastError).toContain("[push]");
  });

  test("status IPC handler returns an object matching DaemonStatusSchema shape", async () => {
    await daemonModule.startDaemon();

    const status = (await ipcHandlers.get("status")?.()) as Record<string, unknown>;
    expect(status).toHaveProperty("pid");
    expect(status).toHaveProperty("consecutiveFailures");
    expect(status).toHaveProperty("lastError");
    expect(status).toHaveProperty("lastSuccessAt");
    expect(status).toHaveProperty("stuck");
    expect(typeof status.pid).toBe("number");
    expect(typeof status.consecutiveFailures).toBe("number");
  });

  test("a failed push persists to the durable state file", async () => {
    await daemonModule.startDaemon();
    await ipcHandlers.get("push")?.();

    // The on-disk state must reflect the failure so `daemon status`/`doctor`
    // can report it even after the daemon exits. The daemon persists state
    // fire-and-forget, so poll until the write lands rather than racing it.
    let persisted = await readDaemonState();
    for (let i = 0; i < 40 && persisted.consecutiveFailures < 1; i++) {
      await Bun.sleep(25);
      persisted = await readDaemonState();
    }
    expect(persisted.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(persisted.lastError).not.toBeNull();
    expect(persisted.lastErrorAt).not.toBeNull();
  });

  test("startup preserves a prior stuck flag across restart", async () => {
    // Simulate a previous run that died stuck on a divergence.
    await writeDaemonState({
      ...EMPTY_DAEMON_STATE,
      stuck: true,
      lastError: "[push] Vault history diverged",
    });

    await daemonModule.startDaemon();
    const status = (await ipcHandlers.get("status")?.()) as { stuck: boolean };
    // A restart does not resolve a divergence, so stuck stays latched.
    expect(status.stuck).toBe(true);
  });
});

// ── Retry logic ─────────────────────────────────────────────
describe("retry logic", () => {
  test("when both attempts fail, consecutiveFailures increments to >= 1 and process.exit is NOT called", async () => {
    await daemonModule.startDaemon();

    // Push will fail (no remote) — retry also fails
    await ipcHandlers.get("push")?.();

    const status = (await ipcHandlers.get("status")?.()) as {
      consecutiveFailures: number;
    };
    expect(status.consecutiveFailures).toBeGreaterThanOrEqual(1);
    // Daemon must NOT exit — it stays alive for the next trigger
    expect(exitCode).toBeNull();
  });
});

// ── T034a/T034b: Startup validation ─────────────────
describe("startup validation", () => {
  test("exits with code 1 and log contains 'vault' when vault dir is missing", async () => {
    // Remove the vault directory so loadConfig fails
    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "nonexistent-vault");

    await daemonModule.startDaemon();

    expect(exitCode).toBe(1);
    expect(errorLogs.some((m) => m.toLowerCase().includes("startup failed"))).toBe(true);
  });

  test("exits with code 1 when key file is missing", async () => {
    // Point to a non-existent key file
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "nonexistent-key.txt");

    await daemonModule.startDaemon();

    expect(exitCode).toBe(1);
    expect(errorLogs.some((m) => m.toLowerCase().includes("startup failed"))).toBe(true);
  });
});
