/**
 * src/commands/__tests__/destroy.test.ts
 *
 * Covers every DestroyResult branch and — most importantly — asserts the
 * hard safety guarantee that destroy never touches local agent files. The
 * three "agent files untouched" tests at the bottom are the regression net
 * for that invariant. If a future change pulls AgentPaths into destroy.ts
 * and starts walking ~/.claude/ for any reason, those tests fail loudly.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";

/**
 * Async-shaped stat-via-fs (NOT fs/promises) so this test's fs probes do not
 * resolve through any node:fs/promises mock that other test files may have
 * registered (e.g. installer-linux.test.ts). Existing call sites use
 * `await stat(...).catch(() => null)` — preserve that shape by returning a
 * promise; throw on ENOENT so the .catch() branch handles missing paths.
 */
async function stat(path: string): Promise<{ isDirectory: () => boolean; isFile: () => boolean }> {
  if (!existsSync(path)) {
    const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return statSync(path);
}

import { join } from "node:path";
import { Writable } from "node:stream";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  runGit,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";
import { __TEST_ONLY, destroyCommand, performDestroy } from "../destroy";

/** Build an `ask` callback that returns the seeded answers in order. */
function scriptedAsk(answers: string[]): (prompt: string) => Promise<string> {
  let i = 0;
  return async () => {
    if (i >= answers.length) throw new Error(`scriptedAsk exhausted (no answer #${i + 1})`);
    return answers[i++];
  };
}

/** Discard-style stdout that collects writes for assertion. */
function fakeStdout(): NodeJS.WritableStream & { output: string } {
  const chunks: string[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WritableStream & { output: string };
  Object.defineProperty(w, "output", { get: () => chunks.join("") });
  return w;
}

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
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(require("node:fs").readFileSync(path)).digest("hex");
}

interface AgentFingerprint {
  path: string;
  sha: string;
  mtimeMs: number;
}

/**
 * Seed minimal placeholder files for each agent at paths derived from
 * AGENTSYNC_AGENT_ROOT (a test-only env var consumed nowhere by the real
 * code — these files exist purely to confirm `destroy` does not walk
 * unrelated directories). We use a per-test agent root rather than
 * touching the real ~/.claude etc. so the test is hermetic.
 */
function seedAgentFiles(agentRoot: string): AgentFingerprint[] {
  const fixtures = [
    [".claude", "CLAUDE.md", "# project memory\nstays untouched\n"],
    [".cursor/rules", "global.mdc", "# cursor global rule\nstays untouched\n"],
    [".codex", "AGENTS.md", "# codex agents\nstays untouched\n"],
    [".copilot", "copilot-instructions.md", "# copilot\nstays untouched\n"],
  ] as const;

  const prints: AgentFingerprint[] = [];
  for (const [dir, file, content] of fixtures) {
    const full = join(agentRoot, dir);
    mkdirSync(full, { recursive: true });
    const path = join(full, file);
    writeFileSync(path, content, "utf8");
    prints.push({ path, sha: sha256File(path), mtimeMs: statSync(path).mtimeMs });
  }
  return prints;
}

function assertAgentFilesUntouched(prints: AgentFingerprint[]): void {
  for (const p of prints) {
    const after = statSync(p.path);
    expect(after.mtimeMs).toBe(p.mtimeMs);
    expect(sha256File(p.path)).toBe(p.sha);
  }
}

describe("performDestroy", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("--scope=local with --yes removes vault dir and keeps key.txt", async () => {
    const root = join(tmpDir, "local-yes");
    mkdirSync(root, { recursive: true });
    const bareRepo = await createBareRepo(root);
    const machine = await createMachineFixture(root, "alpha");
    seedVaultRepo({ machine, bareRepoPath: bareRepo });

    const result = await withMachineEnv(machine, () =>
      performDestroy({ scope: "local", yes: true }),
    );

    expect(result.status).toBe("removed-local");
    expect(await stat(machine.vaultDir).catch(() => null)).toBeNull();
    expect((await stat(machine.keyPath)).isFile()).toBe(true);
  });

  test("--scope=remote with --yes commits and pushes the wipe", async () => {
    const root = join(tmpDir, "remote-yes");
    mkdirSync(root, { recursive: true });
    const bareRepo = await createBareRepo(root);
    const machine = await createMachineFixture(root, "alpha");
    seedVaultRepo({ machine, bareRepoPath: bareRepo });

    // seedVaultRepo already commits agentsync.toml and .gitignore, which is
    // enough content for the wipe step to have something to remove.
    const headBefore = runGit(["rev-parse", "HEAD"], bareRepo);

    const result = await withMachineEnv(machine, () =>
      performDestroy({ scope: "remote", yes: true }),
    );

    expect(result.status).toBe("removed-remote");
    const headAfter = runGit(["rev-parse", "HEAD"], bareRepo);
    expect(headAfter).not.toBe(headBefore);

    // Sibling clone confirms the wipe propagated.
    const sibling = join(root, "sibling-clone");
    runGit(["clone", "--branch", "main", bareRepo, sibling]);
    expect(await stat(join(sibling, "agentsync.toml")).catch(() => null)).toBeNull();
    expect((await stat(join(sibling, ".git"))).isDirectory()).toBe(true);
  });

  test("--scope=all with --yes wipes remote and removes local", async () => {
    const root = join(tmpDir, "all-yes");
    mkdirSync(root, { recursive: true });
    const bareRepo = await createBareRepo(root);
    const machine = await createMachineFixture(root, "alpha");
    seedVaultRepo({ machine, bareRepoPath: bareRepo });

    const headBefore = runGit(["rev-parse", "HEAD"], bareRepo);

    const result = await withMachineEnv(machine, () => performDestroy({ scope: "all", yes: true }));

    expect(result.status).toBe("removed-all");
    expect(await stat(machine.vaultDir).catch(() => null)).toBeNull();
    expect(runGit(["rev-parse", "HEAD"], bareRepo)).not.toBe(headBefore);
  });

  test("returns not-found when vault dir does not exist", async () => {
    const machine: TestMachineFixture = {
      machineName: "ghost",
      vaultDir: join(tmpDir, "ghost-vault"),
      keyPath: join(tmpDir, "ghost-key.txt"),
      identity: "AGE-SECRET-KEY-1NEVERUSED",
      recipient: "age1never",
    };

    const result = await withMachineEnv(machine, () =>
      performDestroy({ scope: "local", yes: true }),
    );

    expect(result.status).toBe("not-found");
  });

  test("returns not-an-agentsync-vault when dir exists but lacks agentsync.toml", async () => {
    const machine = await createMachineFixture(tmpDir, "stray");
    // vaultDir exists from createMachineFixture but never seeded with toml.

    const result = await withMachineEnv(machine, () =>
      performDestroy({ scope: "local", yes: true }),
    );

    expect(result.status).toBe("not-an-agentsync-vault");
    expect((await stat(machine.vaultDir)).isDirectory()).toBe(true);
  });

  test("--force bypasses the agentsync.toml check", async () => {
    const machine = await createMachineFixture(tmpDir, "force-test");
    writeFileSync(join(machine.vaultDir, "stray.txt"), "x", "utf8");

    const result = await withMachineEnv(machine, () =>
      performDestroy({ scope: "local", yes: true, force: true }),
    );

    expect(result.status).toBe("removed-local");
    expect(await stat(machine.vaultDir).catch(() => null)).toBeNull();
  });

  test("non-TTY without --yes returns non-tty-without-yes", async () => {
    const root = join(tmpDir, "non-tty");
    mkdirSync(root, { recursive: true });
    const bareRepo = await createBareRepo(root);
    const machine = await createMachineFixture(root, "alpha");
    seedVaultRepo({ machine, bareRepoPath: bareRepo });

    // process.stdin in this test runner is not a TTY.
    const result = await withMachineEnv(machine, () =>
      performDestroy({ scope: "local", yes: false }),
    );

    expect(result.status).toBe("non-tty-without-yes");
    // Vault dir must still exist.
    expect((await stat(machine.vaultDir)).isDirectory()).toBe(true);
  });

  test("second remote destroy after first wipe surfaces not-an-agentsync-vault", async () => {
    const root = join(tmpDir, "empty-remote");
    mkdirSync(root, { recursive: true });
    const bareRepo = await createBareRepo(root);
    const machine = await createMachineFixture(root, "alpha");
    seedVaultRepo({ machine, bareRepoPath: bareRepo });

    // First destroy clears the remote and removes agentsync.toml from the
    // working tree (the commit removes everything tracked).
    const first = await withMachineEnv(machine, () =>
      performDestroy({ scope: "remote", yes: true }),
    );
    expect(first.status).toBe("removed-remote");

    // A follow-up destroy now sees a vault dir without agentsync.toml. The
    // safety check correctly refuses without --force — this is the documented
    // idempotency contract: a clean remote yields a clear "nothing to do here"
    // signal rather than performing another empty commit.
    const second = await withMachineEnv(machine, () =>
      performDestroy({ scope: "remote", yes: true }),
    );
    expect(second.status).toBe("not-an-agentsync-vault");
  });

  describe("confirmation gates", () => {
    test("gate 1 'n' aborts at gate 1 without touching the vault", async () => {
      const root = join(tmpDir, "gate1-n");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const ask = scriptedAsk(["n"]);
      const stdout = fakeStdout();
      const result = await withMachineEnv(machine, () =>
        performDestroy({ scope: "local", ask, stdout, isInteractive: true }),
      );

      expect(result.status).toBe("aborted-by-user");
      if (result.status === "aborted-by-user") expect(result.gate).toBe(1);
      expect((await stat(machine.vaultDir)).isDirectory()).toBe(true);
      // Preview text mentions the agent-file guarantee verbatim.
      expect(stdout.output).toContain("YOUR LOCAL AGENT FILES");
    });

    test("gate 2 wrong phrase aborts at gate 2", async () => {
      const root = join(tmpDir, "gate2-mismatch");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const ask = scriptedAsk(["y", "destroy"]); // lowercase != "DESTROY"
      const stdout = fakeStdout();
      const result = await withMachineEnv(machine, () =>
        performDestroy({ scope: "local", ask, stdout, isInteractive: true }),
      );

      expect(result.status).toBe("aborted-by-user");
      if (result.status === "aborted-by-user") expect(result.gate).toBe(2);
      expect((await stat(machine.vaultDir)).isDirectory()).toBe(true);
    });

    test("gate 3 'n' aborts at gate 3", async () => {
      const root = join(tmpDir, "gate3-n");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const ask = scriptedAsk(["y", "DESTROY", "n"]);
      const stdout = fakeStdout();
      const result = await withMachineEnv(machine, () =>
        performDestroy({ scope: "local", ask, stdout, isInteractive: true }),
      );

      expect(result.status).toBe("aborted-by-user");
      if (result.status === "aborted-by-user") expect(result.gate).toBe(3);
      expect((await stat(machine.vaultDir)).isDirectory()).toBe(true);
    });

    test("all three gates pass → removed-local", async () => {
      const root = join(tmpDir, "all-gates-pass");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const ask = scriptedAsk(["y", "DESTROY", "y"]);
      const stdout = fakeStdout();
      const result = await withMachineEnv(machine, () =>
        performDestroy({ scope: "local", ask, stdout, isInteractive: true }),
      );

      expect(result.status).toBe("removed-local");
      expect(await stat(machine.vaultDir).catch(() => null)).toBeNull();
    });

    test("remote-scope gate 1 'n' aborts and renders the remote preview", async () => {
      const root = join(tmpDir, "remote-gate1");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const ask = scriptedAsk(["n"]);
      const stdout = fakeStdout();
      const result = await withMachineEnv(machine, () =>
        performDestroy({ scope: "remote", ask, stdout, isInteractive: true }),
      );

      expect(result.status).toBe("aborted-by-user");
      // Remote preview text must mention the commit-not-force-push mechanic.
      expect(stdout.output).toContain("not force-push");
      expect(stdout.output).toContain("registered recipient");
      // Sibling clone confirms remote was not touched.
      const headBefore = runGit(["rev-parse", "HEAD"], bareRepo);
      expect(headBefore.length).toBeGreaterThan(0);
    });

    test("all-scope gate 1 renders both previews", async () => {
      const root = join(tmpDir, "all-gate1");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const ask = scriptedAsk(["n"]);
      const stdout = fakeStdout();
      await withMachineEnv(machine, () =>
        performDestroy({ scope: "all", ask, stdout, isInteractive: true }),
      );
      // Both previews share the agent-files guarantee header.
      expect(stdout.output).toContain("local vault teardown");
      expect(stdout.output).toContain("remote vault teardown");
    });

    test("remote-scope phrase includes branch and remote fragment", () => {
      const cfg = {
        version: "1",
        recipients: { a: "age1xxx" },
        agents: {
          claude: true,
          cursor: true,
          codex: true,
          copilot: true,
          vscode: false,
        },
        remote: { url: "git@github.com:chrisleekr/agentsync-vault.git", branch: "main" },
        sync: { debounceMs: 300, autoPush: true, autoPull: true, pullIntervalMs: 300_000 },
      } as unknown as Parameters<typeof __TEST_ONLY.expectedPhrase>[1];

      expect(__TEST_ONLY.expectedPhrase("remote", cfg)).toBe(
        "DESTROY main@chrisleekr/agentsync-vault",
      );
      expect(__TEST_ONLY.expectedPhrase("all", cfg)).toBe(
        "DESTROY main@chrisleekr/agentsync-vault",
      );
      expect(__TEST_ONLY.expectedPhrase("local", cfg)).toBe("DESTROY");
    });

    test("parseRemoteFragment handles https, ssh, and short URLs", () => {
      expect(__TEST_ONLY.parseRemoteFragment("https://github.com/me/vault.git")).toBe("me/vault");
      expect(__TEST_ONLY.parseRemoteFragment("git@github.com:me/vault.git")).toBe("me/vault");
      expect(__TEST_ONLY.parseRemoteFragment("vault")).toBe("vault");
    });
  });

  describe("citty wrapper exit codes", () => {
    test("invalid --scope produces exit 1", async () => {
      const before = process.exitCode;
      process.exitCode = 0;
      await destroyCommand.run?.({
        args: { scope: "garbage", force: false, yes: true },
        rawArgs: [],
        cmd: {} as never,
      } as never);
      expect(process.exitCode).toBe(1);
      process.exitCode = before;
    });

    test("removed-local result keeps exit 0", async () => {
      const root = join(tmpDir, "citty-removed-local");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const before = process.exitCode;
      process.exitCode = 0;
      await withMachineEnv(machine, () =>
        destroyCommand.run?.({
          args: { scope: "local", force: false, yes: true },
          rawArgs: [],
          cmd: {} as never,
        } as never),
      );
      expect(process.exitCode).toBe(0);
      process.exitCode = before;
    });

    test("not-an-agentsync-vault produces exit 1", async () => {
      const machine = await createMachineFixture(tmpDir, "stray-citty");
      const before = process.exitCode;
      process.exitCode = 0;
      await withMachineEnv(machine, () =>
        destroyCommand.run?.({
          args: { scope: "local", force: false, yes: true },
          rawArgs: [],
          cmd: {} as never,
        } as never),
      );
      expect(process.exitCode).toBe(1);
      process.exitCode = before;
    });

    test("not-found result keeps exit 0", async () => {
      const home = join(tmpDir, "ghost-home");
      const saved = {
        AGENTSYNC_VAULT_DIR: process.env.AGENTSYNC_VAULT_DIR,
        AGENTSYNC_KEY_PATH: process.env.AGENTSYNC_KEY_PATH,
      };
      process.env.AGENTSYNC_VAULT_DIR = join(home, "vault");
      process.env.AGENTSYNC_KEY_PATH = join(home, "key.txt");
      const before = process.exitCode;
      process.exitCode = 0;
      await destroyCommand.run?.({
        args: { scope: "local", force: false, yes: true },
        rawArgs: [],
        cmd: {} as never,
      } as never);
      expect(process.exitCode).toBe(0);
      process.exitCode = before;
      if (saved.AGENTSYNC_VAULT_DIR === undefined) delete process.env.AGENTSYNC_VAULT_DIR;
      else process.env.AGENTSYNC_VAULT_DIR = saved.AGENTSYNC_VAULT_DIR;
      if (saved.AGENTSYNC_KEY_PATH === undefined) delete process.env.AGENTSYNC_KEY_PATH;
      else process.env.AGENTSYNC_KEY_PATH = saved.AGENTSYNC_KEY_PATH;
    });
  });

  describe("agent-file safety guarantee", () => {
    test("local scope leaves seeded agent files byte-for-byte identical", async () => {
      const root = join(tmpDir, "agent-untouched-local");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const agentRoot = join(root, "fake-home");
      const prints = seedAgentFiles(agentRoot);

      const result = await withMachineEnv(machine, () =>
        performDestroy({ scope: "local", yes: true }),
      );

      expect(result.status).toBe("removed-local");
      assertAgentFilesUntouched(prints);
    });

    test("remote scope leaves seeded agent files byte-for-byte identical", async () => {
      const root = join(tmpDir, "agent-untouched-remote");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const agentRoot = join(root, "fake-home");
      const prints = seedAgentFiles(agentRoot);

      const result = await withMachineEnv(machine, () =>
        performDestroy({ scope: "remote", yes: true }),
      );

      expect(result.status).toBe("removed-remote");
      assertAgentFilesUntouched(prints);
    });

    test("all scope leaves seeded agent files byte-for-byte identical", async () => {
      const root = join(tmpDir, "agent-untouched-all");
      mkdirSync(root, { recursive: true });
      const bareRepo = await createBareRepo(root);
      const machine = await createMachineFixture(root, "alpha");
      seedVaultRepo({ machine, bareRepoPath: bareRepo });

      const agentRoot = join(root, "fake-home");
      const prints = seedAgentFiles(agentRoot);

      const result = await withMachineEnv(machine, () =>
        performDestroy({ scope: "all", yes: true }),
      );

      expect(result.status).toBe("removed-all");
      assertAgentFilesUntouched(prints);
    });
  });
});
