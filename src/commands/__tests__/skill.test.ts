/**
 * Tests for the `agentsync skill remove` CLI verb (T023).
 *
 * These tests exercise the testable core `performSkillRemove` directly — they
 * do not mock git because `performSkillRemove` uses a real `GitClient` against
 * a tmp bare-repo + working-repo pair built by `createBareRepo` +
 * `seedVaultRepo`. The goal is to prove every row in
 * `specs/.../contracts/skill-remove-cli.md` end-to-end.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
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
  mock.module("node:fs/promises", () => realFsPromises);
}

// Mute @clack/prompts so log output doesn't pollute the test runner.
const fakeLogs = {
  success: [] as string[],
  info: [] as string[],
  warn: [] as string[],
  error: [] as string[],
};

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  log: {
    success: (m: string) => {
      fakeLogs.success.push(m);
    },
    info: (m: string) => {
      fakeLogs.info.push(m);
    },
    warn: (m: string) => {
      fakeLogs.warn.push(m);
    },
    error: (m: string) => {
      fakeLogs.error.push(m);
    },
  },
  note: () => {},
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

type MutableClaudePaths = {
  claudeMd: string;
  settingsJson: string;
  commandsDir: string;
  agentsDir: string;
  mcpJson: string;
  credentials: string;
  skillsDir: string;
};
const mutableClaudePaths = AgentPaths.claude as MutableClaudePaths;

type SkillMod = typeof import("../skill");
let skillMod: SkillMod;

const RUNTIME_ENV_KEYS = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"];

beforeAll(async () => {
  skillMod = await import("../skill");
});

afterAll(() => {
  mock.restore();
});

describe("performSkillRemove — contract rows (T023)", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};
  const savedClaude = {
    claudeMd: mutableClaudePaths.claudeMd,
    settingsJson: mutableClaudePaths.settingsJson,
    commandsDir: mutableClaudePaths.commandsDir,
    agentsDir: mutableClaudePaths.agentsDir,
    mcpJson: mutableClaudePaths.mcpJson,
    credentials: mutableClaudePaths.credentials,
    skillsDir: mutableClaudePaths.skillsDir,
  };

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "skill-remove-test");

    // Point Claude at an isolated tmp $HOME so no real files leak in.
    const claudeHome = join(tmpDir, "claude-home");
    mutableClaudePaths.claudeMd = join(claudeHome, "CLAUDE.md");
    mutableClaudePaths.settingsJson = join(claudeHome, "settings.json");
    mutableClaudePaths.commandsDir = join(claudeHome, "commands");
    mutableClaudePaths.agentsDir = join(claudeHome, "agents");
    mutableClaudePaths.mcpJson = join(claudeHome, ".claude.json");
    mutableClaudePaths.credentials = join(claudeHome, ".credentials.json");
    mutableClaudePaths.skillsDir = join(claudeHome, "skills");

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;

    seedVaultRepo({
      machine,
      bareRepoPath,
      agents: { claude: true, copilot: false },
    });

    fakeLogs.success.length = 0;
    fakeLogs.info.length = 0;
    fakeLogs.warn.length = 0;
    fakeLogs.error.length = 0;
    process.exitCode = 0;
  });

  afterEach(async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    mutableClaudePaths.claudeMd = savedClaude.claudeMd;
    mutableClaudePaths.settingsJson = savedClaude.settingsJson;
    mutableClaudePaths.commandsDir = savedClaude.commandsDir;
    mutableClaudePaths.agentsDir = savedClaude.agentsDir;
    mutableClaudePaths.mcpJson = savedClaude.mcpJson;
    mutableClaudePaths.credentials = savedClaude.credentials;
    mutableClaudePaths.skillsDir = savedClaude.skillsDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("success path — removes the vault file, commits, and leaves local alone", async () => {
    // Seed vault with one encrypted skill artifact so the remove path has
    // something to delete. The content does not need to decrypt — the verb
    // only `stat`s the file and then unlinks it. The file must be committed
    // (and pushed) first so that the subsequent unlink+commit actually has a
    // file to remove from git's index.
    const skillsVaultDir = join(machine.vaultDir, "claude", "skills");
    mkdirSync(skillsVaultDir, { recursive: true });
    writeFileSync(join(skillsVaultDir, "my-skill.tar.age"), "placeholder-bytes", "utf8");
    runGit(["add", "."], machine.vaultDir);
    runGit(["commit", "-m", "seed: my-skill artifact"], machine.vaultDir);
    runGit(["push", "origin", "main"], machine.vaultDir);

    // Sentinel: local skill directory with a real file that MUST survive.
    const localSkill = join(mutableClaudePaths.skillsDir, "my-skill");
    mkdirSync(localSkill, { recursive: true });
    writeFileSync(join(localSkill, "SKILL.md"), "# local content", "utf8");

    const result = await skillMod.performSkillRemove({ agent: "claude", name: "my-skill" });

    expect(result.status).toBe("success");
    // Vault file gone.
    expect(existsSync(join(skillsVaultDir, "my-skill.tar.age"))).toBe(false);
    // Local file still present (FR-012 leave-local-alone guarantee).
    expect(existsSync(join(localSkill, "SKILL.md"))).toBe(true);
    // A commit sha should be attached to the success result.
    if (result.status === "success") {
      expect(result.commitSha).not.toBeNull();
      expect(result.commitSha).toMatch(/^[0-9a-f]{7}$/);
    }
  });

  test("not-found path — exits with status 'not-found' when vault file is absent", async () => {
    // Vault has no claude/skills/ at all.
    const result = await skillMod.performSkillRemove({
      agent: "claude",
      name: "does-not-exist",
    });

    expect(result.status).toBe("not-found");
    if (result.status === "not-found") {
      expect(result.path).toContain("claude/skills/does-not-exist.tar.age");
    }
  });

  test("unknown-agent path — rejects vscode and other unrecognised agent strings", async () => {
    const result = await skillMod.performSkillRemove({ agent: "vscode", name: "anything" });

    expect(result.status).toBe("unknown-agent");
    if (result.status === "unknown-agent") {
      expect(result.provided).toBe("vscode");
      expect(result.supported).toEqual(["claude", "cursor", "codex", "copilot"]);
    }
  });

  test("leave-local-alone — even when the vault file is absent, the local skill is untouched", async () => {
    // Write a sentinel local skill. The command must not touch it regardless
    // of whether the vault file exists or not.
    const localSkill = join(mutableClaudePaths.skillsDir, "leave-alone");
    mkdirSync(localSkill, { recursive: true });
    writeFileSync(join(localSkill, "SKILL.md"), "# local sentinel", "utf8");

    await skillMod.performSkillRemove({ agent: "claude", name: "leave-alone" });

    // The local directory and sentinel file must still be present after the
    // command has run, regardless of the returned status.
    const info = await stat(join(localSkill, "SKILL.md"));
    expect(info.isFile()).toBe(true);
  });
});

describe("skillCommand — citty wrapper (T023 exit codes)", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "skill-cli-test");

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;

    seedVaultRepo({
      machine,
      bareRepoPath,
      agents: { claude: true, copilot: false },
    });

    fakeLogs.success.length = 0;
    fakeLogs.info.length = 0;
    fakeLogs.warn.length = 0;
    fakeLogs.error.length = 0;
    process.exitCode = 0;
  });

  afterEach(async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    process.exitCode = 0;
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Helper to invoke the `remove` subcommand's run callback directly. Citty
   * subCommands can be declared as objects or lazy resolvers; defineCommand
   * returns a plain object with a `.run` method in our usage.
   */
  async function runRemove(agent: string, name: string): Promise<void> {
    const subs = skillMod.skillCommand.subCommands as unknown as Record<
      string,
      { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
    >;
    await subs.remove.run({ args: { agent, name } });
  }

  test("unknown agent sets process.exitCode = 1 and logs the supported list", async () => {
    await runRemove("vscode", "anything");
    expect(process.exitCode).toBe(1);
    expect(fakeLogs.error.some((m) => m.includes("Unknown agent"))).toBe(true);
    expect(fakeLogs.error.some((m) => m.includes("claude"))).toBe(true);
  });

  test("not-found sets process.exitCode = 1 and prints the resolved path", async () => {
    await runRemove("claude", "does-not-exist");
    expect(process.exitCode).toBe(1);
    expect(fakeLogs.error.some((m) => m.includes("Skill not found"))).toBe(true);
    expect(fakeLogs.info.some((m) => m.includes("claude/skills/does-not-exist.tar.age"))).toBe(
      true,
    );
  });

  test("success leaves process.exitCode at 0 and logs the commit sha", async () => {
    const skillsVaultDir = join(machine.vaultDir, "claude", "skills");
    mkdirSync(skillsVaultDir, { recursive: true });
    writeFileSync(join(skillsVaultDir, "cli-skill.tar.age"), "placeholder", "utf8");
    runGit(["add", "."], machine.vaultDir);
    runGit(["commit", "-m", "seed: cli-skill artifact"], machine.vaultDir);
    runGit(["push", "origin", "main"], machine.vaultDir);

    await runRemove("claude", "cli-skill");

    expect(process.exitCode).toBe(0);
    expect(fakeLogs.success.some((m) => m.includes("Removed claude/cli-skill"))).toBe(true);
    expect(fakeLogs.success.some((m) => /commit [0-9a-f]{7}/.test(m))).toBe(true);
  });
});
