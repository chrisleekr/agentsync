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

// ─── T026 — agent-skills-sync integration guarantees ─────────────────────────
//
// These tests run AFTER the main `describe("integration")` block above, so its
// `afterAll` has already reset the push/pull agent registries to the real
// `Agents` list. We therefore exercise the REAL Claude adapter (and its
// walker wiring) rather than the mocked test-only fake used above.

describe("T026 — skills sync integration guarantees", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  type MutableClaudePaths = {
    claudeMd: string;
    settingsJson: string;
    commandsDir: string;
    agentsDir: string;
    mcpJson: string;
    credentials: string;
    skillsDir: string;
  };
  // Lazy reference — `AgentPaths` is imported inside each test via dynamic
  // import to avoid colliding with the module-scoped mocks at file top.
  let mutableClaudePaths: MutableClaudePaths;
  const savedClaude: Partial<MutableClaudePaths> = {};
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    const paths = await import("../../config/paths");
    mutableClaudePaths = paths.AgentPaths.claude as MutableClaudePaths;
    savedClaude.claudeMd = mutableClaudePaths.claudeMd;
    savedClaude.settingsJson = mutableClaudePaths.settingsJson;
    savedClaude.commandsDir = mutableClaudePaths.commandsDir;
    savedClaude.agentsDir = mutableClaudePaths.agentsDir;
    savedClaude.mcpJson = mutableClaudePaths.mcpJson;
    savedClaude.credentials = mutableClaudePaths.credentials;
    savedClaude.skillsDir = mutableClaudePaths.skillsDir;

    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "skills-integration");

    const claudeHome = join(tmpDir, "claude-home");
    mutableClaudePaths.claudeMd = join(claudeHome, "CLAUDE.md");
    mutableClaudePaths.settingsJson = join(claudeHome, "settings.json");
    mutableClaudePaths.commandsDir = join(claudeHome, "commands");
    mutableClaudePaths.agentsDir = join(claudeHome, "agents");
    mutableClaudePaths.mcpJson = join(claudeHome, ".claude.json");
    mutableClaudePaths.credentials = join(claudeHome, ".credentials.json");
    mutableClaudePaths.skillsDir = join(claudeHome, "skills");

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;

    seedVaultRepo({
      machine,
      bareRepoPath,
      agents: { claude: true, copilot: false },
    });

    fakeLogs.success.length = 0;
    fakeLogs.info.length = 0;
    fakeLogs.warn.length = 0;
    fakeLogs.error.length = 0;
    process.exitCode = 0;
  });

  afterEach(async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (savedClaude.claudeMd !== undefined) {
      mutableClaudePaths.claudeMd = savedClaude.claudeMd;
      // biome-ignore lint/style/noNonNullAssertion: snapshot written in beforeEach
      mutableClaudePaths.settingsJson = savedClaude.settingsJson!;
      // biome-ignore lint/style/noNonNullAssertion: snapshot written in beforeEach
      mutableClaudePaths.commandsDir = savedClaude.commandsDir!;
      // biome-ignore lint/style/noNonNullAssertion: snapshot written in beforeEach
      mutableClaudePaths.agentsDir = savedClaude.agentsDir!;
      // biome-ignore lint/style/noNonNullAssertion: snapshot written in beforeEach
      mutableClaudePaths.mcpJson = savedClaude.mcpJson!;
      // biome-ignore lint/style/noNonNullAssertion: snapshot written in beforeEach
      mutableClaudePaths.credentials = savedClaude.credentials!;
      // biome-ignore lint/style/noNonNullAssertion: snapshot written in beforeEach
      mutableClaudePaths.skillsDir = savedClaude.skillsDir!;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  // FR-013 — pull-side no-delete guarantee.
  //
  // This test proves that deleting a skill artifact from the vault (as the
  // `skill remove` verb does) followed by a `pull` on another machine DOES
  // NOT delete the local skill directory. The `applyXxxVault` functions are
  // additive-only by construction — they only call `extractArchive`, never
  // `unlink` — so any future regression that adds a local-delete sweep will
  // fail this test.

  test("FR-013 — applyClaudeVault does not delete a local skill when the vault artifact is gone", async () => {
    const { mkdir: mkdirAsync, writeFile: writeFileAsync } = await import("node:fs/promises");
    const { archiveDirectory } = await import("../../core/tar");
    const { encryptString, generateIdentity, identityToRecipient } = await import(
      "../../core/encryptor"
    );
    const claude = await import("../../agents/claude");

    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    // Build a real skill and encrypt it into the vault.
    const srcSkill = join(tmpDir, "src", "my-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# my skill body", "utf8");
    writeFileSync(join(srcSkill, "notes.md"), "# notes", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const skillsVaultDir = join(machine.vaultDir, "claude", "skills");
    await mkdirAsync(skillsVaultDir, { recursive: true });
    const vaultFile = join(skillsVaultDir, "my-skill.tar.age");
    await writeFileAsync(vaultFile, encrypted, "utf8");

    // First pull: populates the local ~/.claude/skills/my-skill/ directory.
    await claude.applyClaudeVault(machine.vaultDir, identity, false);

    const localSkillDir = join(mutableClaudePaths.skillsDir, "my-skill");
    expect(existsSync(join(localSkillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(localSkillDir, "notes.md"))).toBe(true);

    // Simulate a post-`skill remove` vault — the artifact is gone from disk.
    const { unlink: unlinkAsync } = await import("node:fs/promises");
    await unlinkAsync(vaultFile);

    // Second pull against the now-empty vault. FR-013 says the local skill
    // directory MUST remain intact — no file is added, no file is removed.
    await claude.applyClaudeVault(machine.vaultDir, identity, false);

    expect(existsSync(join(localSkillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(localSkillDir, "notes.md"))).toBe(true);
    // And the content must be byte-equal to the original — no overwrite either.
    const { readFile: readFileAsync } = await import("node:fs/promises");
    const skillBody = await readFileAsync(join(localSkillDir, "SKILL.md"), "utf8");
    expect(skillBody).toBe("# my skill body");
  });

  // SC-009 — negative-space vault content check.
  //
  // Builds a real ~/.claude/skills/ containing one valid skill plus a
  // top-level symlink that points into a vendored-pool directory containing
  // a secret marker. Runs the REAL `performPush` (registry reset to the real
  // Agents) and decrypts every written artifact to verify that no entry
  // contains the vendored path OR the secret marker content. This is the
  // walker's outermost safety guarantee — SC-009 fails iff FR-016's
  // root-symlink rejection rule is bypassed.

  test("SC-009 — vault never contains vendored-pool content reached through a symlinked skill root", async () => {
    // Build the vendored pool outside the skills directory.
    const vendoredPool = join(tmpDir, "vendored-pool", "sensitive-skill");
    mkdirSync(vendoredPool, { recursive: true });
    writeFileSync(join(vendoredPool, "SKILL.md"), "# vendored vendor", "utf8");
    writeFileSync(join(vendoredPool, "secret-marker.md"), "THIS_MUST_NOT_LEAK", "utf8");

    // Build the local skills directory with:
    //   - one real skill (must be archived normally)
    //   - one top-level symlink pointing at the vendored pool (must be dropped)
    mkdirSync(mutableClaudePaths.skillsDir, { recursive: true });
    const realSkill = join(mutableClaudePaths.skillsDir, "my-skill");
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(join(realSkill, "SKILL.md"), "# real skill", "utf8");

    const { symlinkSync } = await import("node:fs");
    symlinkSync(vendoredPool, join(mutableClaudePaths.skillsDir, "vendored"));

    // Ensure the push registry is the REAL Agents so we exercise the real
    // Claude adapter + walker path.
    pushMod.__setPushAgentsForTesting(null);

    const result = await pushMod.performPush({ agent: "claude" });
    expect(result.fatal).toBe(false);
    // At least one artifact should have been written — the real `my-skill`.
    expect(result.pushed).toBeGreaterThanOrEqual(1);

    // Assertion 1: no vendored.tar.age artifact was written.
    const skillsVaultDir = join(machine.vaultDir, "claude", "skills");
    expect(existsSync(join(skillsVaultDir, "vendored.tar.age"))).toBe(false);

    // Assertion 2: decrypt every .tar.age in claude/skills/, extract it to a
    // tmp dir, and walk every file entry. Nothing may mention the vendored
    // path or contain the secret marker string.
    const { readdir: readdirAsync, readFile: readFileAsync } = await import("node:fs/promises");
    const { decryptString } = await import("../../core/encryptor");
    const { extractArchive } = await import("../../core/tar");

    const vaultEntries = await readdirAsync(skillsVaultDir);
    const tarAgeEntries = vaultEntries.filter((n) => n.endsWith(".tar.age"));
    expect(tarAgeEntries.length).toBeGreaterThanOrEqual(1);

    for (const entry of tarAgeEntries) {
      const encrypted = await readFileAsync(join(skillsVaultDir, entry), "utf8");
      const base64 = await decryptString(encrypted, machine.identity);
      const tarBuf = Buffer.from(base64, "base64");

      const extractRoot = join(tmpDir, `extract-${entry}`);
      mkdirSync(extractRoot, { recursive: true });
      await extractArchive(tarBuf, extractRoot);

      // Recursively walk the extracted tree and collect file paths + contents.
      async function walk(dir: string): Promise<{ path: string; content: string }[]> {
        const out: { path: string; content: string }[] = [];
        for (const name of await readdirAsync(dir)) {
          const full = join(dir, name);
          const { stat: statAsync } = await import("node:fs/promises");
          const info = await statAsync(full);
          if (info.isDirectory()) {
            out.push(...(await walk(full)));
          } else if (info.isFile()) {
            out.push({ path: full, content: await readFileAsync(full, "utf8") });
          }
        }
        return out;
      }

      const files = await walk(extractRoot);
      for (const file of files) {
        expect(file.path).not.toContain("vendored");
        expect(file.path).not.toContain("sensitive-skill");
        expect(file.path).not.toContain("secret-marker");
        expect(file.content).not.toContain("THIS_MUST_NOT_LEAK");
      }
    }
  });
});
