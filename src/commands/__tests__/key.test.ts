/**
 * Tests for the `agentsync key` verbs: `remove`, `list`, and `rotate`
 * crash-safety / round-trip.
 *
 * Like skill.test.ts, these exercise the testable cores (`performKeyRemove`,
 * `performKeyList`, `performKeyRotate`) directly against a tmp bare-repo +
 * working-repo pair, with no git mocking, so every documented outcome is proven
 * end-to-end including the actual age re-encryption.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadConfig, resolveConfigPath } from "../../config/loader";
import { machineVaultRoot } from "../../config/paths";
import { decryptString, encryptString } from "../../core/encryptor";
import {
  createAgeIdentity,
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

type KeyMod = typeof import("../key");
let keyMod: KeyMod;

const RUNTIME_ENV_KEYS = [
  "AGENTSYNC_VAULT_DIR",
  "AGENTSYNC_KEY_PATH",
  "AGENTSYNC_MACHINE",
  "AGENTSYNC_MACHINE_FILE",
];

beforeEach(async () => {
  keyMod = await import("../key");
});

afterAll(() => {
  mock.restore();
});

/** Encrypt a payload to the given recipients, write it under the machine vault, commit, push. */
function seedEncryptedArtifact(
  machine: TestMachineFixture,
  relPath: string,
  plaintext: string,
  armored: string,
): void {
  const target = join(machineVaultRoot(machine.vaultDir, machine.machineName), relPath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, armored, "utf8");
  runGit(["add", "."], machine.vaultDir);
  runGit(["commit", "-m", `seed: ${relPath}`], machine.vaultDir);
  runGit(["push", "origin", "main"], machine.vaultDir);
}

describe("key lifecycle", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};

  async function setEnv(m: TestMachineFixture): Promise<void> {
    process.env.AGENTSYNC_VAULT_DIR = m.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = m.keyPath;
    process.env.AGENTSYNC_MACHINE = m.machineName;
    process.env.AGENTSYNC_MACHINE_FILE = m.machineFilePath;
  }

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    machine = await createMachineFixture(tmpDir, "key-test");
    for (const key of RUNTIME_ENV_KEYS) savedEnv[key] = process.env[key];
    process.exitCode = 0;
  });

  // Per-test afterEach is registered inline so each test restores env + tmp.
  function restore(): Promise<void> {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return rm(tmpDir, { recursive: true, force: true });
  }

  test("performKeyList returns recipients sorted and flags this machine", async () => {
    const bare = await createBareRepo(tmpDir);
    const other = await createAgeIdentity();
    seedVaultRepo({
      machine,
      bareRepoPath: bare,
      recipients: { "key-test": machine.recipient, "work-laptop": other.recipient },
    });
    await setEnv(machine);

    const entries = await keyMod.performKeyList();
    expect(entries.map((e) => e.name)).toEqual(["key-test", "work-laptop"]);
    expect(entries.find((e) => e.name === "key-test")?.isSelf).toBe(true);
    expect(entries.find((e) => e.name === "work-laptop")?.isSelf).toBe(false);
    await restore();
  });

  test("performKeyRemove revokes a recipient: remaining key decrypts, removed key cannot", async () => {
    const bare = await createBareRepo(tmpDir);
    const other = await createAgeIdentity();
    seedVaultRepo({
      machine,
      bareRepoPath: bare,
      recipients: { "key-test": machine.recipient, "work-laptop": other.recipient },
    });
    await setEnv(machine);

    const plaintext = "# shared CLAUDE.md";
    const armored = await encryptString(plaintext, [machine.recipient, other.recipient]);
    seedEncryptedArtifact(machine, join("claude", "CLAUDE.md.age"), plaintext, armored);

    const result = await keyMod.performKeyRemove({ name: "work-laptop" });
    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.remaining).toBe(1);

    // Config no longer lists the removed recipient.
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(config.recipients["work-laptop"]).toBeUndefined();
    expect(config.recipients["key-test"]).toBe(machine.recipient);

    // The artifact was re-encrypted: the local key still decrypts it, the
    // removed key no longer can.
    const reArmored = await readFile(
      join(machineVaultRoot(machine.vaultDir, machine.machineName), "claude", "CLAUDE.md.age"),
      "utf8",
    );
    expect(await decryptString(reArmored, machine.identity)).toBe(plaintext);
    await expect(decryptString(reArmored, other.identity)).rejects.toThrow();
    await restore();
  });

  test("performKeyRemove refuses to remove this machine's own key", async () => {
    const bare = await createBareRepo(tmpDir);
    const other = await createAgeIdentity();
    seedVaultRepo({
      machine,
      bareRepoPath: bare,
      recipients: { "key-test": machine.recipient, "work-laptop": other.recipient },
    });
    await setEnv(machine);

    const result = await keyMod.performKeyRemove({ name: "key-test" });
    expect(result.status).toBe("self");
    await restore();
  });

  test("performKeyRemove reports not-found for an unknown alias", async () => {
    const bare = await createBareRepo(tmpDir);
    seedVaultRepo({ machine, bareRepoPath: bare });
    await setEnv(machine);

    const result = await keyMod.performKeyRemove({ name: "ghost" });
    expect(result.status).toBe("not-found");
    if (result.status === "not-found") expect(result.available).toContain("key-test");
    await restore();
  });

  test("performKeyRemove refuses to remove the last recipient", async () => {
    const bare = await createBareRepo(tmpDir);
    const other = await createAgeIdentity();
    // Single recipient that is NOT the local key, so the self-guard does not
    // fire first and the last-recipient guard is exercised directly.
    seedVaultRepo({
      machine,
      bareRepoPath: bare,
      recipients: { "work-laptop": other.recipient },
    });
    await setEnv(machine);

    const result = await keyMod.performKeyRemove({ name: "work-laptop" });
    expect(result.status).toBe("last-recipient");
    await restore();
  });

  test("performKeyRotate round-trips: new key decrypts vault, old recipient dropped", async () => {
    const bare = await createBareRepo(tmpDir);
    seedVaultRepo({ machine, bareRepoPath: bare });
    await setEnv(machine);

    const plaintext = "# rotate round-trip";
    const armored = await encryptString(plaintext, [machine.recipient]);
    seedEncryptedArtifact(machine, join("claude", "CLAUDE.md.age"), plaintext, armored);

    const result = await keyMod.performKeyRotate();
    expect(result.status).toBe("success");

    const newIdentity = (await readFile(machine.keyPath, "utf8")).trim();
    expect(newIdentity).not.toBe(machine.identity);

    // New key decrypts the re-encrypted artifact; old identity cannot.
    const reArmored = await readFile(
      join(machineVaultRoot(machine.vaultDir, machine.machineName), "claude", "CLAUDE.md.age"),
      "utf8",
    );
    expect(await decryptString(reArmored, newIdentity)).toBe(plaintext);
    await expect(decryptString(reArmored, machine.identity)).rejects.toThrow();

    // The config recipient for this machine was replaced, old recipient gone.
    const config = await loadConfig(resolveConfigPath(machine.vaultDir));
    expect(Object.values(config.recipients)).not.toContain(machine.recipient);
    await restore();
  });

  test("performKeyRotate union pass keeps the vault readable when pass 2 fails mid-rotation", async () => {
    const bare = await createBareRepo(tmpDir);
    seedVaultRepo({ machine, bareRepoPath: bare });
    await setEnv(machine);

    const plaintext = "# rotate union safety";
    const armored = await encryptString(plaintext, [machine.recipient]);
    seedEncryptedArtifact(machine, join("claude", "CLAUDE.md.age"), plaintext, armored);

    // Inject a failure on the SECOND write to the .age artifact — that is the
    // new-only pass 2, which runs only after pass 1 (union ciphertext) and the
    // atomic key swap have already completed.
    const require = createRequire(import.meta.url);
    const realFs = require("fs/promises") as typeof import("node:fs/promises");
    let ageWrites = 0;
    const failingWriteFile = ((path: unknown, ...rest: unknown[]) => {
      if (typeof path === "string" && path.endsWith(".age")) {
        ageWrites += 1;
        if (ageWrites === 2) throw new Error("injected pass-2 failure");
      }
      return (realFs.writeFile as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof realFs.writeFile;
    mock.module("node:fs/promises", () => ({
      ...realFs,
      writeFile: failingWriteFile,
      default: { ...realFs, writeFile: failingWriteFile },
    }));

    const result = await keyMod.performKeyRotate();

    // Restore the plain real-fs mock for the rest of the suite.
    mock.module("node:fs/promises", () => ({ ...realFs, default: realFs }));

    expect(result.status).toBe("failed");
    // The key was already swapped (pass 1 wrote the union, then the key). The
    // on-disk artifact is still the union ciphertext, readable by the NEW key —
    // proving there is no crash window where no on-disk key can read the vault.
    const newIdentity = (await readFile(machine.keyPath, "utf8")).trim();
    expect(newIdentity).not.toBe(machine.identity);
    const onDisk = await readFile(
      join(machineVaultRoot(machine.vaultDir, machine.machineName), "claude", "CLAUDE.md.age"),
      "utf8",
    );
    expect(await decryptString(onDisk, newIdentity)).toBe(plaintext);
    await restore();
  });

  test("performKeyAdd rejects a pubkey already registered under another alias", async () => {
    const bare = await createBareRepo(tmpDir);
    const other = await createAgeIdentity();
    seedVaultRepo({
      machine,
      bareRepoPath: bare,
      recipients: { "key-test": machine.recipient, "work-laptop": other.recipient },
    });
    await setEnv(machine);

    const result = await keyMod.performKeyAdd({ name: "second-alias", pubkey: other.recipient });
    expect(result.status).toBe("duplicate-key");
    if (result.status === "duplicate-key") expect(result.existingName).toBe("work-laptop");
    await restore();
  });

  test("performKeyList degrades to not-self when the local key is unreadable", async () => {
    const bare = await createBareRepo(tmpDir);
    const other = await createAgeIdentity();
    seedVaultRepo({
      machine,
      bareRepoPath: bare,
      recipients: { "key-test": machine.recipient, "work-laptop": other.recipient },
    });
    await setEnv(machine);
    process.env.AGENTSYNC_KEY_PATH = join(tmpDir, "absent-key.txt");

    const entries = await keyMod.performKeyList();
    expect(entries.length).toBe(2);
    expect(entries.every((e) => !e.isSelf)).toBe(true);
    await restore();
  });
});
