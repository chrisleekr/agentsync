/**
 * Integration tests — end-to-end command coverage.
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
import { loadConfig, peekVaultVersion, resolveConfigPath, writeConfig } from "../../config/loader";
import { machineVaultRoot } from "../../config/paths";
import { CURRENT_VAULT_VERSION } from "../../config/schema";
import {
  createAgeIdentity,
  createBareRepo,
  createMachineFixture,
  createTestAgentSyncConfig,
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

const RUNTIME_ENV_KEYS = [
  "AGENTSYNC_VAULT_DIR",
  "AGENTSYNC_KEY_PATH",
  "AGENTSYNC_MACHINE",
  "AGENTSYNC_MACHINE_FILE",
];

async function withMachineEnv<T>(machine: TestMachineFixture, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(RUNTIME_ENV_KEYS.map((key) => [key, process.env[key]]));

  process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
  process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
  process.env.AGENTSYNC_MACHINE = machine.machineName;
  process.env.AGENTSYNC_MACHINE_FILE = machine.machineFilePath;

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
  // v2: this machine's artifacts live under machines/<machineName>/ in the vault.
  let machineRoot: string;
  let keyPath: string;
  let machine: TestMachineFixture;
  const machineName = "test-machine";
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, machineName);
    vaultDir = machine.vaultDir;
    machineRoot = machineVaultRoot(vaultDir, machineName);
    keyPath = machine.keyPath;

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = vaultDir;
    process.env.AGENTSYNC_KEY_PATH = keyPath;
    process.env.AGENTSYNC_MACHINE = machineName;
    process.env.AGENTSYNC_MACHINE_FILE = machine.machineFilePath;

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

  test("init command writes agentsync.toml and key.txt in a fresh vault", async () => {
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
    // v2: a fresh init writes the integer version, not the legacy string "1".
    expect(await peekVaultVersion(resolveConfigPath(initMachine.vaultDir))).toEqual({ kind: "v2" });
    expect(runGit(["rev-parse", "--abbrev-ref", "HEAD"], initMachine.vaultDir)).toBe("main");

    // init pins the resolved machine name to local state (outside the vault) so
    // a later hostname change cannot re-derive a different namespace.
    expect(existsSync(initMachine.machineFilePath)).toBe(true);
    expect((await readFile(initMachine.machineFilePath, "utf8")).trim()).toBe("init-machine");
  });

  test("a hostname change after init does not change the resolved machine name", async () => {
    const initRoot = join(tmpDir, "init-host-rename");
    mkdirSync(initRoot, { recursive: true });
    const initBare = await createBareRepo(initRoot);
    const initMachine = await createMachineFixture(initRoot, "pinned-host");

    await withMachineEnv(initMachine, async () => {
      await initMod.initCommand.run?.({
        args: { remote: initBare, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);

      // Simulate a host rename: drop AGENTSYNC_MACHINE so resolution would fall
      // through to HOSTNAME/os.hostname() if the pin were not honored.
      const prevMachine = process.env.AGENTSYNC_MACHINE;
      const prevHostname = process.env.HOSTNAME;
      delete process.env.AGENTSYNC_MACHINE;
      process.env.HOSTNAME = "renamed-host";
      try {
        const { resolveRuntimeContext } = await import("../../commands/shared");
        const ctx = await resolveRuntimeContext();
        expect(ctx.machineName).toBe("pinned-host");
      } finally {
        if (prevMachine === undefined) delete process.env.AGENTSYNC_MACHINE;
        else process.env.AGENTSYNC_MACHINE = prevMachine;
        if (prevHostname === undefined) delete process.env.HOSTNAME;
        else process.env.HOSTNAME = prevHostname;
      }
    });
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

  test("init prints the recipient-onboarding hint when joining a vault as a new machine", async () => {
    const root = join(tmpDir, "recipient-handoff-hint");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machineA = await createMachineFixture(root, "machine-alpha");
    const machineB = await createMachineFixture(root, "machine-beta");

    seedVaultRepo({ machine: machineA, bareRepoPath });

    await withMachineEnv(machineB, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bareRepoPath, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    // The init flow should warn the new joiner that they cannot pull until an
    // existing recipient runs `key add` for them. The message must include
    // both the local machine name and its pubkey so it is copy-pasteable.
    const hint = fakeLogs.warn.find((message) =>
      message.includes("agentsync key add machine-beta"),
    );
    expect(hint).toBeDefined();
    expect(hint).toContain(machineB.recipient);
    expect(hint).toContain("`agentsync pull` on this machine will fail");
  });

  test("recipient handoff: init + key add (idempotent on same pubkey) re-encrypts vault for new machine", async () => {
    const root = join(tmpDir, "recipient-handoff-end-to-end");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machineA = await createMachineFixture(root, "machine-alpha");
    const machineB = await createMachineFixture(root, "machine-beta");

    seedVaultRepo({ machine: machineA, bareRepoPath });

    // machineA pushes a real .age artifact encrypted ONLY for itself, so the
    // resulting file is the exact thing machineB cannot read post-init.
    const { encryptString, decryptString } = await import("../../core/encryptor");
    const {
      mkdir: mkdirAsync,
      writeFile: writeFileAsync,
      readFile: readFileAsync,
    } = await import("node:fs/promises");

    const machineAClaudeDir = join(machineA.vaultDir, "claude");
    await mkdirAsync(machineAClaudeDir, { recursive: true });
    const plaintext = "# handoff-secret\nbody\n";
    const onlyAlphaCiphertext = await encryptString(plaintext, [machineA.recipient]);
    await writeFileAsync(join(machineAClaudeDir, "HANDOFF.age"), onlyAlphaCiphertext, "utf8");
    runGit(["add", "claude/HANDOFF.age"], machineA.vaultDir);
    runGit(["commit", "-m", "seed: artifact for machine-alpha only"], machineA.vaultDir);
    runGit(["push", "origin", "main"], machineA.vaultDir);

    // machineB joins. init writes its pubkey into recipients and pushes.
    await withMachineEnv(machineB, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bareRepoPath, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    // machineA runs the exact command the onboarding hint suggests. After
    // init, recipients["machine-beta"] already equals machineB.recipient, so
    // a non-idempotent `key add` would fail with "already exists" here.
    // The vault re-encryption is the whole point of this step.
    runGit(["pull", "--ff-only", "origin", "main"], machineA.vaultDir);
    fakeLogs.error.length = 0;
    process.exitCode = 0;

    await withMachineEnv(machineA, async () => {
      await (keyMod.keyCommand.subCommands as unknown as Record<string, CommandDef>).add.run?.({
        args: { name: "machine-beta", pubkey: machineB.recipient },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(process.exitCode).toBe(0);
    expect(fakeLogs.error).toHaveLength(0);

    // The artifact must now be decryptable by machineB's identity. Push the
    // re-encrypted commit through, fetch on machineB, and decrypt directly.
    runGit(["pull", "--ff-only", "origin", "main"], machineB.vaultDir);
    const reEncrypted = await readFileAsync(
      join(machineB.vaultDir, "claude", "HANDOFF.age"),
      "utf8",
    );
    const decrypted = await decryptString(reEncrypted, machineB.identity);
    expect(decrypted).toBe(plaintext);
  });

  test("init does NOT print the recipient-onboarding hint on a fresh first-machine bootstrap", async () => {
    const root = join(tmpDir, "first-machine-no-hint");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const firstMachine = await createMachineFixture(root, "first-machine");

    await withMachineEnv(firstMachine, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bareRepoPath, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    // Pin to the canonical lead phrase of the init hint (see src/commands/init.ts)
    // so reworded variants like "key set" / "recipient add" still fall through to
    // the negative assertion and don't silently bypass it.
    expect(
      fakeLogs.warn.some((message) =>
        message.includes("This machine is registered but cannot decrypt"),
      ),
    ).toBe(false);
    expect(fakeLogs.warn.some((message) => message.includes("agentsync key add"))).toBe(false);
  });

  test("init reports a controlled bootstrap failure when local history already diverged", async () => {
    const root = join(tmpDir, "init-divergence");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machineA = await createMachineFixture(root, "machine-a");
    const machineB = await createMachineFixture(root, "machine-b");

    seedVaultRepo({ machine: machineA, bareRepoPath });

    await writeConfig(resolveConfigPath(machineB.vaultDir), {
      version: CURRENT_VAULT_VERSION,
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
      },
      claudePlugins: { syncMarketplace: false },
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

  test("init against an unreachable remote leaves no key.txt and no vault artifacts", async () => {
    const root = join(tmpDir, "init-unreachable-remote");
    mkdirSync(root, { recursive: true });
    const machine = await createMachineFixture(root, "init-unreachable-machine");
    // createMachineFixture pre-seeds a key.txt and a vaultDir so that other
    // tests can model "machine that has already run init once". For this test
    // we want the first-init case, so remove both before invoking init — and
    // then assert that init's failure path does NOT recreate the vault dir.
    await rm(machine.keyPath, { force: true });
    await rm(machine.vaultDir, { recursive: true, force: true });

    const bogusRemote = join(root, "nonexistent-remote.git");

    await withMachineEnv(machine, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bogusRemote, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(process.exitCode).toBe(1);
    // An unreachable remote must abort BEFORE any local artifact is written.
    // No key.txt, no agentsync.toml, AND no vault dir on disk — otherwise a
    // retry against a different URL silently inherits an orphan key or an
    // empty vault dir bound to no completed init.
    expect(existsSync(machine.keyPath)).toBe(false);
    expect(existsSync(machine.vaultDir)).toBe(false);
    expect(existsSync(join(machine.vaultDir, "agentsync.toml"))).toBe(false);
    expect(fakeLogs.error.length).toBeGreaterThan(0);
    expect(fakeLogs.success.some((message) => message.includes("Initialized vault"))).toBe(false);
  });

  test("init failure against an unreachable remote preserves a pre-existing keypair", async () => {
    const root = join(tmpDir, "init-preserves-existing-key");
    mkdirSync(root, { recursive: true });
    // createMachineFixture writes a key.txt with a fresh identity. That key
    // stands in for one a previous successful init committed to.
    const machine = await createMachineFixture(root, "init-preserve-machine");
    const bogusRemote = join(root, "nonexistent-remote.git");

    const originalKeyContents = await readFile(machine.keyPath, "utf8");

    await withMachineEnv(machine, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bogusRemote, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(process.exitCode).toBe(1);
    expect(existsSync(machine.keyPath)).toBe(true);
    // A pre-existing key must be byte-for-byte unchanged. Rolling it back
    // would destroy the only copy of the user's age private key.
    const afterKeyContents = await readFile(machine.keyPath, "utf8");
    expect(afterKeyContents).toBe(originalKeyContents);
  });

  test("init preserves an unreadable key.txt instead of overwriting it", async () => {
    const root = join(tmpDir, "init-preserves-unreadable-key");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machine = await createMachineFixture(root, "init-unreadable-key");
    // Replace the seeded key.txt with a directory at the same path. readFile
    // throws EISDIR (not ENOENT), which previously fell through the bare catch
    // and silently overwrote the path with a freshly generated key — a
    // destructive outcome for any non-missing key file (locked permissions,
    // corrupt prior write, mount issue).
    await rm(machine.keyPath, { force: true });
    mkdirSync(machine.keyPath);

    await withMachineEnv(machine, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bareRepoPath, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(process.exitCode).toBe(1);
    // The directory at key.txt must still be a directory — never replaced
    // with a regenerated identity file. This is the invariant the fix exists
    // to protect: only ENOENT means "no key", everything else must surface.
    expect(existsSync(machine.keyPath)).toBe(true);
    const { statSync } = createRequire(import.meta.url)("fs") as typeof import("node:fs");
    expect(statSync(machine.keyPath).isDirectory()).toBe(true);
  });

  test("init failure inside ensureKeypair writeFile leaves no orphan key.txt", async () => {
    const root = join(tmpDir, "init-writefile-failure");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machine = await createMachineFixture(root, "init-writefile-machine");
    // Remove the seeded key.txt so init takes the generate-and-write path.
    await rm(machine.keyPath, { force: true });

    // Point the key path under a parent directory that does not exist. init's
    // mkdir creates `vaultDir` (recursive: true) but not the key.txt parent,
    // so writeFile inside ensureKeypair will reject AFTER the remote probe
    // succeeds. The cleanup contract is that any failure mid-generate-and-
    // write must leave no orphan key.txt at the target path — otherwise a
    // retry could silently inherit a partial-written key as "existing".
    const orphanKeyPath = join(root, "missing-parent-dir", "key.txt");

    await withMachineEnv({ ...machine, keyPath: orphanKeyPath }, async () => {
      await initMod.initCommand.run?.({
        args: { remote: bareRepoPath, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);
    });

    expect(process.exitCode).toBe(1);
    // No orphan key at the target. force: true in the cleanup catches
    // ENOENT for the case where writeFile failed before any bytes hit disk,
    // and removes partial bytes when writeFile rejected mid-write.
    expect(existsSync(orphanKeyPath)).toBe(false);
    // The "back up your private key now" warn must NOT fire when init
    // never actually committed to the key — otherwise the user would copy
    // a key that is about to be (or has just been) cleaned up.
    expect(fakeLogs.warn.some((message) => message.includes("New age keypair generated"))).toBe(
      false,
    );
    expect(fakeLogs.error.length).toBeGreaterThan(0);
  });

  test("init failure after a successful remote probe cleans up a freshly generated key.txt", async () => {
    const root = join(tmpDir, "init-divergence-rollback");
    mkdirSync(root, { recursive: true });
    const bareRepoPath = await createBareRepo(root);
    const machineA = await createMachineFixture(root, "machine-a");
    const machineB = await createMachineFixture(root, "machine-b");
    // Remove machineB's pre-seeded key so init must generate a fresh one
    // during this run. That makes this run the "isNew = true" path and lets
    // the assertion below distinguish "rolled back" from "never written".
    await rm(machineB.keyPath, { force: true });

    seedVaultRepo({ machine: machineA, bareRepoPath });

    await writeConfig(resolveConfigPath(machineB.vaultDir), {
      version: CURRENT_VAULT_VERSION,
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
      },
      claudePlugins: { syncMarketplace: false },
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
    // The remote probe succeeded (so a key was generated), but the
    // post-probe reconcile step failed. The key must be cleaned up so a
    // retry does not silently reuse material from a never-completed init.
    expect(existsSync(machineB.keyPath)).toBe(false);
  });

  test("performPush encrypts artifact and writes .age file to vault", async () => {
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

    const ageFile = join(machineRoot, "claude", "CLAUDE.age");
    expect(existsSync(ageFile)).toBe(true);

    const content = await readFile(ageFile, "utf8");
    expect(content).toContain("BEGIN AGE ENCRYPTED FILE");
  });

  test("performPull calls agent.apply for each enabled agent", async () => {
    const result = await pullMod.performPull({ agent: "claude" });

    expect(result.fatal).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);
    // v2: pull applies from this machine's namespace, not the flat vault root.
    expect(fakeApplyCalls).toContain(machineRoot);
  });

  test("performPush aborts when an artifact warning contains 'Detected literal secret'", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/settings.age",
      sourcePath: "/fake/.claude/settings.json",
      plaintext: '{"apiKey":"[REDACTED]"}',
      warnings: ["Detected literal secret for field apiKey"],
    });

    const result = await pushMod.performPush({ agent: "claude" });

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Push aborted/);
    expect(result.errors.some((message) => message.includes("Detected literal secret"))).toBe(true);
  });

  test("performPush does NOT double-report when a redactor warning lands on both artifact.warnings and snapshot.warnings", async () => {
    // Real adapters (sanitizeClaudeHooks / sanitizeClaudeMcp / plugin manifest)
    // push the `Detected literal secret for field X` warning onto BOTH the
    // artifact (via collect()) AND the top-level snapshot.warnings (see
    // src/agents/claude.ts:54). The Phase-1 artifact loop and the walker-
    // warning loop must not both fire on the same warning, or one secret would
    // produce two entries in the abort banner. Walker hits use the
    // `Detected literal secret (<name>) in …` shape; redactor hits use
    // `Detected literal secret for field <name>` — the snapshot-level prefix
    // matches the walker shape only.
    const duplicatedWarning = "Detected literal secret for field apiKey";
    const dualSnapshotAgent = [
      {
        name: "claude" as const,
        snapshot: async () => ({
          artifacts: [
            {
              vaultPath: "claude/settings.age",
              sourcePath: "/fake/.claude/settings.json",
              plaintext: '{"apiKey":"[REDACTED]"}',
              warnings: [duplicatedWarning],
            },
          ],
          warnings: [duplicatedWarning],
        }),
        apply: async () => {},
      },
    ];

    pushMod.__setPushAgentsForTesting(dualSnapshotAgent);
    try {
      const result = await pushMod.performPush({ agent: "claude" });

      expect(result.fatal).toBe(true);
      expect(result.pushed).toBe(0);
      const literalSecretEntries = result.errors.filter((e) => e.includes(duplicatedWarning));
      expect(literalSecretEntries.length).toBe(1);
      // The banner's count must match the distinct-issue count, not 2× it.
      // Exact substring (not a loose regex): `/1 security issue/` would also
      // pass for `11`, `21`, … if a future regression bumped the count.
      expect(result.errors[0]).toContain("1 security issue(s)");
    } finally {
      pushMod.__setPushAgentsForTesting([
        {
          name: "claude" as const,
          snapshot: async () => ({ artifacts: [...fakeArtifacts], warnings: [] }),
          apply: async (vaultDir: string) => {
            fakeApplyCalls.push(vaultDir);
          },
        },
      ]);
    }
  });

  test("status command runs without throwing", async () => {
    const statusMod = await import("../../commands/status");
    await statusMod.statusCommand.run?.({
      args: { verbose: false },
      rawArgs: [],
      cmd: {} as never,
    } as never);
  });

  test("doctor command runs without throwing", async () => {
    const doctorMod = await import("../../commands/doctor");
    await doctorMod.doctorCommand.run?.({
      args: {},
      rawArgs: [],
      cmd: {} as never,
    } as never);
  });

  test("key add appends recipient to config and re-encrypts vault files", async () => {
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

    const ageFile = join(machineRoot, "claude", "CLAUDE.age");
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

  test("key rotate replaces private key and updates config recipient", async () => {
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

    writeFileSync(join(machineRoot, "claude", "broken.age"), "not a valid age payload", "utf8");
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

    expect(existsSync(join(machineRoot, "claude", "dry-cli.age"))).toBe(false);
  });

  test("pushCommand.run with dryRun=true aborts when an artifact warning reports a literal secret", async () => {
    // Dry-run is the canonical pre-flight gate. If it ever lets a literal
    // credential through, users (and CI) will rely on it as a safe preview
    // only to be surprised by a fatal on the real push. The CLI dry-run
    // path must run the same Phase 1 abort that the non-dry-run path does.
    fakeArtifacts.length = 0;
    fakeArtifacts.push({
      vaultPath: "claude/leaky-cli.age",
      sourcePath: "/fake/.claude/leaky-cli.md",
      plaintext: "# clean prompt body",
      warnings: ["Detected literal secret for field anthropic_api_key in /fake/.claude/leaky.json"],
    });
    fakeLogs.error.length = 0;
    fakeLogs.info.length = 0;
    process.exitCode = 0;

    await pushMod.pushCommand.run?.({
      args: { agent: "claude", dryRun: true, message: undefined },
      rawArgs: [],
      cmd: {} as never,
    } as never);

    expect(process.exitCode).toBe(1);
    expect(fakeLogs.error.some((message) => message.startsWith("Push aborted"))).toBe(true);
    expect(fakeLogs.error.some((message) => message.includes("Detected literal secret"))).toBe(
      true,
    );
    expect(existsSync(join(machineRoot, "claude", "leaky-cli.age"))).toBe(false);

    fakeArtifacts.length = 0;
    process.exitCode = 0;
  });

  test("pushCommand.run with dryRun=true emits one SKIP line per non-skill never-sync artifact", async () => {
    // The dry-run SKIP signal must come through onPreview only. Previously
    // allWarnings.push fired alongside onPreview for the same artifact, and
    // the CLI rendered allWarnings via result.errors → log.warn, producing
    // two near-duplicate lines per never-sync source. The skill-walker
    // never-sync case fatals in Phase 1 (covered elsewhere); this test
    // exercises the top-level-source path where shouldNeverSync matches an
    // artifact an adapter happened to surface (e.g. **/auth.json).
    fakeArtifacts.length = 0;
    fakeArtifacts.push({
      vaultPath: "claude/auth.json.age",
      sourcePath: "/fake/.claude/auth.json",
      plaintext: "{}",
      warnings: [],
    });
    fakeLogs.info.length = 0;
    fakeLogs.warn.length = 0;
    fakeLogs.error.length = 0;
    process.exitCode = 0;

    await pushMod.pushCommand.run?.({
      args: { agent: "claude", dryRun: true, message: undefined },
      rawArgs: [],
      cmd: {} as never,
    } as never);

    // Exactly one SKIP line via onPreview, no second "matches never-sync
    // pattern" warning rendered from allWarnings.
    const authJsonLines = fakeLogs.warn.filter((m) => m.includes("auth.json"));
    expect(authJsonLines).toHaveLength(1);
    expect(authJsonLines[0]).toContain("[dry-run]");
    expect(authJsonLines[0]).toContain("SKIP");
    expect(authJsonLines[0]).toContain("never-sync");
    expect(fakeLogs.warn.some((m) => m.includes("matches never-sync pattern"))).toBe(false);
    expect(existsSync(join(machineRoot, "claude", "auth.json.age"))).toBe(false);

    fakeArtifacts.length = 0;
  });

  test("performPush with dryRun=true does not push the Skipped warning into result.errors for non-skill never-sync hits", async () => {
    // API-level twin of the CLI test above: gate is at the performPush
    // boundary, so the dry-run path must leave result.errors clean of the
    // "matches never-sync pattern" line. A non-dry-run run on the same
    // artifact still surfaces the warning via result.errors (covered by
    // the next test) so the operator's post-run summary is unchanged.
    fakeArtifacts.length = 0;
    fakeArtifacts.push({
      vaultPath: "claude/auth.json.age",
      sourcePath: "/fake/.claude/auth.json",
      plaintext: "{}",
      warnings: [],
    });

    const previews: Array<{ sourcePath: string; skipped: boolean; skipReason?: string }> = [];
    const result = await pushMod.performPush({
      agent: "claude",
      dryRun: true,
      onPreview: (entry) => {
        previews.push({
          sourcePath: entry.sourcePath,
          skipped: entry.skipped,
          skipReason: entry.skipReason,
        });
      },
    });

    expect(result.fatal).toBe(false);
    expect(result.pushed).toBe(0);
    expect(result.errors.some((e) => e.includes("matches never-sync pattern"))).toBe(false);
    // The SKIP signal must still reach the caller — just through onPreview only.
    expect(previews).toHaveLength(1);
    expect(previews[0]?.skipped).toBe(true);
    expect(previews[0]?.skipReason).toBe("never-sync");
    expect(previews[0]?.sourcePath).toBe("/fake/.claude/auth.json");

    fakeArtifacts.length = 0;
  });

  test("performPush without dryRun still surfaces the Skipped warning for non-skill never-sync hits when other artifacts pushed", async () => {
    // The real-push post-run summary must keep this warning. performPush
    // returns allWarnings via result.errors only when at least one artifact
    // was actually pushed (the `pushed === 0` branch returns early), so
    // pair the never-sync artifact with a clean sibling to exercise the
    // summary path.
    fakeArtifacts.length = 0;
    fakeArtifacts.push({
      vaultPath: "claude/auth.json.age",
      sourcePath: "/fake/.claude/auth.json",
      plaintext: "{}",
      warnings: [],
    });
    fakeArtifacts.push({
      vaultPath: "claude/sibling.age",
      sourcePath: "/fake/.claude/sibling.md",
      plaintext: "# clean sibling",
      warnings: [],
    });

    const result = await pushMod.performPush({ agent: "claude" });

    expect(result.fatal).toBe(false);
    expect(result.pushed).toBe(1);
    expect(
      result.errors.some(
        (e) => e.includes("/fake/.claude/auth.json") && e.includes("matches never-sync pattern"),
      ),
    ).toBe(true);
    expect(existsSync(join(machineRoot, "claude", "auth.json.age"))).toBe(false);
    expect(existsSync(join(machineRoot, "claude", "sibling.age"))).toBe(true);

    fakeArtifacts.length = 0;
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

    expect(existsSync(join(machineRoot, "claude", "cli-push.age"))).toBe(true);
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
  }, 20000);

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
    expect(
      existsSync(
        join(machineVaultRoot(machineB.vaultDir, machineB.machineName), "claude", "blocked.age"),
      ),
    ).toBe(false);
  }, 20000);
});

// ─── agent-skills-sync integration guarantees ─────────────────────────
//
// These tests run AFTER the main `describe("integration")` block above, so its
// `afterAll` has already reset the push/pull agent registries to the real
// `Agents` list. We therefore exercise the REAL Claude adapter (and its
// walker wiring) rather than the mocked test-only fake used above.

describe("skills sync integration guarantees", () => {
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

  // pull-side no-delete guarantee.
  //
  // This test proves that deleting a skill artifact from the vault (as the
  // `skill remove` verb does) followed by a `pull` on another machine DOES
  // NOT delete the local skill directory. The `applyXxxVault` functions are
  // additive-only by construction — they only call `extractArchive`, never
  // `unlink` — so any future regression that adds a local-delete sweep will
  // fail this test.

  test("applyClaudeVault does not delete a local skill when the vault artifact is gone", async () => {
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

    // v2: apply reads this machine's namespace, so seed + apply use the same root.
    const machineScopedRoot = machineVaultRoot(machine.vaultDir, machine.machineName);
    const skillsVaultDir = join(machineScopedRoot, "claude", "skills");
    await mkdirAsync(skillsVaultDir, { recursive: true });
    const vaultFile = join(skillsVaultDir, "my-skill.tar.age");
    await writeFileAsync(vaultFile, encrypted, "utf8");

    // First pull: populates the local ~/.claude/skills/my-skill/ directory.
    await claude.applyClaudeVault(machineScopedRoot, identity, false, createTestAgentSyncConfig());

    const localSkillDir = join(mutableClaudePaths.skillsDir, "my-skill");
    expect(existsSync(join(localSkillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(localSkillDir, "notes.md"))).toBe(true);

    // Simulate a post-`skill remove` vault — the artifact is gone from disk.
    const { unlink: unlinkAsync } = await import("node:fs/promises");
    await unlinkAsync(vaultFile);

    // Second pull against the now-empty vault. The local skill directory
    // MUST remain intact, no file added, no file removed: vault delete is
    // additive-only on the pull side.
    await claude.applyClaudeVault(machineScopedRoot, identity, false, createTestAgentSyncConfig());

    expect(existsSync(join(localSkillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(localSkillDir, "notes.md"))).toBe(true);
    // And the content must be byte-equal to the original — no overwrite either.
    const { readFile: readFileAsync } = await import("node:fs/promises");
    const skillBody = await readFileAsync(join(localSkillDir, "SKILL.md"), "utf8");
    expect(skillBody).toBe("# my skill body");
  });

  // negative-space vault content check.
  //
  // Builds a real ~/.claude/skills/ containing one valid skill plus a
  // top-level symlink that points into a vendored-pool directory containing
  // a secret marker. Runs the REAL `performPush` (registry reset to the real
  // Agents) and decrypts every written artifact to verify that no entry
  // contains the vendored path OR the secret marker content. This is the
  // walker's outermost safety guarantee: if root-symlink rejection were
  // bypassed, the secret marker would land in the encrypted vault.

  test("vault never contains vendored-pool content reached through a symlinked skill root", async () => {
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
    const skillsVaultDir = join(
      machineVaultRoot(machine.vaultDir, machine.machineName),
      "claude",
      "skills",
    );
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
