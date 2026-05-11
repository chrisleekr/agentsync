import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";
import { __setPullAgentsForTesting, performPull } from "../pull";

// Force the rest of this file to use the real fs/promises, undoing any
// module-level fs mocks from earlier test files in the same Bun worker.
{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: deliberate alias to bypass mock cache
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

const RUNTIME_ENV_KEYS = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"];

describe("performPull", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "pull-shape-machine");
    seedVaultRepo({ machine, bareRepoPath, agents: { claude: true } });

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;
  });

  afterEach(async () => {
    __setPullAgentsForTesting(null);
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("accepts force option and returns valid result shape", async () => {
    // performPull catches non-fatal failures internally and returns a result
    // object so the CLI can decide how to surface errors; only the ENOENT
    // missing-vault path exits via loadVaultConfigOrExit. We seed a vault so
    // this run exercises the result-shape contract rather than the exit path.
    const result = await performPull({ force: true, dryRun: true });

    expect(result).toHaveProperty("applied");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("fatal");
    expect(typeof result.applied).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.fatal).toBe("boolean");
  });
});

describe("performPull recipient-handoff error UX", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "second-machine");
    seedVaultRepo({ machine, bareRepoPath, agents: { claude: true } });

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;
  });

  afterEach(async () => {
    __setPullAgentsForTesting(null);
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

  test("translates raw age recipient-mismatch into a copy-pasteable key add hint", async () => {
    // Install a fake agent whose apply() raises the literal age library error
    // a real second-machine pull would see. This proves the catch path in
    // performPull recognises the marker without standing up a foreign-keyed
    // .age artifact (which would require reaching into the age library
    // internals to encrypt for someone else's recipient).
    __setPullAgentsForTesting([
      {
        name: "claude",
        snapshot: async () => ({ artifacts: [], warnings: [] }),
        apply: async () => {
          throw new Error("no identity matched any of the file's recipients");
        },
      },
    ]);

    const result = await performPull({});

    expect(result.fatal).toBe(true);
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    const message = result.errors[0] ?? "";
    expect(message).toContain("agentsync key add");
    expect(message).toContain(machine.machineName);
    expect(message).toContain(machine.recipient);
    expect(message).not.toMatch(/^no identity matched/);
  });

  test("non-age errors still propagate as-is so other failure modes stay visible", async () => {
    __setPullAgentsForTesting([
      {
        name: "claude",
        snapshot: async () => ({ artifacts: [], warnings: [] }),
        apply: async () => {
          throw new Error("disk full");
        },
      },
    ]);

    const result = await performPull({});
    expect(result.fatal).toBe(true);
    expect(result.errors[0]).toContain("disk full");
    expect(result.errors[0] ?? "").not.toContain("agentsync key add");
  });
});
