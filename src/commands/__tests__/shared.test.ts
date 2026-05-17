import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";

// resolveRuntimeContext + loadPrivateKey

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

  test("treats an empty AGENTSYNC_MACHINE as unset and falls back to HOSTNAME", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    // An exported-but-empty env var is "", not undefined; `??` alone would
    // short-circuit on it and yield an empty machineName.
    process.env.AGENTSYNC_MACHINE = "";
    process.env.HOSTNAME = "my-laptop";
    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "vault");
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineName).toBe("my-laptop");
  });

  test("treats a whitespace-only AGENTSYNC_MACHINE as unset and falls back to HOSTNAME", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    process.env.AGENTSYNC_MACHINE = "   ";
    process.env.HOSTNAME = "fallback-host";
    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "vault");
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineName).toBe("fallback-host");
  });

  test("treats a whitespace-only HOSTNAME as unset and falls through to os.hostname()", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    // os.hostname() is not deterministically controllable, so this can only
    // assert the chain did not yield the blank HOSTNAME — the deepest fallback.
    process.env.AGENTSYNC_MACHINE = undefined;
    process.env.HOSTNAME = "\t";
    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "vault");
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineName.trim()).toBe(ctx.machineName);
    expect(ctx.machineName.length).toBeGreaterThan(0);
  });

  test("trims surrounding whitespace from a set AGENTSYNC_MACHINE value", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    process.env.AGENTSYNC_MACHINE = "  ci-runner  ";
    process.env.HOSTNAME = undefined;
    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "vault");
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineName).toBe("ci-runner");
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

describe("loadVaultConfigOrExit", () => {
  let tmpDir: string;
  const fakeLogs: { error: string[] } = { error: [] };
  let originalExit: typeof process.exit;
  let exitCalledWith: number | null;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    fakeLogs.error = [];
    exitCalledWith = null;
    originalExit = process.exit;
    // Throw a sentinel from process.exit so control returns to the test
    // harness instead of actually exiting the worker.
    process.exit = ((code?: number) => {
      exitCalledWith = code ?? 0;
      throw new Error("__test_exit__");
    }) as typeof process.exit;

    mock.module("@clack/prompts", () => ({
      log: {
        error: (m: string) => {
          fakeLogs.error.push(m);
        },
        info: () => {},
        warn: () => {},
        success: () => {},
      },
    }));
  });

  afterEach(async () => {
    process.exit = originalExit;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("prints friendly error and exits 1 when the config file is missing", async () => {
    const { loadVaultConfigOrExit } = await import("../shared");

    const vaultDir = join(tmpDir, "missing-vault");
    await expect(loadVaultConfigOrExit(vaultDir)).rejects.toThrow("__test_exit__");

    expect(exitCalledWith).toBe(1);
    expect(fakeLogs.error).toHaveLength(1);
    expect(fakeLogs.error[0]).toContain(`Vault not initialized at ${vaultDir}`);
    expect(fakeLogs.error[0]).toContain("agentsync init --remote");
    // The message must not include Node ENOENT shorthand or stack frames.
    expect(fakeLogs.error[0]).not.toContain("ENOENT");
    expect(fakeLogs.error[0]).not.toContain("at async");
  });

  test("re-throws non-ENOENT errors so callers see schema/parse failures intact", async () => {
    const { loadVaultConfigOrExit } = await import("../shared");

    const vaultDir = join(tmpDir, "broken-vault");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, "agentsync.toml"), "this is = not [ valid toml", "utf8");

    await expect(loadVaultConfigOrExit(vaultDir)).rejects.toThrow();
    // Should NOT have called process.exit — only ENOENT triggers the friendly path.
    expect(exitCalledWith).toBeNull();
  });
});
