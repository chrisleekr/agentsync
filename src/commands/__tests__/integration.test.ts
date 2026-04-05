/**
 * Integration tests (T038–T044, T052) — end-to-end command coverage.
 *
 * Strategy
 * --------
 * 1. Mock @clack/prompts and the agent registry before importing command modules.
 * 2. Use shared machine/runtime fixtures so tests can model first-machine and second-machine flows.
 * 3. Capture log output so divergence tests can assert the absence of false success footers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { CommandDef } from "citty";
import type { SnapshotArtifact } from "../../agents/_utils";
import { loadConfig, resolveConfigPath, writeConfig } from "../../config/loader";
import {
  createAgeIdentity,
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  runGit,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";

const fakeLogs = {
  success: [] as string[],
  info: [] as string[],
  warn: [] as string[],
  error: [] as string[],
};

{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: The fs/promises alias bypasses Bun's shared node:fs/promises mock cache between test files.
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

const { readFile, rm } = createRequire(import.meta.url)(
  "fs/promises",
) as typeof import("node:fs/promises");

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  log: {
    success: (message: string) => {
      fakeLogs.success.push(message);
    },
    info: (message: string) => {
      fakeLogs.info.push(message);
    },
    warn: (message: string) => {
      fakeLogs.warn.push(message);
    },
    error: (message: string) => {
      fakeLogs.error.push(message);
    },
  },
  note: () => {},
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

const fakeArtifacts: SnapshotArtifact[] = [];
const fakeApplyCalls: string[] = [];

type PushMod = typeof import("../../commands/push");
type PullMod = typeof import("../../commands/pull");
type InitMod = typeof import("../../commands/init");
type KeyMod = typeof import("../../commands/key");

let pushMod: PushMod;
let pullMod: PullMod;
let initMod: InitMod;
let keyMod: KeyMod;

const RUNTIME_ENV_KEYS = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"];

async function withMachineEnv<T>(machine: TestMachineFixture, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(RUNTIME_ENV_KEYS.map((key) => [key, process.env[key]]));

  process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
  process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
  process.env.AGENTSYNC_MACHINE = machine.machineName;

  try {
    return await run();
  } finally {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function createDivergentMachinePair(rootDir: string): Promise<{
  machineA: TestMachineFixture;
  machineB: TestMachineFixture;
}> {
  mkdirSync(rootDir, { recursive: true });
  const bareRepoPath = await createBareRepo(rootDir);
  const machineA = await createMachineFixture(rootDir, "machine-a");
  const machineB = await createMachineFixture(rootDir, "machine-b");

  seedVaultRepo({ machine: machineA, bareRepoPath });

  await withMachineEnv(machineB, async () => {
    await initMod.initCommand.run?.({
      args: { remote: bareRepoPath, branch: "main" },
      rawArgs: [],
      cmd: {} as never,
    } as never);
  });

  fakeArtifacts.push({
    vaultPath: "claude/divergence.age",
    sourcePath: "/fake/.claude/divergence.md",
    plaintext: "# remote divergence update",
    warnings: [],
  });

  await withMachineEnv(machineA, async () => {
    await pushMod.performPush({ agent: "claude" });
  });

  fakeArtifacts.length = 0;

  runGit(["config", "user.name", "Agent Sync Test"], machineB.vaultDir);
  runGit(["config", "user.email", "test@agentsync.local"], machineB.vaultDir);
  writeFileSync(join(machineB.vaultDir, "local-only.txt"), "local-only\n", "utf8");
  runGit(["add", "local-only.txt"], machineB.vaultDir);
  runGit(["commit", "-m", "local-only change"], machineB.vaultDir);

  return { machineA, machineB };
}

beforeAll(async () => {
  pushMod = await import("../../commands/push");
  pullMod = await import("../../commands/pull");
  initMod = await import("../../commands/init");
  keyMod = await import("../../commands/key");

  const testAgents = [
    {
      name: "claude" as const,
      snapshot: async () => ({ artifacts: [...fakeArtifacts], warnings: [] }),
      apply: async (vaultDir: string) => {
        fakeApplyCalls.push(vaultDir);
      },
    },
  ];

  pushMod.__setPushAgentsForTesting(testAgents);
  pullMod.__setPullAgentsForTesting(testAgents);
});

describe("integration", () => {
  let tmpDir: string;
  let vaultDir: string;
  let keyPath: string;
  let machine: TestMachineFixture;
  const machineName = "test-machine";
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, machineName);
    vaultDir = machine.vaultDir;
    keyPath = machine.keyPath;

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = vaultDir;
    process.env.AGENTSYNC_KEY_PATH = keyPath;
    process.env.AGENTSYNC_MACHINE = machineName;

    seedVaultRepo({ machine, bareRepoPath });
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    pushMod.__setPushAgentsForTesting(null);
    pullMod.__setPullAgentsForTesting(null);
    await rm(tmpDir, { recursive: true, force: true });
    mock.restore();
  });

  beforeEach(() => {
    fakeArtifacts.length = 0;
    fakeApplyCalls.length = 0;
    fakeLogs.success.length = 0;
    fakeLogs.info.length = 0;
    fakeLogs.warn.length = 0;
    fakeLogs.error.length = 0;
    process.exitCode = 0;
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  test("T038 — init command writes agentsync.toml and key.txt in a fresh vault", async () => {
    const initRoot = join(tmpDir, "init-empty-remote");
    mkdirSync(initRoot, { recursive: true });
    const initBare = await createBareRepo(initRoot);
    const initMachine = await createMachineFixture(initRoot, "init-machine");

    await withMachineEnv(initMachine, async () => {
      await initMod.initCommand.run?.({
        args: { remote: initBare, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(existsSync(initMachine.keyPath)).toBe(true);
    const configContent = await readFile(join(initMachine.vaultDir, "agentsync.toml"), "utf8");
    expect(configContent).toMatch(/recipients/);
    expect(configContent).toMatch(/init-machine/);
    expect(runGit(["rev-parse", "--abbrev-ref", "HEAD"], initMachine.vaultDir)).toBe("main");
  });

  test("init joins an existing remote vault without creating a non-fast-forward local-first history", async () => {
    const root = join(tmpDir, "existing-remote-bootstrap");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machineA = await createMachineFixture(root, "machine-a");
    const machineB = await createMachineFixture(root, "machine-b");

    seedVaultRepo({ machine: machineA, bareRepoPath });

    await withMachineEnv(machineB, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bareRepoPath, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    const configContent = await readFile(join(machineB.vaultDir, "agentsync.toml"), "utf8");
    expect(configContent).toContain("machine-a");
    expect(configContent).toContain("machine-b");
    expect(fakeLogs.error).toHaveLength(0);
    expect(fakeLogs.warn.some((message) => message.includes("non-fast-forward"))).toBe(false);
    expect(runGit(["rev-parse", "HEAD"], machineB.vaultDir)).toBe(
      runGit(["rev-parse", "origin/main"], machineB.vaultDir),
    );
  });

  test("init reports a controlled bootstrap failure when local history already diverged", async () => {
    const root = join(tmpDir, "init-divergence");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machineA = await createMachineFixture(root, "machine-a");
    const machineB = await createMachineFixture(root, "machine-b");

    seedVaultRepo({ machine: machineA, bareRepoPath });

    await writeConfig(resolveConfigPath(machineB.vaultDir), {
      version: "1",
      recipients: { [machineB.machineName]: machineB.recipient },
      agents: {
        cursor: false,
        claude: true,
        codex: false,
        copilot: false,
        vscode: false,
      },
      remote: {
        url: bareRepoPath,
        branch: "main",
      },
      sync: {
        debounceMs: 300,
        autoPush: true,
        autoPull: true,
        pullIntervalMs: 300_000,
      },
    });
    writeFileSync(join(machineB.vaultDir, ".gitignore"), "*.tmp\n", "utf8");
    runGit(["init"], machineB.vaultDir);
    runGit(["symbolic-ref", "HEAD", "refs/heads/main"], machineB.vaultDir);
    runGit(["config", "user.name", "Agent Sync Test"], machineB.vaultDir);
    runGit(["config", "user.email", "test@agentsync.local"], machineB.vaultDir);
    runGit(["remote", "add", "origin", bareRepoPath], machineB.vaultDir);
    runGit(["add", "."], machineB.vaultDir);
    runGit(["commit", "-m", "local-only bootstrap"], machineB.vaultDir);

    await withMachineEnv(machineB, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bareRepoPath, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(process.exitCode).toBe(1);
    expect(
      fakeLogs.error.some((message) =>
        message.includes("AgentSync only supports fast-forward sync"),
      ),
    ).toBe(true);
    expect(fakeLogs.success.some((message) => message.includes("Initialized vault"))).toBe(false);
  });

  test("T039 — performPush encrypts artifact and writes .age file to vault", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/CLAUDE.age",
      sourcePath: "/fake/.claude/CLAUDE.md",
      plaintext: "# Integration test rules",
      warnings: [],
    });

    const result = await pushMod.performPush({ agent: "claude" });

    expect(result.fatal).toBe(false);
    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const ageFile = join(vaultDir, "claude", "CLAUDE.age");
    expect(existsSync(ageFile)).toBe(true);

    const content = await readFile(ageFile, "utf8");
    expect(content).toContain("BEGIN AGE ENCRYPTED FILE");
  });

  test("T040 — performPull calls agent.apply for each enabled agent", async () => {
    const result = await pullMod.performPull({ agent: "claude" });

    expect(result.fatal).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);
    expect(fakeApplyCalls).toContain(vaultDir);
  });

  test("T052 — performPush aborts when an artifact warning contains 'Redacted literal secret'", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/settings.age",
      sourcePath: "/fake/.claude/settings.json",
      plaintext: '{"apiKey":"[REDACTED]"}',
      warnings: ["Redacted literal secret for field apiKey"],
    });

    const result = await pushMod.performPush({ agent: "claude" });

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Push aborted/);
    expect(result.errors.some((message) => message.includes("Redacted literal secret"))).toBe(true);
  });

  test("T041 — status command runs without throwing", async () => {
    const statusMod = await import("../../commands/status");
    await statusMod.statusCommand.run?.({
      args: { verbose: false },
      rawArgs: [],
      cmd: {} as never,
    } as never);
  });

  test("T042 — doctor command runs without throwing", async () => {
    const doctorMod = await import("../../commands/doctor");
    await doctorMod.doctorCommand.run?.({
      args: {},
      rawArgs: [],
      cmd: {} as never,
    } as never);
  });

  test("T043 — key add appends recipient to config and re-encrypts vault files", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/CLAUDE.age",
      sourcePath: "/fake/.claude/CLAUDE.md",
      plaintext: "# key-add test",
      warnings: [],
    });
    await pushMod.performPush({ agent: "claude" });
    fakeArtifacts.length = 0;

    const { recipient: newRecipient } = await createAgeIdentity();

    await (keyMod.keyCommand.subCommands as unknown as Record<string, CommandDef>).add.run?.({
      args: { name: "work-laptop", pubkey: newRecipient },
      rawArgs: [],
      cmd: {} as never,
    } as never);

    const configContent = await readFile(join(vaultDir, "agentsync.toml"), "utf8");
    expect(configContent).toContain("work-laptop");
    expect(configContent).toContain(newRecipient);

    const ageFile = join(vaultDir, "claude", "CLAUDE.age");
    expect(existsSync(ageFile)).toBe(true);
    const content = await readFile(ageFile, "utf8");
    expect(content).toContain("BEGIN AGE ENCRYPTED FILE");
  });

  test("key add re-checks aliases after reconciling with a newer remote config", async () => {
    const root = join(tmpDir, "key-add-reconcile");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machineA = await createMachineFixture(root, "machine-a");
    const machineB = await createMachineFixture(root, "machine-b");
    const { recipient: remoteRecipient } = await createAgeIdentity();
    const { recipient: conflictingRecipient } = await createAgeIdentity();

    seedVaultRepo({ machine: machineA, bareRepoPath });

    await withMachineEnv(machineB, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bareRepoPath, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    runGit(["pull", "--ff-only", "origin", "main"], machineA.vaultDir);

    const machineAConfigPath = resolveConfigPath(machineA.vaultDir);
    const machineAConfig = await loadConfig(machineAConfigPath);
    machineAConfig.recipients["work-laptop"] = remoteRecipient;
    await writeConfig(machineAConfigPath, machineAConfig);
    runGit(["add", "agentsync.toml"], machineA.vaultDir);
    runGit(["commit", "-m", "add work-laptop recipient"], machineA.vaultDir);
    runGit(["push", "origin", "main"], machineA.vaultDir);

    fakeLogs.error.length = 0;
    process.exitCode = 0;

    await withMachineEnv(machineB, async () => {
      await (keyMod.keyCommand.subCommands as unknown as Record<string, CommandDef>).add.run?.({
        args: { name: "work-laptop", pubkey: conflictingRecipient },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(process.exitCode).toBe(1);
    expect(
      fakeLogs.error.some((message) => message.includes("Recipient 'work-laptop' already exists")),
    ).toBe(true);

    const machineBConfig = await loadConfig(resolveConfigPath(machineB.vaultDir));
    expect(machineBConfig.recipients["work-laptop"]).toBe(remoteRecipient);
  });

  test("T044 — key rotate replaces private key and updates config recipient", async () => {
    const oldKeyContent = await readFile(keyPath, "utf8");

    await (keyMod.keyCommand.subCommands as unknown as Record<string, CommandDef>).rotate.run?.({
      args: {},
      rawArgs: [],
      cmd: {} as never,
    } as never);

    const newKeyContent = await readFile(keyPath, "utf8");
    expect(newKeyContent.trim()).not.toBe(oldKeyContent.trim());
    expect(newKeyContent.trim()).toMatch(/^AGE-SECRET-KEY-/);

    const configContent = await readFile(join(vaultDir, "agentsync.toml"), "utf8");
    expect(configContent).toMatch(/test-machine/);
  });

  test("key rotate leaves config and key unchanged when re-encryption fails", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/CLAUDE.age",
      sourcePath: "/fake/.claude/CLAUDE.md",
      plaintext: "# rotate failure test",
      warnings: [],
    });
    await pushMod.performPush({ agent: "claude" });
    fakeArtifacts.length = 0;

    const configPath = resolveConfigPath(vaultDir);
    const configBefore = await loadConfig(configPath);
    const oldKeyContent = await readFile(keyPath, "utf8");

    writeFileSync(join(vaultDir, "claude", "broken.age"), "not a valid age payload", "utf8");
    fakeLogs.error.length = 0;
    process.exitCode = 0;

    await (keyMod.keyCommand.subCommands as unknown as Record<string, CommandDef>).rotate.run?.({
      args: {},
      rawArgs: [],
      cmd: {} as never,
    } as never);

    expect(process.exitCode).toBe(1);
    expect(fakeLogs.error.length).toBeGreaterThan(0);
    expect(await readFile(keyPath, "utf8")).toBe(oldKeyContent);

    const configAfter = await loadConfig(configPath);
    expect(configAfter.recipients[machineName]).toBe(configBefore.recipients[machineName]);
  });

  test("pushCommand.run with dryRun=true does not write vault files", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/dry-cli.age",
      sourcePath: "/fake/.claude/dry-cli.md",
      plaintext: "# dry run via CLI",
      warnings: [],
    });

    await pushMod.pushCommand.run?.({
      args: { agent: "claude", dryRun: true, message: undefined },
      rawArgs: [],
      cmd: {} as never,
    } as never);

    expect(existsSync(join(vaultDir, "claude", "dry-cli.age"))).toBe(false);
  });

  test("pushCommand.run without dryRun encrypts and pushes artifacts", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/cli-push.age",
      sourcePath: "/fake/.claude/cli-push.md",
      plaintext: "# pushed via CLI",
      warnings: [],
    });

    await pushMod.pushCommand.run?.({
      args: { agent: "claude", dryRun: false, message: undefined },
      rawArgs: [],
      cmd: {} as never,
    } as never);

    expect(existsSync(join(vaultDir, "claude", "cli-push.age"))).toBe(true);
  });

  test("performPush returns early when no agents match requested name", async () => {
    const result = await pushMod.performPush({ agent: "nonexistent-agent" });
    expect(result.pushed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.fatal).toBe(false);
  });

  test("pull reports a controlled divergence error and suppresses the success footer", async () => {
    const { machineB } = await createDivergentMachinePair(join(tmpDir, "pull-divergence"));
    fakeLogs.success.length = 0;
    fakeLogs.info.length = 0;
    fakeLogs.warn.length = 0;
    fakeLogs.error.length = 0;

    await withMachineEnv(machineB, async () => {
      await pullMod.pullCommand.run?.({
        args: { agent: undefined, dryRun: false, force: false },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(process.exitCode).toBe(1);
    expect(
      fakeLogs.error.some((message) =>
        message.includes("AgentSync only supports fast-forward sync"),
      ),
    ).toBe(true);
    expect(fakeLogs.success.some((message) => message.includes("Pull completed"))).toBe(false);
    expect(fakeApplyCalls).toHaveLength(0);
  });

  test("performPush inherits the shared divergence policy before writing vault artifacts", async () => {
    const { machineB } = await createDivergentMachinePair(join(tmpDir, "push-divergence"));

    fakeArtifacts.push({
      vaultPath: "claude/blocked.age",
      sourcePath: "/fake/.claude/blocked.md",
      plaintext: "# blocked by divergence",
      warnings: [],
    });

    const result = await withMachineEnv(machineB, async () =>
      pushMod.performPush({ agent: "claude" }),
    );

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(
      result.errors.some((message) =>
        message.includes("AgentSync only supports fast-forward sync"),
      ),
    ).toBe(true);
    expect(existsSync(join(machineB.vaultDir, "claude", "blocked.age"))).toBe(false);
  });
});
