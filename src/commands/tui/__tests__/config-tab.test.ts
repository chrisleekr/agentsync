/**
 * Tests for the Config tab: pure cursor navigation and the edit handlers
 * (toggle boolean, cycle enum, adjust number) writing through the shared
 * `performConfigSet` core against a real seeded vault.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { KeyEvent } from "@opentui/core";
import { loadConfig, resolveConfigPath } from "../../../config/loader";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../../test-helpers/fixtures";
import { type ConfigRow, createInitialState } from "../state";
import { createStore, type Store } from "../store";
import { ensureConfigLoaded, onConfigKey, secretScanExplainer } from "../tabs/config";

function key(name: string): KeyEvent {
  return { name, sequence: name, ctrl: false, meta: false, shift: false } as unknown as KeyEvent;
}

function readyStore(rows: ConfigRow[], cursor = 0): Store {
  const store = createStore(createInitialState());
  store.dispatch((d) => {
    d.activeTab = "config";
    d.config.phase = "ready";
    d.config.rows = rows;
    d.config.cursor = cursor;
  });
  return store;
}

describe("onConfigKey — navigation", () => {
  const rows: ConfigRow[] = [
    { key: "agents.claude", value: true, kind: "boolean" },
    { key: "agents.vscode", value: false, kind: "boolean" },
    {
      key: "security.secretScan",
      value: "standard",
      kind: "enum",
      options: ["standard", "strict", "redact", "off"],
    },
  ];

  test("down/up move the cursor within bounds", () => {
    const store = readyStore(rows);
    expect(onConfigKey(key("down"), store)).toBe(true);
    expect(store.getState().config.cursor).toBe(1);
    onConfigKey(key("down"), store);
    onConfigKey(key("down"), store); // clamps at last
    expect(store.getState().config.cursor).toBe(2);
    onConfigKey(key("up"), store);
    expect(store.getState().config.cursor).toBe(1);
  });

  test("keys are ignored until ready and non-empty", () => {
    expect(onConfigKey(key("down"), createStore(createInitialState()))).toBe(false);
    expect(onConfigKey(key("down"), readyStore([]))).toBe(false);
  });

  test("a read-only row does not consume the edit keys", () => {
    const store = readyStore([{ key: "security.allowSecretValues", value: [], kind: "readonly" }]);
    expect(onConfigKey(key("space"), store)).toBe(false);
    expect(onConfigKey(key("left"), store)).toBe(false);
  });
});

describe("secretScanExplainer", () => {
  test("returns a distinct non-empty line for each mode", () => {
    const modes = ["standard", "strict", "redact", "off"];
    const lines = modes.map((m) => secretScanExplainer(m));
    for (const line of lines) expect(line.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(modes.length); // all distinct
  });

  test("does not claim env-var auto-expansion for redact (placeholder is literal)", () => {
    const redact = secretScanExplainer("redact").toLowerCase();
    expect(redact).toContain("$agentsync_redacted_");
    expect(redact).not.toContain("env var");
  });

  test("returns empty string for an unknown mode", () => {
    expect(secretScanExplainer("nope")).toBe("");
  });
});

describe("Config tab against a real vault", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};
  const KEYS = [
    "AGENTSYNC_VAULT_DIR",
    "AGENTSYNC_KEY_PATH",
    "AGENTSYNC_MACHINE",
    "AGENTSYNC_MACHINE_FILE",
  ];

  async function waitFor(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  }

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bare = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "config-tab");
    seedVaultRepo({ machine, bareRepoPath: bare });
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

  test("ensureConfigLoaded loads settable rows and recipients", async () => {
    const store = createStore(createInitialState());
    ensureConfigLoaded(store);
    await waitFor(() => store.getState().config.phase === "ready");

    const c = store.getState().config;
    expect(c.phase).toBe("ready");
    const keys = c.rows.map((r) => r.key);
    expect(keys).toContain("agents.claude");
    expect(keys).toContain("security.secretScan");
    // No non-settable keys leak in.
    expect(keys.some((k) => k.startsWith("remote") || k === "version")).toBe(false);
    expect(c.rows.find((r) => r.key === "security.secretScan")?.kind).toBe("enum");
    expect(c.recipients.find((r) => r.name === "config-tab")?.isSelf).toBe(true);
  });

  async function loadAndFocus(store: Store, key: string): Promise<void> {
    ensureConfigLoaded(store);
    await waitFor(() => store.getState().config.phase === "ready");
    const idx = store.getState().config.rows.findIndex((r) => r.key === key);
    store.dispatch((d) => {
      d.config.cursor = idx;
    });
  }

  test("space toggles a boolean and persists it through performConfigSet", async () => {
    const store = createStore(createInitialState());
    await loadAndFocus(store, "agents.vscode"); // default false
    expect(onConfigKey(key("space"), store)).toBe(true);
    await waitFor(() => store.getState().config.lastResult !== null);

    expect(store.getState().config.lastResult?.ok).toBe(true);
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.agents.vscode).toBe(true);
  });

  test("right cycles an enum and persists it", async () => {
    const store = createStore(createInitialState());
    await loadAndFocus(store, "security.secretScan"); // standard
    expect(onConfigKey(key("right"), store)).toBe(true);
    await waitFor(() => store.getState().config.lastResult !== null);

    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.secretScan).toBe("strict");
  });

  test("left wraps to off but gates the apply behind a y/n confirm", async () => {
    const store = createStore(createInitialState());
    await loadAndFocus(store, "security.secretScan"); // standard (index 0)
    // left wraps standard -> off, the dangerous transition: it opens the
    // confirm modal instead of applying immediately.
    expect(onConfigKey(key("left"), store)).toBe(true);
    expect(store.getState().config.pendingSecretScan).toBe("off");
    expect(store.getState().config.lastResult).toBeNull(); // not applied yet

    // y confirms and persists.
    expect(onConfigKey(key("y"), store)).toBe(true);
    await waitFor(() => store.getState().config.lastResult !== null);
    expect(store.getState().config.pendingSecretScan).toBeNull();
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.secretScan).toBe("off"); // wrapped to last, confirmed
  });

  test("n cancels the off confirm and leaves the value unchanged", async () => {
    const store = createStore(createInitialState());
    await loadAndFocus(store, "security.secretScan"); // standard
    expect(onConfigKey(key("left"), store)).toBe(true); // -> off, modal opens
    expect(store.getState().config.pendingSecretScan).toBe("off");
    expect(onConfigKey(key("n"), store)).toBe(true); // cancel
    expect(store.getState().config.pendingSecretScan).toBeNull();

    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.secretScan).toBe("standard"); // untouched
  });

  test("cycling to redact applies immediately without a confirm", async () => {
    const store = createStore(createInitialState());
    await loadAndFocus(store, "security.secretScan"); // standard -> strict -> redact
    onConfigKey(key("right"), store); // strict
    await waitFor(() => store.getState().config.lastResult !== null);
    onConfigKey(key("right"), store); // redact
    await waitFor(
      () =>
        String(store.getState().config.rows.find((r) => r.key === "security.secretScan")?.value) ===
        "redact",
    );
    expect(store.getState().config.pendingSecretScan).toBeNull();
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.secretScan).toBe("redact");
  });

  test("ensureConfigLoaded surfaces an error (not a crash) on an un-init vault", async () => {
    const empty = join(tmpDir, "no-vault-here");
    await mkdir(empty, { recursive: true });
    process.env.AGENTSYNC_VAULT_DIR = empty;

    const store = createStore(createInitialState());
    ensureConfigLoaded(store);
    await waitFor(() => store.getState().config.phase === "error");
    expect(store.getState().config.phase).toBe("error");
    expect(store.getState().config.error).not.toBeNull();
  });
});
