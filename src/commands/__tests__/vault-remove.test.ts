/**
 * Tests for the generalised `performVaultRemove` core — the primitive that
 * removes any vault artifact (skills, commands, configs, rules), not just
 * skills. Exercises it against a real GitClient over a tmp bare-repo +
 * working-repo pair, mirroring skill.test.ts. The skill-specific wrapper
 * (`performSkillRemove`) has its own coverage in skill.test.ts; here we focus
 * on the non-skill paths and the path-traversal gate unique to this core.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { machineVaultRoot } from "../../config/paths";
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

type VaultRemoveMod = typeof import("../vault-remove");
let mod: VaultRemoveMod;

const RUNTIME_ENV_KEYS = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"];

describe("performVaultRemove", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    mod = await import("../vault-remove");
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "vault-remove-test");

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;

    seedVaultRepo({ machine, bareRepoPath, agents: { claude: true, copilot: false } });
    process.exitCode = 0;
  });

  // Cleanup MUST run in afterEach (not at the end of each test body) so a
  // failing assertion can't leak AGENTSYNC_* env into later test files — that
  // leak is what previously broke machines.test.ts.
  afterEach(async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.restore();
  });

  test("success — removes a non-skill vault artifact and commits", async () => {
    const machineRoot = machineVaultRoot(machine.vaultDir, machine.machineName);
    const commandsDir = join(machineRoot, "claude", "commands");
    mkdirSync(commandsDir, { recursive: true });
    const vaultRelPath = "claude/commands/pr-commit-message.md.age";
    writeFileSync(join(machineRoot, vaultRelPath), "placeholder-bytes", "utf8");
    runGit(["add", "."], machine.vaultDir);
    runGit(["commit", "-m", "seed: a command artifact"], machine.vaultDir);
    runGit(["push", "origin", "main"], machine.vaultDir);

    const result = await mod.performVaultRemove({ vaultRelPath });

    expect(result.status).toBe("success");
    expect(existsSync(join(machineRoot, vaultRelPath))).toBe(false);
    if (result.status === "success") {
      expect(result.commitSha).toMatch(/^[0-9a-f]{7}$/);
    }
  });

  test("not-found — when the vault artifact is absent", async () => {
    const result = await mod.performVaultRemove({
      vaultRelPath: "claude/commands/does-not-exist.md.age",
    });
    expect(result.status).toBe("not-found");
  });

  test("invalid-path — rejects traversal before touching the vault", async () => {
    for (const bad of ["../escape.age", "claude/../../etc/passwd", "..", ""]) {
      const result = await mod.performVaultRemove({ vaultRelPath: bad });
      expect(result.status).toBe("invalid-path");
    }
  });

  test("invalid-machine — rejects a path-traversal --machine", async () => {
    const result = await mod.performVaultRemove({
      vaultRelPath: "claude/commands/x.md.age",
      machine: "..",
    });
    expect(result.status).toBe("invalid-machine");
  });
});
