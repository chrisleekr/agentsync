import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { KeyEvent } from "@opentui/core";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../../test-helpers/fixtures";
import { createInitialState } from "../state";
import { createStore } from "../store";
import { ensureMachinesLoaded, onMachinesKey } from "../tabs/machines";

function key(name: string): KeyEvent {
  return { name, sequence: name, ctrl: false, meta: false, shift: false } as unknown as KeyEvent;
}

function readyStore(list: string[], cursor = 0) {
  const store = createStore(createInitialState());
  store.dispatch((d) => {
    d.activeTab = "machines";
    d.machines.phase = "ready";
    d.machines.list = list;
    d.machines.cursor = cursor;
  });
  return store;
}

describe("onMachinesKey — navigation", () => {
  test("down/up move the cursor within bounds", () => {
    const store = readyStore(["a", "b", "c"]);
    expect(onMachinesKey(key("down"), store)).toBe(true);
    expect(store.getState().machines.cursor).toBe(1);
    onMachinesKey(key("down"), store);
    onMachinesKey(key("down"), store); // clamps at last
    expect(store.getState().machines.cursor).toBe(2);
    onMachinesKey(key("up"), store);
    expect(store.getState().machines.cursor).toBe(1);
  });

  test("keys are ignored until the list is ready and non-empty", () => {
    const idle = createStore(createInitialState());
    expect(onMachinesKey(key("down"), idle)).toBe(false);
    const empty = readyStore([]);
    expect(onMachinesKey(key("down"), empty)).toBe(false);
  });
});

describe("ensureMachinesLoaded", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};
  const KEYS = [
    "AGENTSYNC_VAULT_DIR",
    "AGENTSYNC_KEY_PATH",
    "AGENTSYNC_MACHINE",
    "AGENTSYNC_MACHINE_FILE",
  ];

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bare = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "host-self");
    seedVaultRepo({ machine, bareRepoPath: bare });
    // Seed two machine namespaces in the vault.
    await mkdir(join(machine.vaultDir, "machines", "host-a"), { recursive: true });
    await mkdir(join(machine.vaultDir, "machines", "host-b"), { recursive: true });
    for (const k of KEYS) savedEnv[k] = process.env[k];
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;
    process.env.AGENTSYNC_MACHINE_FILE = machine.machineFilePath;
  });

  afterEach(async () => {
    for (const k of KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("lists the vault machine namespaces and flips phase to ready", async () => {
    const store = createStore(createInitialState());
    ensureMachinesLoaded(store);
    // The load runs through runOperation; wait for it to settle.
    for (let i = 0; i < 50 && store.getState().machines.phase === "loading"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const m = store.getState().machines;
    expect(m.phase).toBe("ready");
    expect(m.list).toEqual(["host-a", "host-b"]);
  });

  test("is idempotent — a second call while ready does not reload", () => {
    const store = readyStore(["x"]);
    ensureMachinesLoaded(store);
    // Still the directly-seeded list; no load was kicked off.
    expect(store.getState().machines.list).toEqual(["x"]);
  });

  test("enter copies the selected machine via performCopy and records lastCopy", async () => {
    // host-a's namespace exists but is empty, so every per-agent performCopy
    // returns not-found and is skipped — exercising the copy loop + onSuccess
    // accumulation without writing to local agent paths.
    const store = readyStore(["host-a"]);
    expect(onMachinesKey(key("return"), store)).toBe(true);
    for (let i = 0; i < 50 && store.getState().machines.lastCopy === null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const last = store.getState().machines.lastCopy;
    expect(last?.machine).toBe("host-a");
    expect(last?.ok).toBe(true);
    expect(last?.message).toContain("0 artifact");
  });
});
