import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApplyPlan,
  applySingleArtifact,
  defineFileArtifact,
  NoMatchingArtifactError,
} from "../../agents/_apply";
import { loadConfig, resolveConfigPath, writeConfig } from "../../config/loader";
import { AgentPaths, machineVaultRoot } from "../../config/paths";
import { encryptString } from "../../core/encryptor";
import { archiveDirectory } from "../../core/tar";
import { OPEN_CODE_SKILL_FLAGS } from "../../opencode/runtime-flags";
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
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_TUI_CONFIG",
  "OPENCODE_PERMISSION",
  "OPENCODE_TEST_HOME",
  "OPENCODE_DISABLE_AUTOCOMPACT",
  "OPENCODE_DISABLE_PRUNE",
  "OPENCODE_TEST_MANAGED_CONFIG_DIR",
  ...OPEN_CODE_SKILL_FLAGS,
];

type MutableOpenCodePaths = { configDir: string; homeConfigDir: string };
const mutableOpenCodePaths = AgentPaths.opencode as MutableOpenCodePaths;
const originalOpenCodeConfigDir = mutableOpenCodePaths.configDir;
const originalOpenCodeHomeConfigDir = mutableOpenCodePaths.homeConfigDir;
const originalLstat = fsPromises.lstat;
let managedPreferencesLstatSpy: { mockRestore(): void } | undefined;

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
    for (const key of RUNTIME_ENV_KEYS.filter((key) => key.startsWith("OPENCODE_"))) {
      delete process.env[key];
    }
    mutableOpenCodePaths.configDir = join(tmpDir, "opencode-target");
    mutableOpenCodePaths.homeConfigDir = join(tmpDir, ".opencode");
    process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = join(tmpDir, "managed-opencode");
    process.env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "true";
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "true";
    if (process.platform === "darwin") {
      managedPreferencesLstatSpy = spyOn(fsPromises, "lstat").mockImplementation((async (
        path,
        options,
      ) => {
        if (String(path).startsWith("/Library/Managed Preferences/")) {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        }
        return originalLstat(path, options);
      }) as typeof originalLstat);
    }
    copyMod = await import("../copy");
  });

  afterEach(async () => {
    managedPreferencesLstatSpy?.mockRestore();
    managedPreferencesLstatSpy = undefined;
    for (const k of RUNTIME_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    mutableOpenCodePaths.configDir = originalOpenCodeConfigDir;
    mutableOpenCodePaths.homeConfigDir = originalOpenCodeHomeConfigDir;
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

  test.each([
    "artifact",
    "ancestor",
  ] as const)("OpenCode copy rejects a symlinked vault %s before reading it", async (kind) => {
    if (process.platform === "win32") return;
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    const outside = join(tmpDir, `outside-${kind}`);
    await mkdir(join(outside, "default"), { recursive: true });
    await writeFile(
      join(outside, "default", "AGENTS.md.age"),
      await encryptString("outside", [machine.recipient]),
      "utf8",
    );
    if (kind === "ancestor") {
      await mkdir(root, { recursive: true });
      await symlink(outside, join(root, "opencode"));
    } else {
      await mkdir(join(root, "opencode", "default"), { recursive: true });
      await symlink(
        join(outside, "default", "AGENTS.md.age"),
        join(root, "opencode", "default", "AGENTS.md.age"),
      );
    }

    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "opencode/default/AGENTS.md.age",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("symbolic link");
  });

  test("OpenCode preflight reports OPENCODE_PERMISSION before decrypting", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "opencode", "default"), { recursive: true });
    await writeFile(join(root, "opencode", "default", "AGENTS.md.age"), "not ciphertext", "utf8");
    process.env.OPENCODE_PERMISSION = "{}";

    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "opencode/default/AGENTS.md.age",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("OPENCODE_PERMISSION");
  });

  test.each([
    "OPENCODE_TEST_HOME",
    "OPENCODE_CONFIG_DIR",
  ] as const)("OpenCode preflight rejects exported-empty %s before decrypting", async (name) => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "opencode", "default"), { recursive: true });
    await writeFile(join(root, "opencode", "default", "AGENTS.md.age"), "not ciphertext", "utf8");
    process.env[name] = "";

    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "opencode/default/AGENTS.md.age",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain(name);
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("OpenCode namespace copy rejects a descendant source symlink before any write", async () => {
    if (process.platform === "win32") return;
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    const outside = join(tmpDir, "outside-descendant.age");
    await writeFile(outside, await encryptString("outside", [machine.recipient]), "utf8");
    await mkdir(join(root, "opencode", "default", "commands"), { recursive: true });
    await writeFile(
      join(root, "opencode", "default", "AGENTS.md.age"),
      await encryptString("valid earlier", [machine.recipient]),
      "utf8",
    );
    await symlink(outside, join(root, "opencode", "default", "commands", "linked.md.age"));

    const result = await copyMod.performCopy({ fromMachine: "self", vaultPath: "opencode/" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("symbolic link");
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("OpenCode directory copy rejects duplicate normalized identities before any write", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "opencode", "default", "command"), { recursive: true });
    await mkdir(join(root, "opencode", "default", "commands"), { recursive: true });
    await writeFile(
      join(root, "opencode", "default", "command", "Review.md.age"),
      await encryptString("first", [machine.recipient]),
      "utf8",
    );
    await writeFile(
      join(root, "opencode", "default", "commands", "review.md.age"),
      await encryptString("second", [machine.recipient]),
      "utf8",
    );

    const result = await copyMod.performCopy({ fromMachine: "self", vaultPath: "opencode/" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("Duplicate OpenCode command");
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "command", "Review.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "commands", "review.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("OpenCode directory copy rejects a file and descendant target before any write", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "opencode", "default", "commands", "foo.md"), { recursive: true });
    await writeFile(join(root, "opencode", "default", "AGENTS.md.age"), "not ciphertext", "utf8");
    await writeFile(join(root, "opencode", "default", "commands", "foo.md.age"), "first", "utf8");
    await writeFile(
      join(root, "opencode", "default", "commands", "foo.md", "bar.md.age"),
      "second",
      "utf8",
    );

    const result = await copyMod.performCopy({ fromMachine: "self", vaultPath: "opencode/" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("file/directory collision");
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "commands", "foo.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("OpenCode directory copy validates a later malformed skill before writing an earlier file", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "opencode", "default", "skills"), { recursive: true });
    await writeFile(
      join(root, "opencode", "default", "AGENTS.md.age"),
      await encryptString("valid earlier", [machine.recipient]),
      "utf8",
    );
    await writeFile(
      join(root, "opencode", "default", "skills", "z-bad.tar.age"),
      await encryptString("not a tar archive", [machine.recipient]),
      "utf8",
    );

    const result = await copyMod.performCopy({ fromMachine: "self", vaultPath: "opencode/" });
    expect(result.status).toBe("error");
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
  });

  test.each([
    {
      name: "never-sync auth.json",
      file: "auth.json",
      content: '{"token":"x"}',
      secretScan: "standard" as const,
      message: "never-sync inside skill",
    },
    {
      name: "policy-detected literal",
      file: "notes.md",
      content: `ghp_${"p".repeat(36)}`,
      secretScan: "standard" as const,
      message: "Detected literal secret",
    },
    {
      name: "catastrophic literal with scanning off",
      file: "key.pem",
      content: `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`,
      secretScan: "off" as const,
      message: "Detected literal secret",
    },
  ])("OpenCode copy rejects $name before any write", async (item) => {
    const configPath = resolveConfigPath(machine.vaultDir);
    const config = await loadConfig(configPath);
    config.security.secretScan = item.secretScan;
    await writeConfig(configPath, config);
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "opencode", "default", "skills"), { recursive: true });
    await writeFile(
      join(root, "opencode", "default", "AGENTS.md.age"),
      await encryptString("valid earlier", [machine.recipient]),
      "utf8",
    );
    const source = join(tmpDir, `unsafe-${item.file.replace(".", "-")}`);
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: unsafe\ndescription: unsafe\n---\n",
      "utf8",
    );
    await writeFile(join(source, item.file), item.content, "utf8");
    const archive = await archiveDirectory(source);
    await writeFile(
      join(root, "opencode", "default", "skills", "unsafe.tar.age"),
      await encryptString(archive.toString("base64"), [machine.recipient]),
      "utf8",
    );

    const result = await copyMod.performCopy({ fromMachine: "self", vaultPath: "opencode/" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain(item.message);
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "skills", "unsafe", "SKILL.md"), "utf8"),
    ).rejects.toThrow();
  });

  test("OpenCode copy rejects an unsafe JSONC key before writing an earlier file", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "opencode", "default"), { recursive: true });
    await writeFile(
      join(root, "opencode", "default", "AGENTS.md.age"),
      await encryptString("valid earlier", [machine.recipient]),
      "utf8",
    );
    await writeFile(
      join(root, "opencode", "default", "opencode.json.age"),
      await encryptString('{ "nested": { "__proto__": { "polluted": true } } }', [
        machine.recipient,
      ]),
      "utf8",
    );

    const result = await copyMod.performCopy({ fromMachine: "self", vaultPath: "opencode/" });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error).toContain("unsafe key");
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "AGENTS.md"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(mutableOpenCodePaths.configDir, "opencode.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("OpenCode copy does not replace a sidecar file with an empty archive directory", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    const source = join(tmpDir, "skill-with-empty-directory");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: helper\ndescription: helper\n---\n",
      "utf8",
    );
    const archive = await archiveDirectory(source);
    await mkdir(join(root, "opencode", "default", "skills"), { recursive: true });
    await writeFile(
      join(root, "opencode", "default", "skills", "helper.tar.age"),
      await encryptString(archive.toString("base64"), [machine.recipient]),
      "utf8",
    );
    const existingSkill = join(mutableOpenCodePaths.configDir, "skills", "helper");
    await mkdir(existingSkill, { recursive: true });
    await writeFile(join(existingSkill, "references"), "unchanged", "utf8");

    const result = await copyMod.performCopy({
      fromMachine: "self",
      vaultPath: "opencode/default/skills/helper.tar.age",
    });
    expect(result.status).toBe("error");
    expect(await readFile(join(existingSkill, "references"), "utf8")).toBe("unchanged");
    await expect(readFile(join(existingSkill, "SKILL.md"), "utf8")).rejects.toThrow();
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

  test("a directory sweep skips the plugin manifest (no apply directive owns it)", async () => {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "claude"), { recursive: true });
    await writeFile(
      join(root, "claude", "CLAUDE.md.age"),
      await encryptString("# rules", [machine.recipient]),
      "utf8",
    );
    // plugins.manifest.json.age has no apply directive — it drives `plugin
    // install`, not pull — so a sweep applies CLAUDE.md and skips the manifest.
    await writeFile(
      join(root, "claude", "plugins.manifest.json.age"),
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
