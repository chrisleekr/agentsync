/**
 * Tests for the `agentsync config` verbs against real git fixtures (no git
 * mocking), mirroring key.test.ts. Exercises list/get/set, the settable-prefix
 * guard, unknown-key rejection, schema-backed value validation, and scalar
 * type coercion.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadConfig, resolveConfigPath } from "../../config/loader";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  runGit,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";

{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: deliberate alias to bypass mock cache
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => ({ ...realFsPromises, default: realFsPromises }));
}

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  log: { success: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  note: () => {},
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

type ConfigMod = typeof import("../config");
let configMod: ConfigMod;

const RUNTIME_ENV_KEYS = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"];

afterAll(() => {
  mock.restore();
});

describe("config command", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  let bare: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    configMod = await import("../config");
    tmpDir = await createTmpDir();
    machine = await createMachineFixture(tmpDir, "config-test");
    bare = await createBareRepo(tmpDir);
    seedVaultRepo({ machine, bareRepoPath: bare });
    for (const key of RUNTIME_ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;
    process.exitCode = 0;
  });

  function restore(): Promise<void> {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return rm(tmpDir, { recursive: true, force: true });
  }

  // afterEach guarantees env + tmpdir cleanup even when an assertion throws
  // mid-test, so a failing test cannot leak dirty state into the next one.
  afterEach(restore);

  test("performConfigList returns settable keys and excludes version + recipients", async () => {
    const entries = await configMod.performConfigList();
    const keys = entries.map((e) => e.key);
    expect(keys).toContain("agents.claude");
    expect(keys).toContain("security.secretScan");
    expect(keys.some((k) => k === "version")).toBe(false);
    expect(keys.some((k) => k.startsWith("recipients"))).toBe(false);
  });

  test("performConfigGet reads a value and reports unknown keys", async () => {
    const found = await configMod.performConfigGet("security.secretScan");
    expect(found).toEqual({ status: "found", key: "security.secretScan", value: "standard" });
    const missing = await configMod.performConfigGet("agents.nope");
    expect(missing.status).toBe("unknown-key");
  });

  test("performConfigSet changes a boolean and persists it to the vault config", async () => {
    const result = await configMod.performConfigSet("agents.vscode", "true");
    expect(result.status).toBe("success");
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.agents.vscode).toBe(true);
  });

  test("performConfigSet coerces an enum word", async () => {
    const enumSet = await configMod.performConfigSet("security.secretScan", "strict");
    expect(enumSet.status).toBe("success");
    if (enumSet.status === "success") expect(enumSet.newValue).toBe("strict");

    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.secretScan).toBe("strict");
  });

  test("performConfigSet sets an array value from JSON", async () => {
    const result = await configMod.performConfigSet(
      "security.allowSecretValues",
      '["AKIAEXAMPLE","ghp_example"]',
    );
    expect(result.status).toBe("success");
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.allowSecretValues).toEqual(["AKIAEXAMPLE", "ghp_example"]);
  });

  test("performConfigSet refuses a catastrophic-tier value even in allowSecretValues", async () => {
    // allowSecretValues is exempt from ordinary-token detection, but the age
    // key that decrypts the vault must never land in plaintext agentsync.toml —
    // otherwise it would bypass the always-block guarantee at push time.
    const ageKey = `AGE-SECRET-KEY-1${"A".repeat(58)}`;
    const result = await configMod.performConfigSet(
      "security.allowSecretValues",
      JSON.stringify([ageKey]),
    );
    expect(result.status).toBe("invalid-value");
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.allowSecretValues).toEqual([]);
  });

  test("performConfigSet rejects a JSON-escaped catastrophic value (decoded scan)", async () => {
    // The persisted value is parseScalar(rawValue), so a unicode-escaped age
    // key would pass a raw-string scan but decode to a real secret on disk.
    // Scanning the decoded value closes that bypass.
    const ageKey = `AGE-SECRET-KEY-1${"A".repeat(58)}`;
    const escaped = `["\\u0041${ageKey.slice(1)}"]`; // A decodes to "A"
    const result = await configMod.performConfigSet("security.allowSecretValues", escaped);
    expect(result.status).toBe("invalid-value");
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.allowSecretValues).toEqual([]);
  });

  test("performConfigSet refuses protected sections", async () => {
    for (const key of ["version", "recipients.config-test", "remote.url"]) {
      const result = await configMod.performConfigSet(key, "x");
      expect(result.status).toBe("not-settable");
    }
  });

  test("performConfigSet rejects an unknown key under a settable section", async () => {
    const result = await configMod.performConfigSet("agents.cluade", "true");
    expect(result.status).toBe("unknown-key");
  });

  test("performConfigSet rejects a value the schema forbids", async () => {
    const badEnum = await configMod.performConfigSet("security.secretScan", "loud");
    expect(badEnum.status).toBe("invalid-value");

    // The vault config is unchanged after a rejected set.
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.secretScan).toBe("standard");
  });

  test("performConfigSet coerces a false boolean", async () => {
    const result = await configMod.performConfigSet("agents.claude", "false");
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.newValue).toBe(false);
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.agents.claude).toBe(false);
  });

  test("performConfigSet refuses a prototype-pollution key and leaves Object.prototype intact", async () => {
    const result = await configMod.performConfigSet(
      "security.__proto__.toLocaleString",
      '"polluted"',
    );
    // Rejected before any write: the prototype-walk segment is not an own key.
    expect(result.status).toBe("unknown-key");
    // The global prototype is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.toLocaleString).toBeInstanceOf(Function);
  });

  test("performConfigSet pushes the change to the remote vault", async () => {
    const result = await configMod.performConfigSet("agents.vscode", "true");
    expect(result.status).toBe("success");
    // Inspect the bare remote directly — the change must land there, not just
    // in the local working copy, because agentsync.toml is shared across machines.
    const onRemote = runGit(["show", "HEAD:agentsync.toml"], bare);
    expect(onRemote).toContain("vscode = true");
  });

  test("performConfigSet fails closed on diverged history", async () => {
    // Advance the remote independently from a second clone.
    const otherClone = join(tmpDir, "other-clone");
    runGit(["clone", bare, otherClone]);
    runGit(["config", "user.email", "t@t.local"], otherClone);
    runGit(["config", "user.name", "t"], otherClone);
    writeFileSync(join(otherClone, "remote-extra.txt"), "remote\n", "utf8");
    runGit(["add", "."], otherClone);
    runGit(["commit", "-m", "remote advance"], otherClone);
    runGit(["push", "origin", "main"], otherClone);

    // Advance the local vault on a divergent commit.
    writeFileSync(join(machine.vaultDir, "local-extra.txt"), "local\n", "utf8");
    runGit(["add", "."], machine.vaultDir);
    runGit(["commit", "-m", "local advance"], machine.vaultDir);

    const result = await configMod.performConfigSet("agents.vscode", "true");
    expect(result.status).toBe("failed");
  });

  test("performConfigSet refuses a literal secret pasted into a config value", async () => {
    // A GitHub classic PAT shape pasted into the wrong field. agentsync.toml is
    // committed in plaintext, so this must be rejected before any write.
    const token = `ghp_${"a".repeat(36)}`;
    const result = await configMod.performConfigSet("agents.vscode", token);
    expect(result.status).toBe("invalid-value");
    if (result.status === "invalid-value") expect(result.error).toMatch(/secret/i);
  });

  test("performConfigSet allows secret-shaped values in the allowlist (its purpose)", async () => {
    const token = `ghp_${"b".repeat(36)}`;
    const result = await configMod.performConfigSet("security.allowSecretValues", `["${token}"]`);
    expect(result.status).toBe("success");
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.security.allowSecretValues).toEqual([token]);
  });
});
