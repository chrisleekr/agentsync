/**
 * src/test-helpers/fixtures.ts
 *
 * Shared per-test isolation utilities used across all test suites.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as tomlStringify } from "@iarna/toml";
import { generateIdentity, identityToRecipient } from "../core/encryptor";

const DEFAULT_AGENTS = {
  cursor: false,
  claude: true,
  codex: false,
  copilot: false,
  vscode: false,
};

const DEFAULT_SYNC = {
  debounceMs: 300,
  autoPush: true,
  autoPull: true,
  pullIntervalMs: 300_000,
};

/** Runtime fixture paths and key material for one logical machine. */
export interface TestMachineFixture {
  machineName: string;
  vaultDir: string;
  keyPath: string;
  identity: string;
  recipient: string;
}

/**
 * Create an isolated temporary directory for a single test.
 * Caller is responsible for removing it in afterEach.
 */
export async function createTmpDir(): Promise<string> {
  const root = join(process.cwd(), ".agentsync-test-tmp");
  const dir = join(root, `agentsync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Generate a fresh age X25519 keypair for use in tests.
 * Returns the AGE-SECRET-KEY-1… private identity and corresponding age1… recipient.
 */
export async function createAgeIdentity(): Promise<{
  identity: string;
  recipient: string;
}> {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient };
}

/**
 * Initialise a bare git repo at `<dir>/remote.git` that can be used as a
 * local "remote" URL in tests.  Returns the absolute path to the bare repo.
 */
export async function createBareRepo(dir: string): Promise<string> {
  const repoPath = join(dir, "remote.git");
  const result = Bun.spawnSync(["git", "init", "--bare", repoPath]);
  if (result.exitCode !== 0) {
    throw new Error(`git init --bare failed: ${new TextDecoder().decode(result.stderr)}`);
  }
  return repoPath;
}

/** Run a git command and throw with stdout/stderr context on failure. */
export function runGit(args: string[], cwd?: string): string {
  const command = cwd ? ["git", "-C", cwd, ...args] : ["git", ...args];
  const result = Bun.spawnSync(command);
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (code ${result.exitCode}): ${stderr || stdout || "no output"}`,
    );
  }

  return stdout;
}

/** Create a machine-scoped vault/key fixture with a fresh age identity. */
export async function createMachineFixture(
  root: string,
  machineName: string,
): Promise<TestMachineFixture> {
  const vaultDir = join(root, `${machineName}-vault`);
  const keyPath = join(root, `${machineName}-key.txt`);
  const { identity, recipient } = await createAgeIdentity();

  mkdirSync(vaultDir, { recursive: true });
  writeFileSync(keyPath, `${identity}\n`, { mode: 0o600 });

  return {
    machineName,
    vaultDir,
    keyPath,
    identity,
    recipient,
  };
}

/** Seed a working vault repo for a machine and push the first commit to a bare remote. */
export function seedVaultRepo(options: {
  machine: TestMachineFixture;
  bareRepoPath: string;
  branch?: string;
  recipients?: Record<string, string>;
  agents?: Partial<typeof DEFAULT_AGENTS>;
}): void {
  const { machine, bareRepoPath } = options;
  const branch = options.branch ?? "main";
  const configData = {
    version: "1",
    recipients: options.recipients ?? { [machine.machineName]: machine.recipient },
    agents: {
      ...DEFAULT_AGENTS,
      ...options.agents,
    },
    remote: { url: bareRepoPath, branch },
    sync: DEFAULT_SYNC,
  };

  mkdirSync(machine.vaultDir, { recursive: true });
  writeFileSync(
    join(machine.vaultDir, "agentsync.toml"),
    tomlStringify(configData as unknown as Parameters<typeof tomlStringify>[0]),
    "utf8",
  );
  writeFileSync(join(machine.vaultDir, ".gitignore"), "*.tmp\n", "utf8");

  runGit(["init"], machine.vaultDir);
  runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], machine.vaultDir);
  runGit(["config", "user.name", "Agent Sync Test"], machine.vaultDir);
  runGit(["config", "user.email", "test@agentsync.local"], machine.vaultDir);
  runGit(["config", "commit.gpgsign", "false"], machine.vaultDir);
  runGit(["remote", "add", "origin", bareRepoPath], machine.vaultDir);
  runGit(["add", "."], machine.vaultDir);
  runGit(["commit", "-m", `init: ${machine.machineName}`], machine.vaultDir);
  runGit(["push", "--set-upstream", "origin", branch], machine.vaultDir);
}

/** Build two working repos that have both advanced independently from the same base. */
export async function createDivergentHistoryFixture(
  root: string,
  branch = "main",
): Promise<{
  bareRepoPath: string;
  primaryDir: string;
  secondaryDir: string;
}> {
  const bareRepoPath = await createBareRepo(root);
  const primaryDir = join(root, "divergent-primary");
  const secondaryDir = join(root, "divergent-secondary");

  mkdirSync(primaryDir, { recursive: true });
  runGit(["init"], primaryDir);
  runGit(["symbolic-ref", "HEAD", `refs/heads/${branch}`], primaryDir);
  runGit(["config", "user.name", "Agent Sync Test"], primaryDir);
  runGit(["config", "user.email", "test@agentsync.local"], primaryDir);
  runGit(["remote", "add", "origin", bareRepoPath], primaryDir);
  writeFileSync(join(primaryDir, "data.txt"), "base\n", "utf8");
  runGit(["add", "."], primaryDir);
  runGit(["commit", "-m", "base"], primaryDir);
  runGit(["push", "--set-upstream", "origin", branch], primaryDir);

  runGit(["clone", "--branch", branch, bareRepoPath, secondaryDir]);
  runGit(["config", "user.name", "Agent Sync Test"], secondaryDir);
  runGit(["config", "user.email", "test@agentsync.local"], secondaryDir);

  writeFileSync(join(primaryDir, "data.txt"), "remote-update\n", "utf8");
  runGit(["commit", "-am", "remote update"], primaryDir);
  runGit(["push", "origin", branch], primaryDir);

  writeFileSync(join(secondaryDir, "data.txt"), "local-update\n", "utf8");
  runGit(["commit", "-am", "local update"], secondaryDir);

  return {
    bareRepoPath,
    primaryDir,
    secondaryDir,
  };
}

/**
 * Prepare a socket path inside the supplied directory for IPC tests.
 * The directory is created if it does not already exist.
 */
export async function createIpcFixture(socketDir: string): Promise<{ socketPath: string }> {
  mkdirSync(socketDir, { recursive: true });
  return {
    socketPath: join(socketDir, "test-daemon.sock"),
  };
}
