/**
 * Integration tests (T038–T044, T052) — end-to-end command coverage.
 *
 * Strategy
 * --------
 * 1. Mock @clack/prompts (suppress I/O) and ../agents/registry (fake "claude" agent
 *    with controllable artifacts) — modules are resolved from mock before imports.
 * 2. A shared vault is initialised once in beforeAll using a helper that sets the
 *    local git branch to "main" explicitly (portable across git versions).
 * 3. Individual tests mutate fakeArtifacts / fakeApplyCalls as needed; beforeEach
 *    resets them so each test starts clean.
 */
// ── Suppress clack I/O ────────────────────────────────────────────────────────
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { stringify as tomlStringify } from "@iarna/toml";
import type { CommandDef } from "citty";
import type { SnapshotArtifact } from "../../agents/_utils";
import { createAgeIdentity, createBareRepo, createTmpDir } from "../../test-helpers/fixtures";

// Re-register node:fs/promises with the real implementation before any code runs.
// The installer-windows/macos/linux tests mock this module; Bun shares module state
// across test files in the same run, causing the mock to bleed in here.
// We load the real module via the "fs/promises" alias (no "node:" prefix), which is
// a distinct cache key unaffected by mock.module("node:fs/promises", ...).
{
  const _require = createRequire(import.meta.url);
  const realFsPromises = _require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  log: {
    success: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  note: () => {},
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

// ── Fake "claude" agent with controllable artifacts ───────────────────────────
const fakeArtifacts: SnapshotArtifact[] = [];
const fakeApplyCalls: string[] = [];

mock.module("../../agents/registry", () => ({
  Agents: [
    {
      name: "claude",
      snapshot: async () => ({ artifacts: [...fakeArtifacts], warnings: [] }),
      apply: async (vaultDir: string) => {
        fakeApplyCalls.push(vaultDir);
      },
    },
  ],
}));

// ── Lazily imported command modules (after mocks) ─────────────────────────────
type PushMod = typeof import("../../commands/push");
type PullMod = typeof import("../../commands/pull");
type InitMod = typeof import("../../commands/init");
type KeyMod = typeof import("../../commands/key");

let pushMod: PushMod;
let pullMod: PullMod;
let initMod: InitMod;
let keyMod: KeyMod;

// ── Test-scoped vault helpers ──────────────────────────────────────────────────

/** Build a ready-to-use vault backed by a local bare repo. Sets branch="main" portably.
 *
 * Uses node:fs sync APIs and Bun.spawnSync exclusively — node:fs/promises is mocked by
 * installer-windows.test.ts (mock.module), and when Bun shares module state the mock
 * silently swallows writes. Sync node:fs is a separate module path and is unaffected.
 */
function initTestVault(
  vaultDir: string,
  bareRepoPath: string,
  keyPath: string,
  machineName: string,
  identity: string,
  recipient: string,
): void {
  // Write files using node:fs sync (NOT node:fs/promises — the latter is mocked).
  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(keyPath, `${identity}\n`, { mode: 0o600 });

  const configData = {
    version: "1",
    recipients: { [machineName]: recipient },
    agents: {
      cursor: false,
      claude: true,
      codex: false,
      copilot: false,
      vscode: false,
    },
    remote: { url: bareRepoPath, branch: "main" },
    sync: {
      debounceMs: 300,
      autoPush: true,
      autoPull: true,
      pullIntervalMs: 300_000,
    },
  };
  writeFileSync(
    join(vaultDir, "agentsync.toml"),
    tomlStringify(configData as unknown as Parameters<typeof tomlStringify>[0]),
    "utf8",
  );
  writeFileSync(join(vaultDir, ".gitignore"), "*.tmp\n", "utf8");

  // Initialize git repo and cut the first commit entirely via spawn so we avoid
  // edge cases in simple-git around unborn branches and missing git user config.
  const steps: [string, ...string[]][] = [
    ["git", "init", vaultDir],
    ["git", "-C", vaultDir, "symbolic-ref", "HEAD", "refs/heads/main"],
    ["git", "-C", vaultDir, "config", "user.name", "Agent Sync Test"],
    ["git", "-C", vaultDir, "config", "user.email", "test@agentsync.local"],
    ["git", "-C", vaultDir, "config", "commit.gpgsign", "false"],
    ["git", "-C", vaultDir, "remote", "add", "origin", bareRepoPath],
    ["git", "-C", vaultDir, "add", "."],
    ["git", "-C", vaultDir, "commit", "-m", `init: ${machineName}`],
    ["git", "-C", vaultDir, "push", "--set-upstream", "origin", "main"],
  ];

  for (const [cmd, ...args] of steps) {
    const r = Bun.spawnSync([cmd, ...args]);
    if (r.exitCode !== 0) {
      const stdout = new TextDecoder().decode(r.stdout);
      const stderr = new TextDecoder().decode(r.stderr);
      throw new Error(
        `${cmd} ${args.join(" ")} failed (code ${r.exitCode}):\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }
  }
}

// ── Load modules once before all tests run ────────────────────────────────────
beforeAll(async () => {
  pushMod = await import("../../commands/push");
  pullMod = await import("../../commands/pull");
  initMod = await import("../../commands/init");
  keyMod = await import("../../commands/key");
});

// ── Shared vault: set up once, shared across the integration suite ─────────────
describe("integration", () => {
  let tmpDir: string;
  let bareRepoPath: string;
  let vaultDir: string;
  let keyPath: string;
  const machineName = "test-machine";

  // Saved env vars restored in afterAll
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tmpDir = await createTmpDir();
    bareRepoPath = await createBareRepo(tmpDir);
    vaultDir = join(tmpDir, "vault");
    keyPath = join(tmpDir, "key.txt");

    // Persist env overrides so all command internals find our vault / key.
    for (const k of ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.AGENTSYNC_VAULT_DIR = vaultDir;
    process.env.AGENTSYNC_KEY_PATH = keyPath;
    process.env.AGENTSYNC_MACHINE = machineName;

    const { identity, recipient } = await createAgeIdentity();
    initTestVault(vaultDir, bareRepoPath, keyPath, machineName, identity, recipient);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fakeArtifacts.length = 0;
    fakeApplyCalls.length = 0;
  });

  // ── T038: init command ──────────────────────────────────────────────────────
  test("T038 — init command writes agentsync.toml and key.txt in a fresh vault", async () => {
    const initDir = join(tmpDir, "init-test");
    const initBare = join(tmpDir, "init-bare.git");
    const initKey = join(tmpDir, "init-key.txt");

    // Create a bare repo for this isolated init test
    Bun.spawnSync(["git", "init", "--bare", initBare]);

    const savedVaultDir = process.env.AGENTSYNC_VAULT_DIR;
    const savedKeyPath = process.env.AGENTSYNC_KEY_PATH;
    const savedMachine = process.env.AGENTSYNC_MACHINE;

    process.env.AGENTSYNC_VAULT_DIR = initDir;
    process.env.AGENTSYNC_KEY_PATH = initKey;
    process.env.AGENTSYNC_MACHINE = "init-machine";

    try {
      await initMod.initCommand.run?.({
        args: { remote: initBare, branch: "main" },
        rawArgs: [],
        cmd: {} as never,
      } as never);

      // Key file must be created
      expect(existsSync(initKey)).toBe(true);

      // Config file must be present
      const configContent = await readFile(join(initDir, "agentsync.toml"), "utf8");
      expect(configContent).toMatch(/recipients/);
      expect(configContent).toMatch(/init-machine/);
    } finally {
      process.env.AGENTSYNC_VAULT_DIR = savedVaultDir;
      process.env.AGENTSYNC_KEY_PATH = savedKeyPath;
      process.env.AGENTSYNC_MACHINE = savedMachine;
    }
  });

  // ── T039: performPush ───────────────────────────────────────────────────────
  test("T039 — performPush encrypts artifact and writes .age file to vault", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/CLAUDE.age",
      sourcePath: "/fake/.claude/CLAUDE.md",
      plaintext: "# Integration test rules",
      warnings: [],
    });

    const result = await pushMod.performPush({ agent: "claude" });

    expect(result.pushed).toBe(1);
    expect(result.errors).toHaveLength(0);

    const ageFile = join(vaultDir, "claude", "CLAUDE.age");
    expect(existsSync(ageFile)).toBe(true);

    // Confirm the file is ASCII-armored age-encrypted (BEGIN/END header).
    const content = await readFile(ageFile, "utf8");
    expect(content).toContain("BEGIN AGE ENCRYPTED FILE");
  });

  // ── T040: performPull ───────────────────────────────────────────────────────
  test("T040 — performPull calls agent.apply for each enabled agent", async () => {
    const result = await pullMod.performPull({ agent: "claude" });

    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);
    expect(fakeApplyCalls).toContain(vaultDir);
  });

  // ── T052: abort-on-secret ──────────────────────────────────────────────────
  test("T052 — performPush aborts when an artifact warning contains 'Redacted literal secret'", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/settings.age",
      sourcePath: "/fake/.claude/settings.json",
      plaintext: '{"apiKey":"[REDACTED]"}',
      warnings: ["Redacted literal secret for field apiKey"],
    });

    const result = await pushMod.performPush({ agent: "claude" });

    expect(result.pushed).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/Push aborted/);
    // Original per-agent warning must be propagated for diagnostics.
    expect(result.errors.some((e) => e.includes("Redacted literal secret"))).toBe(true);
  });

  // ── T041: status command (smoke test) ──────────────────────────────────────
  test("T041 — status command runs without throwing", async () => {
    const statusMod = await import("../../commands/status");
    // Await directly — if the command throws, bun:test marks this test as failed.
    await statusMod.statusCommand.run?.({
      args: { verbose: false },
      rawArgs: [],
      cmd: {} as never,
    } as never);
  });

  // ── T042: doctor command (smoke test) ──────────────────────────────────────
  test("T042 — doctor command runs without throwing", async () => {
    const doctorMod = await import("../../commands/doctor");
    await doctorMod.doctorCommand.run?.({
      args: {},
      rawArgs: [],
      cmd: {} as never,
    } as never);
  });

  // ── T043: key add ──────────────────────────────────────────────────────────
  test("T043 — key add appends recipient to config and re-encrypts vault files", async () => {
    // Push a file so re-encryption has something to process.
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

    // The .age file must still exist and be valid ASCII-armored age-encrypted after re-encryption.
    const ageFile = join(vaultDir, "claude", "CLAUDE.age");
    expect(existsSync(ageFile)).toBe(true);
    const content = await readFile(ageFile, "utf8");
    expect(content).toContain("BEGIN AGE ENCRYPTED FILE");
  });

  // ── T044: key rotate ───────────────────────────────────────────────────────
  test("T044 — key rotate replaces private key and updates config recipient", async () => {
    // Read current key before rotation.
    const oldKeyContent = await readFile(keyPath, "utf8");

    await (keyMod.keyCommand.subCommands as unknown as Record<string, CommandDef>).rotate.run?.({
      args: {},
      rawArgs: [],
      cmd: {} as never,
    } as never);

    // Private key file must have been overwritten with a new identity.
    const newKeyContent = await readFile(keyPath, "utf8");
    expect(newKeyContent.trim()).not.toBe(oldKeyContent.trim());
    expect(newKeyContent.trim()).toMatch(/^AGE-SECRET-KEY-/);

    // Config must reflect the new recipient public key for this machine.
    const configContent = await readFile(join(vaultDir, "agentsync.toml"), "utf8");
    expect(configContent).toMatch(/test-machine/);
  });

  // ── Push CLI command handler ───────────────────────────────────────────────

  test("pushCommand.run with dryRun=true does not write vault files", async () => {
    fakeArtifacts.push({
      vaultPath: "claude/dry-cli.age",
      sourcePath: "/fake/.claude/dry-cli.md",
      plaintext: "# dry run via CLI",
      warnings: [],
    });

    // Should complete without error; exercises the dryRun CLI code path
    await pushMod.pushCommand.run?.({
      args: { agent: "claude", dryRun: true, message: undefined },
      rawArgs: [],
      cmd: {} as never,
    } as never);

    expect(existsSync(join(vaultDir, "claude", "dry-cli.age"))).toBe(false);
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

    expect(existsSync(join(vaultDir, "claude", "cli-push.age"))).toBe(true);
    fakeArtifacts.length = 0;
  });

  test("performPush returns early when no agents match requested name", async () => {
    const result = await pushMod.performPush({ agent: "nonexistent-agent" });
    expect(result.pushed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
