import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig, resolveConfigPath } from "../../config/loader";
import { machineVaultRoot } from "../../config/paths";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  runGit,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";
import { performVaultUpgrade } from "../vault";

const RUNTIME_ENV_KEYS = [
  "AGENTSYNC_VAULT_DIR",
  "AGENTSYNC_KEY_PATH",
  "AGENTSYNC_MACHINE",
  "AGENTSYNC_MACHINE_FILE",
];

function applyMachineEnv(machine: TestMachineFixture): void {
  process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
  process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
  process.env.AGENTSYNC_MACHINE = machine.machineName;
  process.env.AGENTSYNC_MACHINE_FILE = machine.machineFilePath;
}

/** Seed a flat (v1) vault with the given agent dirs and push it to the bare remote. */
function seedFlatV1Vault(machine: TestMachineFixture, bareRepoPath: string, agentDirs: string[]) {
  mkdirSync(machine.vaultDir, { recursive: true });
  writeFileSync(
    join(machine.vaultDir, "agentsync.toml"),
    [
      'version = "1"',
      "[recipients]",
      `${machine.machineName} = "${machine.recipient}"`,
      "[agents]",
      "claude = true",
      "cursor = true",
      "codex = true",
      "copilot = true",
      "vscode = false",
      "[remote]",
      `url = "${bareRepoPath}"`,
      'branch = "main"',
      "[sync]",
      "debounceMs = 300",
      "autoPush = true",
      "autoPull = true",
      "pullIntervalMs = 300000",
      "",
    ].join("\n"),
    "utf8",
  );
  for (const agent of agentDirs) {
    mkdirSync(join(machine.vaultDir, agent), { recursive: true });
    writeFileSync(join(machine.vaultDir, agent, "artifact.age"), `${agent}-bytes`, "utf8");
  }
  runGit(["init"], machine.vaultDir);
  runGit(["symbolic-ref", "HEAD", "refs/heads/main"], machine.vaultDir);
  runGit(["config", "user.name", "Agent Sync Test"], machine.vaultDir);
  runGit(["config", "user.email", "test@agentsync.local"], machine.vaultDir);
  runGit(["remote", "add", "origin", bareRepoPath], machine.vaultDir);
  runGit(["add", "-A"], machine.vaultDir);
  runGit(["commit", "-m", "seed flat v1 vault"], machine.vaultDir);
  runGit(["push", "-u", "origin", "main"], machine.vaultDir);
}

describe("performVaultUpgrade", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    for (const key of RUNTIME_ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("migrates a flat v1 vault to machines/<self>/, bumps version, and pushes fast-forward", async () => {
    const bareRepoPath = await createBareRepo(tmpDir);
    const machine = await createMachineFixture(tmpDir, "alpha");
    // createMachineFixture pre-creates an empty vaultDir; seed the v1 content into it.
    seedFlatV1Vault(machine, bareRepoPath, ["claude", "cursor"]);
    applyMachineEnv(machine);

    const result = await performVaultUpgrade();

    expect(result.status).toBe("upgraded");
    if (result.status === "upgraded") {
      expect(result.movedAgents.sort()).toEqual(["claude", "cursor"]);
    }

    const root = machineVaultRoot(machine.vaultDir, "alpha");
    // Relocated under the machine namespace; the flat dirs are gone.
    expect(existsSync(join(root, "claude", "artifact.age"))).toBe(true);
    expect(existsSync(join(root, "cursor", "artifact.age"))).toBe(true);
    expect(existsSync(join(machine.vaultDir, "claude"))).toBe(false);
    expect(existsSync(join(machine.vaultDir, "cursor"))).toBe(false);

    // Version bumped to the integer 2 and the down-sync fields dropped.
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.version).toBe(2);
    expect((config.sync as Record<string, unknown>).autoPull).toBeUndefined();

    // History preserved via git mv (the relocated file is followable).
    const followLog = runGit(
      ["log", "--follow", "--format=%s", "--", "machines/alpha/claude/artifact.age"],
      machine.vaultDir,
    );
    expect(followLog).toContain("seed flat v1 vault");

    // Pushed fast-forward: the bare remote now holds the upgrade commit.
    const localHead = runGit(["rev-parse", "HEAD"], machine.vaultDir);
    const remoteHead = runGit(["rev-parse", "origin/main"], machine.vaultDir);
    expect(localHead).toBe(remoteHead);
  });

  test("is an idempotent no-op on a vault already at v2", async () => {
    const bareRepoPath = await createBareRepo(tmpDir);
    const machine = await createMachineFixture(tmpDir, "beta");
    seedFlatV1Vault(machine, bareRepoPath, ["claude"]);
    applyMachineEnv(machine);

    expect((await performVaultUpgrade()).status).toBe("upgraded");
    // Re-running sees a v2 vault and does nothing.
    expect((await performVaultUpgrade()).status).toBe("already-v2");
  });

  test("reports not-initialized when the vault has no config", async () => {
    const machine = await createMachineFixture(tmpDir, "gamma");
    applyMachineEnv(machine);
    const result = await performVaultUpgrade();
    expect(result.status).toBe("not-initialized");
  });
});

describe("per-machine namespace isolation", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    for (const key of RUNTIME_ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("after upgrade, a second machine's content lives in its own namespace", async () => {
    // Two machines upgrade their own flat content into distinct namespaces in
    // separate clones; the layout never collides on the agent directory name.
    const bareA = await createBareRepo(join(tmpDir, "a"));
    const machineA = await createMachineFixture(tmpDir, "host-a");
    seedFlatV1Vault(machineA, bareA, ["claude"]);
    applyMachineEnv(machineA);
    await performVaultUpgrade();

    const bareB = await createBareRepo(join(tmpDir, "b"));
    const machineB = await createMachineFixture(tmpDir, "host-b");
    seedFlatV1Vault(machineB, bareB, ["claude"]);
    applyMachineEnv(machineB);
    await performVaultUpgrade();

    expect(existsSync(join(machineVaultRoot(machineA.vaultDir, "host-a"), "claude"))).toBe(true);
    expect(existsSync(join(machineVaultRoot(machineB.vaultDir, "host-b"), "claude"))).toBe(true);
    // Neither machine wrote into the other's namespace.
    expect(existsSync(join(machineA.vaultDir, "machines", "host-b"))).toBe(false);
    expect(existsSync(join(machineB.vaultDir, "machines", "host-a"))).toBe(false);
  });
});
