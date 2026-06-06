import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApplyPlan,
  applySingleArtifact,
  defineFileArtifact,
  NoMatchingArtifactError,
} from "../../agents/_apply";
import { machineVaultRoot } from "../../config/paths";
import { encryptString } from "../../core/encryptor";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  runGit,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";

const RUNTIME_ENV_KEYS = [
  "AGENTSYNC_VAULT_DIR",
  "AGENTSYNC_KEY_PATH",
  "AGENTSYNC_MACHINE",
  "AGENTSYNC_MACHINE_FILE",
];

// ── applySingleArtifact — the copy primitive (fake plan, no local-disk apply) ──

describe("applySingleArtifact", () => {
  let tmpDir: string;
  let machineRoot: string;
  let key: string;
  let recipient: string;
  const applied: { name: string; content: string }[] = [];

  /** A plan with a top-level file directive and a skills dir directive whose
   *  apply handlers record their inputs instead of writing to disk. */
  function makePlan(): ApplyPlan {
    return {
      agent: "claude",
      directives: [
        defineFileArtifact({
          vaultName: "CLAUDE.md.age",
          dryRunLabel: "[dry-run] [claude] would apply CLAUDE.md",
          apply: async (decrypted) => {
            applied.push({ name: "CLAUDE.md", content: decrypted });
          },
        }),
        {
          kind: "dir",
          subdir: "skills",
          suffix: ".tar.age",
          dryRunVerb: "would extract skill:",
          apply: async (name, decrypted) => {
            applied.push({ name, content: decrypted });
          },
          filter: (name) => (name === "bad" ? { reason: "blocked name" } : null),
        },
      ],
    };
  }

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    machineRoot = join(tmpDir, "machines", "host-a");
    const { identity, recipient: r } = await createMachineFixture(tmpDir, "ignored");
    key = identity;
    recipient = r;
    applied.length = 0;
    await mkdir(join(machineRoot, "claude", "skills"), { recursive: true });
    await writeFile(
      join(machineRoot, "claude", "CLAUDE.md.age"),
      await encryptString("# rules", [recipient]),
      "utf8",
    );
    await writeFile(
      join(machineRoot, "claude", "skills", "good.tar.age"),
      await encryptString("skill-bytes", [recipient]),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applies a top-level file artifact", async () => {
    await applySingleArtifact(makePlan(), "claude/CLAUDE.md.age", machineRoot, key, false);
    expect(applied).toEqual([{ name: "CLAUDE.md", content: "# rules" }]);
  });

  test("applies a subdir artifact, passing the bare name", async () => {
    await applySingleArtifact(makePlan(), "claude/skills/good.tar.age", machineRoot, key, false);
    expect(applied).toEqual([{ name: "good", content: "skill-bytes" }]);
  });

  test("dry-run writes nothing", async () => {
    await applySingleArtifact(makePlan(), "claude/CLAUDE.md.age", machineRoot, key, true);
    expect(applied).toEqual([]);
  });

  test("throws when no directive owns the path", async () => {
    await expect(
      applySingleArtifact(makePlan(), "claude/unknown.age", machineRoot, key, false),
    ).rejects.toBeInstanceOf(NoMatchingArtifactError);
  });

  test("throws when the filter rejects the name", async () => {
    await writeFile(
      join(machineRoot, "claude", "skills", "bad.tar.age"),
      await encryptString("x", [recipient]),
      "utf8",
    );
    await expect(
      applySingleArtifact(makePlan(), "claude/skills/bad.tar.age", machineRoot, key, false),
    ).rejects.toThrow("blocked name");
  });

  test("rejects a path outside the plan's agent", async () => {
    await expect(
      applySingleArtifact(makePlan(), "cursor/mcp.json.age", machineRoot, key, false),
    ).rejects.toThrow("not under claude/");
  });

  test("rejects a nested (plugins-style) path", async () => {
    await expect(
      applySingleArtifact(makePlan(), "claude/plugins/foo/mcp.json.age", machineRoot, key, false),
    ).rejects.toThrow("nested");
  });
});

// ── performCopy — machine resolution + error paths (seeded v2 vault) ──

describe("performCopy", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  let copyMod: typeof import("../copy");
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "host-self");
    seedVaultRepo({ machine, bareRepoPath });
    // Give the source machine a populated namespace by hand (a real artifact
    // is not needed for the resolution/error paths under test here).
    runGit(["config", "user.name", "t"], machine.vaultDir);
    runGit(["config", "user.email", "t@t"], machine.vaultDir);

    for (const k of RUNTIME_ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;
    process.env.AGENTSYNC_MACHINE_FILE = machine.machineFilePath;
    copyMod = await import("../copy");
  });

  afterEach(async () => {
    for (const k of RUNTIME_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("unknown machine lists available namespaces", async () => {
    // host-self has not pushed yet, so machines/ is empty.
    const result = await copyMod.performCopy({ fromMachine: "ghost", vaultPath: "claude/x.age" });
    expect(result.status).toBe("unknown-machine");
    if (result.status === "unknown-machine") expect(result.provided).toBe("ghost");
  });

  test("`self` resolves to this machine's namespace", async () => {
    // Seed this machine's own namespace so `self` resolves and the artifact is found.
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "claude"), { recursive: true });
    await writeFile(
      join(root, "claude", "CLAUDE.md.age"),
      await encryptString("# self rules", [machine.recipient]),
      "utf8",
    );
    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "claude/CLAUDE.md.age",
      dryRun: true,
    });
    expect(result.status).toBe("applied");
    if (result.status === "applied") {
      expect(result.dryRun).toBe(true);
      expect(result.count).toBe(1);
    }
  });

  test("missing artifact in a known namespace is not-found", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "claude"), { recursive: true });
    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "claude/missing.age",
    });
    expect(result.status).toBe("not-found");
  });

  test("unknown agent in the path is rejected", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "nope"), { recursive: true });
    await writeFile(join(root, "nope", "x.age"), "bytes", "utf8");
    const result = await copyMod.performCopy({ fromMachine: "self", vaultPath: "nope/x.age" });
    expect(result.status).toBe("unknown-agent");
  });

  test("directory-prefix copy applies every artifact beneath it (dry-run)", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "claude", "skills"), { recursive: true });
    await writeFile(
      join(root, "claude", "skills", "a.tar.age"),
      await encryptString("a", [machine.recipient]),
      "utf8",
    );
    await writeFile(
      join(root, "claude", "skills", "b.tar.age"),
      await encryptString("b", [machine.recipient]),
      "utf8",
    );
    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "claude/skills/",
      dryRun: true,
    });
    expect(result.status).toBe("applied");
    if (result.status === "applied") expect(result.count).toBe(2);
  });

  test("a directory sweep skips entries no directive owns (plugins) and applies the rest", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "claude", "plugins", "foo"), { recursive: true });
    await writeFile(
      join(root, "claude", "CLAUDE.md.age"),
      await encryptString("# rules", [machine.recipient]),
      "utf8",
    );
    // A nested plugin artifact is not copyable; the sweep must skip it, not abort.
    await writeFile(
      join(root, "claude", "plugins", "foo", "mcp.json.age"),
      await encryptString("{}", [machine.recipient]),
      "utf8",
    );
    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "claude/",
      dryRun: true,
    });
    expect(result.status).toBe("applied");
    if (result.status === "applied") expect(result.count).toBe(1);
  });

  test("a directory sweep honours the enabled gate (marketplace skipped when off)", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "claude"), { recursive: true });
    await writeFile(
      join(root, "claude", "CLAUDE.md.age"),
      await encryptString("# rules", [machine.recipient]),
      "utf8",
    );
    // syncMarketplace defaults to false, so a sweep must skip marketplace.json
    // even though an explicit single-file copy would apply it.
    await writeFile(
      join(root, "claude", "marketplace.json.age"),
      await encryptString("{}", [machine.recipient]),
      "utf8",
    );
    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "claude/",
      dryRun: true,
    });
    expect(result.status).toBe("applied");
    if (result.status === "applied") expect(result.count).toBe(1);
  });

  test("a sweep where every entry is unownable returns not-copyable", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "claude", "plugins", "foo"), { recursive: true });
    await writeFile(
      join(root, "claude", "plugins", "foo", "mcp.json.age"),
      await encryptString("{}", [machine.recipient]),
      "utf8",
    );
    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "claude/",
      dryRun: true,
    });
    expect(result.status).toBe("not-copyable");
  });
});
