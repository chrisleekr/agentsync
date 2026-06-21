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
  let prevMachineFile: string | undefined;
  let prevHostname: string | undefined;
  let prevDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    prevVaultDir = process.env.AGENTSYNC_VAULT_DIR;
    prevKeyPath = process.env.AGENTSYNC_KEY_PATH;
    prevMachine = process.env.AGENTSYNC_MACHINE;
    prevMachineFile = process.env.AGENTSYNC_MACHINE_FILE;
    prevHostname = process.env.HOSTNAME;
    prevDir = process.env.AGENTSYNC_DIR;
    // Redirect the AgentSync base dir into the per-test temp dir so the
    // unconditional mkdir in resolveRuntimeContext does not touch the real
    // ~/.config/agentsync.
    process.env.AGENTSYNC_DIR = tmpDir;
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
    restore("AGENTSYNC_MACHINE_FILE", prevMachineFile);
    restore("HOSTNAME", prevHostname);
    restore("AGENTSYNC_DIR", prevDir);
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

  test("prefers the pinned machine file over AGENTSYNC_MACHINE", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    const keyPath = join(tmpDir, "key.txt");
    process.env.AGENTSYNC_KEY_PATH = keyPath;
    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "vault");
    // A hostname change (env) must NOT win once a name is pinned, otherwise the
    // machine's vault namespace (machines/<name>/ in v2) would silently orphan.
    process.env.AGENTSYNC_MACHINE = "env-machine";
    await writeFile(join(tmpDir, "machine"), "pinned-machine\n", "utf8");

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineName).toBe("pinned-machine");
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

  test("treats an empty AGENTSYNC_VAULT_DIR as unset and falls back to the default path", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    // An exported-but-empty env var is "", not undefined; `??` alone would
    // short-circuit on it and yield an empty vault dir (the process CWD).
    process.env.AGENTSYNC_VAULT_DIR = "";
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");

    const ctx = await resolveRuntimeContext();
    expect(ctx.vaultDir).toBe(join(tmpDir, "vault"));
  });

  test("treats an empty AGENTSYNC_KEY_PATH as unset and falls back to the default path", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    process.env.AGENTSYNC_VAULT_DIR = join(tmpDir, "vault");
    process.env.AGENTSYNC_KEY_PATH = "";

    const ctx = await resolveRuntimeContext();
    expect(ctx.privateKeyPath).toBe(join(tmpDir, "key.txt"));
  });

  test("treats whitespace-only path env vars as unset and falls back to defaults", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    process.env.AGENTSYNC_VAULT_DIR = "   ";
    process.env.AGENTSYNC_KEY_PATH = "\t";

    const ctx = await resolveRuntimeContext();
    expect(ctx.vaultDir).toBe(join(tmpDir, "vault"));
    expect(ctx.privateKeyPath).toBe(join(tmpDir, "key.txt"));
  });

  test("machineFilePath defaults to a sibling of the resolved key path", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    const keyDir = join(tmpDir, "state");
    await mkdir(keyDir, { recursive: true });
    process.env.AGENTSYNC_KEY_PATH = join(keyDir, "key.txt");
    process.env.AGENTSYNC_MACHINE = "host-1";

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineFilePath).toBe(join(keyDir, "machine"));
  });

  test("AGENTSYNC_MACHINE_FILE overrides the pin path", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    const pinPath = join(tmpDir, "custom-machine");
    await writeFile(pinPath, "pinned-elsewhere\n", "utf8");
    process.env.AGENTSYNC_MACHINE_FILE = pinPath;
    process.env.AGENTSYNC_MACHINE = "env-machine";

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineFilePath).toBe(pinPath);
    expect(ctx.machineName).toBe("pinned-elsewhere");
  });

  test("a blank pin file falls through to the env chain", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");
    await writeFile(join(tmpDir, "machine"), "  \n", "utf8");
    process.env.AGENTSYNC_MACHINE = "env-machine";

    const ctx = await resolveRuntimeContext();
    expect(ctx.machineName).toBe("env-machine");
  });

  test("rejects an invalid resolved machine name", async () => {
    const { resolveRuntimeContext, InvalidMachineNameError } = await import("../shared");

    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");
    process.env.AGENTSYNC_MACHINE = "bad/name";

    await expect(resolveRuntimeContext()).rejects.toBeInstanceOf(InvalidMachineNameError);
  });

  test("rejects a hand-edited pin containing a path separator", async () => {
    const { resolveRuntimeContext } = await import("../shared");

    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "key.txt");
    await writeFile(join(tmpDir, "machine"), "evil/../escape\n", "utf8");

    await expect(resolveRuntimeContext()).rejects.toThrow("path separator");
  });
});

describe("validateMachineName", () => {
  test("rejects empty, dot, traversal, control, and separator names", async () => {
    const { validateMachineName } = await import("../shared");

    for (const bad of ["", ".", "..", ".hidden", "a/b", "a\\b", "tab\tname"]) {
      expect(() => validateMachineName(bad)).toThrow();
    }
  });

  test("rejects names illegal as a directory segment on Windows", async () => {
    const { validateMachineName } = await import("../shared");

    // The vault is created on one OS and checked out on another, so a name
    // pinned on Unix must still be a legal Windows path segment. `:` is the
    // sharpest (NTFS name:stream), plus reserved chars, device names, and
    // trailing dot/space.
    for (const bad of [
      "host:stream",
      "name*",
      'q"x',
      "a<b",
      "a>b",
      "a|b",
      "trail.",
      "trail ",
      "con",
      "NUL",
      "Com1",
      "lpt9",
    ]) {
      expect(() => validateMachineName(bad)).toThrow();
    }
  });

  test("accepts ordinary host-like names", async () => {
    const { validateMachineName } = await import("../shared");

    // Spaces are neither a path separator nor a control char, so they are kept.
    for (const ok of ["my-laptop", "ci-runner", "host_01", "Work.Mac", "name with space"]) {
      expect(() => validateMachineName(ok)).not.toThrow();
    }
  });
});

describe("pinMachineNameIfAbsent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes the name when no pin exists", async () => {
    const { pinMachineNameIfAbsent } = await import("../shared");

    const path = join(tmpDir, "machine");
    const wrote = await pinMachineNameIfAbsent(path, "my-laptop");

    expect(wrote).toBe(true);
    expect((await Bun.file(path).text()).trim()).toBe("my-laptop");
  });

  test("does not overwrite an existing pin", async () => {
    const { pinMachineNameIfAbsent } = await import("../shared");

    const path = join(tmpDir, "machine");
    await writeFile(path, "first\n", "utf8");
    const wrote = await pinMachineNameIfAbsent(path, "second");

    expect(wrote).toBe(false);
    expect((await Bun.file(path).text()).trim()).toBe("first");
  });

  test("refuses to pin an invalid name", async () => {
    const { pinMachineNameIfAbsent } = await import("../shared");

    const path = join(tmpDir, "machine");
    await expect(pinMachineNameIfAbsent(path, "bad/name")).rejects.toThrow("path separator");
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

  test("re-throws non-ENOENT config errors with a friendly one-line message", async () => {
    const { loadVaultConfigOrExit } = await import("../shared");

    const vaultDir = join(tmpDir, "broken-vault");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, "agentsync.toml"), "this is = not [ valid toml", "utf8");

    // Parse failures re-throw so callers (performPush) can
    // aggregate them; only ENOENT exits. The thrown message is the one-line
    // diagnostic naming the file, not a raw Zod/Toml stack trace.
    await expect(loadVaultConfigOrExit(vaultDir)).rejects.toThrow("agentsync.toml");
    // process.exit must NOT fire — that path is reserved for the missing-vault case.
    expect(exitCalledWith).toBeNull();
  });

  test("stops a v1 (flat) vault with the `vault upgrade` hint", async () => {
    const { loadVaultConfigOrExit } = await import("../shared");

    const vaultDir = join(tmpDir, "v1-vault");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, "agentsync.toml"), 'version = "1"\n', "utf8");

    await expect(loadVaultConfigOrExit(vaultDir)).rejects.toThrow("__test_exit__");
    expect(exitCalledWith).toBe(1);
    expect(fakeLogs.error[0]).toContain("vault upgrade");
  });

  test("stops a newer-format vault with the `upgrade agentsync` hint", async () => {
    const { loadVaultConfigOrExit } = await import("../shared");

    const vaultDir = join(tmpDir, "v3-vault");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, "agentsync.toml"), "version = 3\n", "utf8");

    await expect(loadVaultConfigOrExit(vaultDir)).rejects.toThrow("__test_exit__");
    expect(exitCalledWith).toBe(1);
    expect(fakeLogs.error[0]).toContain("upgrade");
  });
});
