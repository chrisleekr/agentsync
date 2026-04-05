import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths, resolveDaemonSocketPath } from "../../config/paths";
import { IpcServer } from "../../core/ipc";
import { Watcher } from "../../core/watcher";
import { createAgeIdentity, createTmpDir, runGit } from "../../test-helpers/fixtures";

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
let scheduledIntervalMs = 0;
let scheduledIntervalCallback: null | (() => Promise<void>) = null;
let clearedIntervalToken: unknown = null;
let exitCode: number | null = null;

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalProcessOn = process.on;
const originalProcessExit = process.exit;
const originalVaultDir = process.env.AGENTSYNC_VAULT_DIR;
const originalKeyPath = process.env.AGENTSYNC_KEY_PATH;
const originalMachine = process.env.AGENTSYNC_MACHINE;

let tmpDir = "";

type DaemonModule = typeof import("../index");
let daemonModule: DaemonModule;

let infoSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let ipcOnSpy: ReturnType<typeof spyOn>;
let ipcListenSpy: ReturnType<typeof spyOn>;
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

  globalThis.setInterval = ((callback: TimerHandler, delay?: number) => {
    scheduledIntervalCallback = callback as () => Promise<void>;
    scheduledIntervalMs = delay ?? 0;
    return "daemon-interval" as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;

  globalThis.clearInterval = ((token?: unknown) => {
    clearedIntervalToken = token ?? null;
  }) as typeof clearInterval;

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
      'version = "1"',
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
      "autoPull = true",
      "pullIntervalMs = 12345",
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

  infoLogs.length = 0;
  errorLogs.length = 0;
  ipcHandlers.clear();
  signalHandlers.clear();
  watcherAdds.length = 0;
  listenedSocketPath = "";
  watcherClosed = false;
  scheduledIntervalMs = 0;
  scheduledIntervalCallback = null;
  clearedIntervalToken = null;
  exitCode = null;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("startDaemon", () => {
  test("registers IPC handlers, watcher targets, and the pull interval from config", async () => {
    await daemonModule.startDaemon();

    expect(listenedSocketPath).toBe(resolveDaemonSocketPath());
    expect(infoLogs.some((message) => message.includes("AgentSync daemon started"))).toBe(true);
    expect(ipcHandlers.has("status")).toBe(true);
    expect(ipcHandlers.has("push")).toBe(true);
    expect(ipcHandlers.has("pull")).toBe(true);
    expect(watcherAdds.map((entry) => entry.target)).toEqual([
      dirname(AgentPaths.claude.claudeMd),
      dirname(AgentPaths.cursor.mcpGlobal),
      AgentPaths.codex.root,
      AgentPaths.copilot.instructionsDir,
    ]);
    expect(watcherAdds.every((entry) => entry.debounceMs === 2000)).toBe(true);
    expect(scheduledIntervalMs).toBe(12_345);
    expect(signalHandlers.has("SIGTERM")).toBe(true);
    expect(signalHandlers.has("SIGINT")).toBe(true);
  });

  test("logs fatal pull and push failures through IPC handlers, watchers, and shutdown", async () => {
    await daemonModule.startDaemon();

    await ipcHandlers.get("pull")?.();
    await ipcHandlers.get("push")?.();
    await watcherAdds[0]?.callback(watcherAdds[0].target);
    await scheduledIntervalCallback?.();
    await signalHandlers.get("SIGTERM")?.();

    expect(errorLogs.length).toBeGreaterThan(0);
    expect(errorLogs.some((message) => message.includes("fatal:"))).toBe(true);
    expect(watcherClosed).toBe(true);
    expect(clearedIntervalToken).toBe("daemon-interval");
    expect(exitCode).toBe(0);
  });
});
