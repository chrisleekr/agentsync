/**
 * Tests for `agentsync ls` — vault namespace + artifact discovery. Real git
 * fixtures, no mocking. Seeds two machine namespaces so the cross-machine
 * browse path (the point of the command) is exercised.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  log: { success: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  note: () => {},
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

type LsMod = typeof import("../ls");
let lsMod: LsMod;

const RUNTIME_ENV_KEYS = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"];

/** Write a placeholder .age file under a machine namespace (content need not decrypt). */
function seedArtifact(machine: TestMachineFixture, name: string, relPath: string): void {
  const target = join(machineVaultRoot(machine.vaultDir, name), relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "ciphertext-placeholder", "utf8");
}

describe("ls command", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  let bare: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    lsMod = await import("../ls");
    tmpDir = await createTmpDir();
    machine = await createMachineFixture(tmpDir, "config-test");
    bare = await createBareRepo(tmpDir);
    seedVaultRepo({ machine, bareRepoPath: bare });

    // Two machine namespaces: this machine (config-test) and a remote one.
    seedArtifact(machine, "config-test", join("codex", "AGENTS.md.age"));
    seedArtifact(machine, "work-laptop", join("claude", "CLAUDE.md.age"));
    seedArtifact(machine, "work-laptop", join("claude", "skills", "foo.tar.age"));
    runGit(["add", "."], machine.vaultDir);
    runGit(["commit", "-m", "seed namespaces"], machine.vaultDir);
    runGit(["push", "origin", "main"], machine.vaultDir);

    for (const key of RUNTIME_ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;
    process.exitCode = 0;
  });

  afterEach(async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("no machine lists every namespace", async () => {
    const result = await lsMod.performLs({});
    expect(result.kind).toBe("machines");
    if (result.kind === "machines") {
      expect(result.machines).toEqual(["config-test", "work-laptop"]);
    }
  });

  test("a machine lists its copyable artifact paths", async () => {
    const result = await lsMod.performLs({ machine: "work-laptop" });
    expect(result.kind).toBe("artifacts");
    if (result.kind === "artifacts") {
      expect(result.paths).toEqual(["claude/CLAUDE.md.age", "claude/skills/foo.tar.age"]);
    }
  });

  test("a path prefix narrows the listing", async () => {
    const result = await lsMod.performLs({ machine: "work-laptop", path: "claude/skills" });
    expect(result.kind).toBe("artifacts");
    if (result.kind === "artifacts") {
      expect(result.paths).toEqual(["claude/skills/foo.tar.age"]);
    }
  });

  test("self resolves to this machine's namespace", async () => {
    const result = await lsMod.performLs({ machine: "self" });
    expect(result.kind).toBe("artifacts");
    if (result.kind === "artifacts") {
      expect(result.paths).toEqual(["codex/AGENTS.md.age"]);
    }
  });

  test("an unknown machine lists the available ones", async () => {
    const result = await lsMod.performLs({ machine: "ghost" });
    expect(result.kind).toBe("unknown-machine");
    if (result.kind === "unknown-machine") {
      expect(result.available).toContain("work-laptop");
    }
  });

  test("an empty path reports empty", async () => {
    const result = await lsMod.performLs({ machine: "work-laptop", path: "cursor" });
    expect(result.kind).toBe("empty");
  });

  test("a traversal path cannot escape the machine namespace", async () => {
    // `..` segments must not enumerate .age files outside the namespace.
    const result = await lsMod.performLs({ machine: "work-laptop", path: "../../../../etc" });
    expect(result.kind).toBe("empty");
  });

  test("reports reconcile-error when vault history has diverged", async () => {
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

    const result = await lsMod.performLs({ machine: "work-laptop" });
    expect(result.kind).toBe("reconcile-error");
  });

  test("the CLI wrapper exits 1 on an unknown machine", async () => {
    process.exitCode = 0;
    await lsMod.lsCommand.run?.({
      args: { machine: "ghost" },
      rawArgs: [],
      cmd: {} as never,
    } as never);
    expect(process.exitCode).toBe(1);
  });
});
