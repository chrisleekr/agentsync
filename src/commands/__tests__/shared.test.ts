import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";

// T037 — resolveRuntimeContext + loadPrivateKey

// Both functions read env vars / files at CALL TIME (not baked), so standard
// import + env var injection works without module mocking.

describe("resolveRuntimeContext", () => {
  let tmpDir: string;
  let prevVaultDir: string | undefined;
  let prevKeyPath: string | undefined;
  let prevMachine: string | undefined;
  let prevHostname: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    prevVaultDir = process.env.AGENTSYNC_VAULT_DIR;
    prevKeyPath = process.env.AGENTSYNC_KEY_PATH;
    prevMachine = process.env.AGENTSYNC_MACHINE;
    prevHostname = process.env.HOSTNAME;
  });

  afterEach(async () => {
    // Restore env vars
    const restore = (key: string, prev: string | undefined) => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    };
    restore("AGENTSYNC_VAULT_DIR", prevVaultDir);
    restore("AGENTSYNC_KEY_PATH", prevKeyPath);
    restore("AGENTSYNC_MACHINE", prevMachine);
    restore("HOSTNAME", prevHostname);
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns env-var overrides when all three vars are set", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    const vaultDir = join(tmpDir, "vault");
    const keyPath = join(tmpDir, "key.txt");

    process.env.AGENTSYNC_VAULT_DIR = vaultDir;
    process.env.AGENTSYNC_KEY_PATH = keyPath;
    process.env.AGENTSYNC_MACHINE = "ci-runner";

    const ctx = await resolveRuntimeContext();
    expect(ctx.vaultDir).toBe(vaultDir);
    expect(ctx.privateKeyPath).toBe(keyPath);
    expect(ctx.machineName).toBe("ci-runner");
  });

  test("falls back to HOSTNAME env var when AGENTSYNC_MACHINE is unset", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    process.env.AGENTSYNC_MACHINE = undefined;
    process.env.HOSTNAME = "my-laptop";
    // set vault/key to avoid polluting home dir
    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "vault");
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineName).toBe("my-laptop");
  });

  test("machineName is non-empty when neither AGENTSYNC_MACHINE nor HOSTNAME is set", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    process.env.AGENTSYNC_MACHINE = undefined;
    process.env.HOSTNAME = undefined;
    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "vault");
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");

    const ctx = await resolveRuntimeContext();
    expect(typeof ctx.machineName).toBe("string");
    expect(ctx.machineName.length).toBeGreaterThan(0);
  });
});

describe("loadPrivateKey", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("reads file content and trims surrounding whitespace", async () => {
    const { loadPrivateKey } = await import("../shared");

    const keyPath = join(tmpDir, "key.txt");
    await writeFile(keyPath, "  AGE-SECRET-KEY-1ABCDEF\n\n", "utf8");

    const key = await loadPrivateKey(keyPath);
    expect(key).toBe("AGE-SECRET-KEY-1ABCDEF");
  });

  test("rejects with an error when the file does not exist", async () => {
    const { loadPrivateKey } = await import("../shared");

    const missingPath = join(tmpDir, "nonexistent.txt");
    await expect(loadPrivateKey(missingPath)).rejects.toThrow();
  });
});
