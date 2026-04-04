/**
 * src/test-helpers/fixtures.ts
 *
 * Shared per-test isolation utilities used across all test suites.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { generateIdentity, identityToRecipient } from "../core/encryptor";

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
