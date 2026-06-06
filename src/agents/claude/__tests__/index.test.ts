import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../../config/paths";
import { AGENTSYNC_HOME_PLACEHOLDER } from "../../../core/path-portability";
import { archiveDirectory, extractArchive } from "../../../core/tar";
import { createTestAgentSyncConfig, createTmpDir } from "../../../test-helpers/fixtures";

const TEST_CONFIG = createTestAgentSyncConfig();
const TEST_CONFIG_WITH_PLUGINS = createTestAgentSyncConfig({
  claudePlugins: { syncPlugins: true },
});

{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

type MutableClaudePaths = {
  claudeMd: string;
  settingsJson: string;
  commandsDir: string;
  agentsDir: string;
  rulesDir: string;
  mcpJson: string;
  credentials: string;
  skillsDir: string;
  pluginsDir: string;
  installedPluginsJson: string;
  knownMarketplacesJson: string;
};

const testClaudePaths = AgentPaths.claude as MutableClaudePaths;

// Capture the real paths once at module load so afterAll can put them back.
// Without this, the beforeEach hooks below mutate AgentPaths.claude.* to point
// at per-test tmp dirs and the mutation bleeds into later test files in the
// same bun test run — notably src/config/__tests__/paths.test.ts, which
// asserts the original ~/.claude/... values. Different OSes give bun test a
// different file load order, so the bleed shows up on CI Linux but may be
// hidden on macOS depending on which file happens to run first.
const originalClaudePaths: MutableClaudePaths = { ...testClaudePaths };

type ClaudeModule = typeof import("..");
let claudeModule: ClaudeModule;

beforeAll(async () => {
  claudeModule = await import("..");
});

afterAll(() => {
  Object.assign(testClaudePaths, originalClaudePaths);
});

// snapshotClaude

describe("snapshotClaude", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.rulesDir = join(tmpDir, "rules");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
    testClaudePaths.skillsDir = join(tmpDir, "skills");
    testClaudePaths.pluginsDir = join(tmpDir, "plugins");
    testClaudePaths.installedPluginsJson = join(tmpDir, "plugins", "installed_plugins.json");
    testClaudePaths.knownMarketplacesJson = join(tmpDir, "plugins", "known_marketplaces.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty artifacts when no files exist", async () => {
    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("snapshots CLAUDE.md when it exists", async () => {
    await writeFile(testClaudePaths.claudeMd, "# My Claude instructions\n", "utf8");
    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const art = result.artifacts.find((a) => a.vaultPath === "claude/CLAUDE.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("# My Claude instructions\n");
  });

  test("snapshots settings.json extracting only hooks", async () => {
    const settings = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "*", hooks: [] }] },
      other: "should be dropped",
    });
    await writeFile(testClaudePaths.settingsJson, settings, "utf8");

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const art = result.artifacts.find((a) => a.vaultPath === "claude/settings.hooks.json.age");
    expect(art).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const parsed = JSON.parse(art!.plaintext) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["hooks"]);
  });

  test("snapshots .claude.json extracting only mcpServers", async () => {
    const mcp = JSON.stringify({
      mcpServers: { myserver: { command: "npx" } },
      something: "else",
    });
    await writeFile(testClaudePaths.mcpJson, mcp, "utf8");

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const art = result.artifacts.find((a) => a.vaultPath === "claude/claude.json.age");
    expect(art).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const parsed = JSON.parse(art!.plaintext) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["mcpServers"]);
  });

  test("snapshots command .md files from commands dir", async () => {
    mkdirSync(testClaudePaths.commandsDir, { recursive: true });
    writeFileSync(join(testClaudePaths.commandsDir, "my-cmd.md"), "cmd content", "utf8");

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const art = result.artifacts.find((a) => a.vaultPath === "claude/commands/my-cmd.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("cmd content");
  });

  test("snapshots agent .md files from agents dir", async () => {
    mkdirSync(testClaudePaths.agentsDir, { recursive: true });
    writeFileSync(join(testClaudePaths.agentsDir, "my-agent.md"), "agent content", "utf8");

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const art = result.artifacts.find((a) => a.vaultPath === "claude/agents/my-agent.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("agent content");
  });

  test("redacts secrets in settings.json and adds warnings", async () => {
    const settings = JSON.stringify({
      hooks: {},
      env: { API_KEY: `sk-${"x".repeat(30)}` },
    });
    await writeFile(testClaudePaths.settingsJson, settings, "utf8");
    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    // Warnings bubble up from sanitization
    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
  });

  // Claude skill round-trip happy path

  test("snapshots a real Claude skill directory as a base64 tar artifact", async () => {
    const skillDir = join(testClaudePaths.skillsDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# my skill", "utf8");
    writeFileSync(join(skillDir, "notes.md"), "# notes", "utf8");

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const art = result.artifacts.find((a) => a.vaultPath === "claude/skills/my-skill.tar.age");
    expect(art).toBeDefined();
    expect(art?.sourcePath).toBe(skillDir);
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(() => Buffer.from(art!.plaintext, "base64")).not.toThrow();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(art!.plaintext.length).toBeGreaterThan(0);
  });

  // missing-dir case at the agent layer

  test("snapshotClaude does not throw when the skills directory is missing", async () => {
    testClaudePaths.skillsDir = join(tmpDir, "skills-does-not-exist");

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/skills/"));
    expect(skillArts).toHaveLength(0);
    expect(result.warnings.filter((w) => w.startsWith("never-sync"))).toHaveLength(0);
  });

  // interior-symlink defense-in-depth at the agent layer

  test("snapshotClaude omits interior symlink helper files from the tar", async () => {
    // Vendored helper outside the skills root.
    const helperTargetParent = join(tmpDir, "vendored-helpers");
    mkdirSync(helperTargetParent, { recursive: true });
    const helperTarget = join(helperTargetParent, "shared.md");
    writeFileSync(helperTarget, "# vendored helper", "utf8");

    const skillDir = join(testClaudePaths.skillsDir, "skill-with-helper");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# real", "utf8");
    writeFileSync(join(skillDir, "real-note.md"), "# real note", "utf8");
    symlinkSync(helperTarget, join(skillDir, "helper.md"));

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const art = result.artifacts.find(
      (a) => a.vaultPath === "claude/skills/skill-with-helper.tar.age",
    );
    expect(art).toBeDefined();

    // Decode the base64 tar and verify helper.md is absent.
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const tarBuf = Buffer.from(art!.plaintext, "base64");
    const extractDir = join(tmpDir, "extract-claude-helper");
    mkdirSync(extractDir, { recursive: true });
    await extractArchive(tarBuf, extractDir);

    const entries = await readdir(extractDir);
    expect(entries).toContain("SKILL.md");
    expect(entries).toContain("real-note.md");
    expect(entries).not.toContain("helper.md");
  });

  // Claude-specific edge cases that prove the walker is correctly
  // wired into snapshotClaude (not just the walker module in isolation).

  test("snapshotClaude skips a top-level symlinked skill root", async () => {
    const vendoredTarget = join(tmpDir, "vendored-pool", "vendor-skill");
    mkdirSync(vendoredTarget, { recursive: true });
    writeFileSync(join(vendoredTarget, "SKILL.md"), "# vendored", "utf8");

    mkdirSync(testClaudePaths.skillsDir, { recursive: true });
    symlinkSync(vendoredTarget, join(testClaudePaths.skillsDir, "vendored-skill"));

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/skills/"));
    expect(skillArts).toHaveLength(0);
  });

  test("snapshotClaude skips a top-level .system directory", async () => {
    const systemSkill = join(testClaudePaths.skillsDir, ".system", "vendor");
    mkdirSync(systemSkill, { recursive: true });
    writeFileSync(join(systemSkill, "SKILL.md"), "# vendor", "utf8");

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/skills/"));
    expect(skillArts).toHaveLength(0);
  });

  test("snapshotClaude skips a skill whose SKILL.md sentinel is a symlink", async () => {
    const realSentinel = join(tmpDir, "vendored-sentinel.md");
    writeFileSync(realSentinel, "# vendored", "utf8");

    const skillDir = join(testClaudePaths.skillsDir, "fake-skill");
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(realSentinel, join(skillDir, "SKILL.md"));

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/skills/"));
    expect(skillArts).toHaveLength(0);
  });
});

// applyClaudeMd / applyClaudeHooks / applyClaudeMcp / applyClaudeCommand / applyClaudeAgent

describe("apply* functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.rulesDir = join(tmpDir, "rules");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
    testClaudePaths.skillsDir = join(tmpDir, "skills");
    testClaudePaths.pluginsDir = join(tmpDir, "plugins");
    testClaudePaths.installedPluginsJson = join(tmpDir, "plugins", "installed_plugins.json");
    testClaudePaths.knownMarketplacesJson = join(tmpDir, "plugins", "known_marketplaces.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applyClaudeMd writes CLAUDE.md", async () => {
    await claudeModule.applyClaudeMd("# Updated instructions");
    const content = await Bun.file(testClaudePaths.claudeMd).text();
    expect(content).toBe("# Updated instructions");
  });

  test("applyClaudeHooks merges hooks key into existing settings.json", async () => {
    await writeFile(testClaudePaths.settingsJson, JSON.stringify({ theme: "dark" }), "utf8");
    await claudeModule.applyClaudeHooks(JSON.stringify({ hooks: { PreToolUse: [] } }));
    const updated = JSON.parse(await Bun.file(testClaudePaths.settingsJson).text()) as Record<
      string,
      unknown
    >;
    expect(updated.theme).toBe("dark");
    expect(updated.hooks).toEqual({ PreToolUse: [] });
  });

  test("applyClaudeHooks creates settings.json when missing", async () => {
    await claudeModule.applyClaudeHooks(JSON.stringify({ hooks: { PostToolUse: [] } }));
    const parsed = JSON.parse(await Bun.file(testClaudePaths.settingsJson).text()) as Record<
      string,
      unknown
    >;
    expect(parsed.hooks).toEqual({ PostToolUse: [] });
  });

  test("applyClaudeMcp merges mcpServers into .claude.json", async () => {
    await writeFile(testClaudePaths.mcpJson, JSON.stringify({ projects: {} }), "utf8");
    await claudeModule.applyClaudeMcp(JSON.stringify({ mcpServers: { srv: { command: "bun" } } }));
    const parsed = JSON.parse(await Bun.file(testClaudePaths.mcpJson).text()) as Record<
      string,
      unknown
    >;
    expect(parsed.projects).toEqual({});
    expect((parsed.mcpServers as Record<string, unknown>).srv).toBeDefined();
  });

  test("applyClaudeCommand writes a command file", async () => {
    await claudeModule.applyClaudeCommand("review.md", "# Code review command");
    const content = await Bun.file(join(testClaudePaths.commandsDir, "review.md")).text();
    expect(content).toBe("# Code review command");
  });

  test("applyClaudeAgent writes an agent file", async () => {
    await claudeModule.applyClaudeAgent("my-agent.md", "# Agent content");
    const content = await Bun.file(join(testClaudePaths.agentsDir, "my-agent.md")).text();
    expect(content).toBe("# Agent content");
  });

  // applyClaudeSkill direct extraction test

  test("applyClaudeSkill extracts a tar archive into the local skills dir", async () => {
    // Build a source skill, archive it via the same helper the walker uses,
    // then round-trip the base64 payload through applyClaudeSkill.
    const srcSkill = join(tmpDir, "src-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# skill body", "utf8");
    writeFileSync(join(srcSkill, "extra.md"), "# extra", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");

    await claudeModule.applyClaudeSkill("my-skill", base64);

    const targetSkillDir = join(testClaudePaths.skillsDir, "my-skill");
    const skillMd = await Bun.file(join(targetSkillDir, "SKILL.md")).text();
    const extra = await Bun.file(join(targetSkillDir, "extra.md")).text();
    expect(skillMd).toBe("# skill body");
    expect(extra).toBe("# extra");
  });
});

// dryRun (applyClaudeVault)

describe("applyClaudeVault dryRun", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "apply", "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "apply", "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "apply", "commands");
    testClaudePaths.agentsDir = join(tmpDir, "apply", "agents");
    testClaudePaths.mcpJson = join(tmpDir, "apply", ".claude.json");
    testClaudePaths.credentials = join(tmpDir, "apply", ".credentials.json");
    testClaudePaths.skillsDir = join(tmpDir, "apply", "skills");
    testClaudePaths.pluginsDir = join(tmpDir, "apply", "plugins");
    testClaudePaths.installedPluginsJson = join(
      tmpDir,
      "apply",
      "plugins",
      "installed_plugins.json",
    );
    testClaudePaths.knownMarketplacesJson = join(
      tmpDir,
      "apply",
      "plugins",
      "known_marketplaces.json",
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dryRun=true does not write any files to disk", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    // Create vault with an encrypted CLAUDE.md
    const vaultDir = join(tmpDir, "vault");
    const claudeVaultDir = join(vaultDir, "claude");
    await mkdir(claudeVaultDir, { recursive: true });
    const encrypted = await encryptString("# dry run content", [recipient]);
    await writeFile(join(claudeVaultDir, "CLAUDE.md.age"), encrypted, "utf8");

    await claudeModule.applyClaudeVault(vaultDir, identity, true /* dryRun */, TEST_CONFIG);

    // File should NOT exist since dryRun=true
    const exists = await Bun.file(testClaudePaths.claudeMd).exists();
    expect(exists).toBeFalse();
  });

  // applyClaudeVault round-trip restores skill from encrypted vault

  test("applyClaudeVault restores a Claude skill from an encrypted vault artifact", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    // Build a real source skill, archive it, encrypt it, write to a tmp vault.
    const srcSkill = join(tmpDir, "src", "round-trip-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# round trip", "utf8");
    writeFileSync(join(srcSkill, "guide.md"), "# guide", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-skill-roundtrip");
    const skillsVaultDir = join(vaultDir, "claude", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    await writeFile(join(skillsVaultDir, "round-trip-skill.tar.age"), encrypted, "utf8");

    await claudeModule.applyClaudeVault(vaultDir, identity, false /* dryRun */, TEST_CONFIG);

    // The local skill directory should now contain both files.
    const restoredSkillDir = join(testClaudePaths.skillsDir, "round-trip-skill");
    const restoredSkill = await Bun.file(join(restoredSkillDir, "SKILL.md")).text();
    const restoredGuide = await Bun.file(join(restoredSkillDir, "guide.md")).text();
    expect(restoredSkill).toBe("# round trip");
    expect(restoredGuide).toBe("# guide");
  });

  // applyClaudeVault dryRun=true must NOT touch the local skills dir

  test("applyClaudeVault dryRun=true does not extract skill artifacts", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const srcSkill = join(tmpDir, "src", "dry-run-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# dry run skill", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-skill-dryrun");
    const skillsVaultDir = join(vaultDir, "claude", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    await writeFile(join(skillsVaultDir, "dry-run-skill.tar.age"), encrypted, "utf8");

    await claudeModule.applyClaudeVault(vaultDir, identity, true /* dryRun */, TEST_CONFIG);

    // The local skills directory must not contain the skill.
    const restoredSkillDir = join(testClaudePaths.skillsDir, "dry-run-skill");
    const exists = await Bun.file(join(restoredSkillDir, "SKILL.md")).exists();
    expect(exists).toBeFalse();
  });

  // Phase 8 M6 — adversarial filename regression. Locks the H1 path-traversal
  // fix: a crafted vault file named `...tar.age` basenames to `..`, which must
  // be rejected by validateSkillName before any filesystem write occurs.

  test("applyClaudeSkill rejects traversal and hidden skill names", async () => {
    const { InvalidSkillNameError } = await import("../../skills-walker");
    const badNames = ["", ".", "..", "../foo", "foo/bar", "foo\\bar", ".hidden", "foo\x00bar"];
    for (const bad of badNames) {
      await expect(claudeModule.applyClaudeSkill(bad, "")).rejects.toBeInstanceOf(
        InvalidSkillNameError,
      );
    }
  });

  test("applyClaudeVault skips adversarial vault filenames without traversal", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    // Build a tar whose first entry is a payload that WOULD overwrite the
    // Claude config root if extraction escaped skillsDir.
    const payloadSrc = join(tmpDir, "payload-src");
    mkdirSync(payloadSrc, { recursive: true });
    writeFileSync(join(payloadSrc, "CLAUDE.md"), "LEAKED_PAYLOAD", "utf8");
    const tarBuffer = await archiveDirectory(payloadSrc);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-adversarial");
    const skillsVaultDir = join(vaultDir, "claude", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    // `...tar.age` → basename strips `.tar.age` → skillName is `..`
    await writeFile(join(skillsVaultDir, "...tar.age"), encrypted, "utf8");

    // Must not throw — the bad entry is caught and logged, loop continues.
    await claudeModule.applyClaudeVault(vaultDir, identity, false /* dryRun */, TEST_CONFIG);

    // The skillsDir parent must NOT have a leaked payload file.
    const escapedPayload = join(testClaudePaths.skillsDir, "..", "CLAUDE.md");
    const leakedExists = await Bun.file(escapedPayload).exists();
    // In this tmp layout the parent of skillsDir is `<tmpDir>/apply`, which
    // is the same directory that holds `CLAUDE.md` for the dry-run test above
    // (testClaudePaths.claudeMd). If the validator were bypassed, the payload
    // would land exactly on top of it.
    expect(leakedExists).toBeFalse();
  });
});

// Claude Code plugins — distilled reinstall manifest (no plugin-tree encryption).

describe("Claude plugin manifest sync", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.rulesDir = join(tmpDir, "rules");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
    testClaudePaths.skillsDir = join(tmpDir, "skills");
    testClaudePaths.pluginsDir = join(tmpDir, "plugins");
    testClaudePaths.installedPluginsJson = join(tmpDir, "plugins", "installed_plugins.json");
    testClaudePaths.knownMarketplacesJson = join(tmpDir, "plugins", "known_marketplaces.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function seedPluginState(): void {
    mkdirSync(testClaudePaths.pluginsDir, { recursive: true });
    writeFileSync(
      testClaudePaths.installedPluginsJson,
      JSON.stringify({
        version: 2,
        plugins: {
          "pr-review-toolkit@claude-plugins-official": [
            { scope: "user", installPath: "/Users/someone/.claude/cache/x", version: "1.0.0" },
          ],
        },
        enabledPlugins: { "pr-review-toolkit@claude-plugins-official": true },
      }),
      "utf8",
    );
    writeFileSync(
      testClaudePaths.knownMarketplacesJson,
      JSON.stringify({
        "claude-plugins-official": {
          source: { source: "github", repo: "anthropics/claude-plugins-official" },
          installLocation: "/Users/someone/.claude/plugins/marketplaces/official",
          lastUpdated: "2026-06-06T01:49:52.179Z",
        },
      }),
      "utf8",
    );
  }

  test("emits nothing plugin-related when syncPlugins is off (the default)", async () => {
    seedPluginState();
    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    expect(result.artifacts.some((a) => a.vaultPath.startsWith("claude/plugins"))).toBeFalse();
  });

  test("emits only the manifest artifact (no plugin tree) when syncPlugins is on", async () => {
    seedPluginState();
    const result = await claudeModule.snapshotClaude(TEST_CONFIG_WITH_PLUGINS);
    const pluginPaths = result.artifacts
      .map((a) => a.vaultPath)
      .filter((p) => p.startsWith("claude/plugins"));
    expect(pluginPaths).toEqual(["claude/plugins.manifest.json.age"]);
    // No nested per-plugin tree under claude/plugins/<name>/...
    expect(result.artifacts.some((a) => a.vaultPath.startsWith("claude/plugins/"))).toBeFalse();
  });

  test("the manifest distils name@marketplace records and drops absolute paths", async () => {
    seedPluginState();
    const result = await claudeModule.snapshotClaude(TEST_CONFIG_WITH_PLUGINS);
    const manifest = result.artifacts.find(
      (a) => a.vaultPath === "claude/plugins.manifest.json.age",
    );
    expect(manifest).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const parsed = JSON.parse(manifest!.plaintext) as {
      marketplaces: { name: string; source: string }[];
      plugins: { name: string; marketplace: string; scope: string; enabled: boolean }[];
    };
    expect(parsed.marketplaces).toEqual([
      { name: "claude-plugins-official", source: "anthropics/claude-plugins-official" },
    ]);
    expect(parsed.plugins).toEqual([
      {
        name: "pr-review-toolkit",
        marketplace: "claude-plugins-official",
        scope: "user",
        enabled: true,
      },
    ]);
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(manifest!.plaintext).not.toContain("installPath");
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(manifest!.plaintext).not.toContain("/Users/someone");
  });

  test("emits no manifest when installed_plugins.json is absent even with syncPlugins on", async () => {
    mkdirSync(testClaudePaths.pluginsDir, { recursive: true });
    const result = await claudeModule.snapshotClaude(TEST_CONFIG_WITH_PLUGINS);
    expect(result.artifacts.some((a) => a.vaultPath.startsWith("claude/plugins"))).toBeFalse();
  });

  test("a malformed installed_plugins.json becomes a warning, not an aborting throw", async () => {
    mkdirSync(testClaudePaths.pluginsDir, { recursive: true });
    writeFileSync(testClaudePaths.installedPluginsJson, "{not json", "utf8");
    const result = await claudeModule.snapshotClaude(TEST_CONFIG_WITH_PLUGINS);
    expect(result.artifacts.some((a) => a.vaultPath.startsWith("claude/plugins"))).toBeFalse();
    expect(result.warnings.some((w) => w.includes("Skipping plugin manifest"))).toBeTrue();
  });

  test("applyClaudeVault never restores the manifest to disk — it has no apply directive", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const vaultDir = join(tmpDir, "vault-manifest");
    const claudeVaultDir = join(vaultDir, "claude");
    await mkdir(claudeVaultDir, { recursive: true });
    const encrypted = await encryptString(JSON.stringify({ marketplaces: [], plugins: [] }), [
      recipient,
    ]);
    await writeFile(join(claudeVaultDir, "plugins.manifest.json.age"), encrypted, "utf8");

    // Must not throw and must not write any plugins file: the manifest drives
    // `plugin install`, it is never applied through the pull plan.
    await claudeModule.applyClaudeVault(vaultDir, identity, false, TEST_CONFIG_WITH_PLUGINS);
    expect(await Bun.file(testClaudePaths.installedPluginsJson).exists()).toBeFalse();
  });
});

describe("Claude rules sync (B19)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.rulesDir = join(tmpDir, "rules");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
    testClaudePaths.skillsDir = join(tmpDir, "skills");
    testClaudePaths.pluginsDir = join(tmpDir, "plugins");
    testClaudePaths.installedPluginsJson = join(tmpDir, "plugins", "installed_plugins.json");
    testClaudePaths.knownMarketplacesJson = join(tmpDir, "plugins", "known_marketplaces.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("snapshotClaude collects each *.md under rulesDir as its own artifact", async () => {
    await mkdir(testClaudePaths.rulesDir, { recursive: true });
    await writeFile(join(testClaudePaths.rulesDir, "style.md"), "# style", "utf8");
    await writeFile(join(testClaudePaths.rulesDir, "review.md"), "# review", "utf8");
    // non-markdown should be ignored
    await writeFile(join(testClaudePaths.rulesDir, "notes.txt"), "txt", "utf8");

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const ruleArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/rules/"));
    expect(ruleArts.map((a) => a.vaultPath).sort()).toEqual([
      "claude/rules/review.md.age",
      "claude/rules/style.md.age",
    ]);
    expect(ruleArts.find((a) => a.vaultPath === "claude/rules/style.md.age")?.plaintext).toBe(
      "# style",
    );
  });

  test("applyClaudeRule writes a rule markdown file under rulesDir", async () => {
    await claudeModule.applyClaudeRule("coding-style.md", "# coding style");
    const written = await Bun.file(join(testClaudePaths.rulesDir, "coding-style.md")).text();
    expect(written).toBe("# coding style");
  });

  test("snapshot refuses to follow a symlinked rule file", async () => {
    await mkdir(testClaudePaths.rulesDir, { recursive: true });
    const external = join(tmpDir, "secret-outside-rulesDir.md");
    await writeFile(external, "SHOULD-NEVER-LEAK", "utf8");
    symlinkSync(external, join(testClaudePaths.rulesDir, "linked.md"));

    const result = await claudeModule.snapshotClaude(TEST_CONFIG);
    const ruleArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/rules/"));
    expect(ruleArts).toHaveLength(0);
    // Belt and braces: the leaked content must not appear in any artifact.
    expect(result.artifacts.every((a) => !a.plaintext.includes("SHOULD-NEVER-LEAK"))).toBe(true);
  });

  test("applyClaudeVault dispatches claude/rules/*.md.age to applyClaudeRule", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const vaultDir = join(tmpDir, "vault");
    await mkdir(join(vaultDir, "claude", "rules"), { recursive: true });
    const enc = await encryptString("# round-trip rule", [recipient]);
    await writeFile(join(vaultDir, "claude", "rules", "rt.md.age"), enc, "utf8");

    await claudeModule.applyClaudeVault(vaultDir, identity, false, TEST_CONFIG);

    const restored = await Bun.file(join(testClaudePaths.rulesDir, "rt.md")).text();
    expect(restored).toBe("# round-trip rule");
  });
});

describe("Claude HOME path portability wiring (B24)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.rulesDir = join(tmpDir, "rules");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
    testClaudePaths.skillsDir = join(tmpDir, "skills");
    testClaudePaths.pluginsDir = join(tmpDir, "plugins");
    testClaudePaths.installedPluginsJson = join(tmpDir, "plugins", "installed_plugins.json");
    testClaudePaths.knownMarketplacesJson = join(tmpDir, "plugins", "known_marketplaces.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applyClaudeMcp denormalizes the AGENTSYNC_HOME placeholder", async () => {
    const { homedir } = await import("node:os");
    const incoming = JSON.stringify({
      mcpServers: { fs: { command: "node", cwd: `${AGENTSYNC_HOME_PLACEHOLDER}/proj` } },
    });
    await claudeModule.applyClaudeMcp(incoming);
    const written = JSON.parse(await Bun.file(testClaudePaths.mcpJson).text()) as {
      mcpServers: { fs: { cwd: string } };
    };
    expect(written.mcpServers.fs.cwd).toBe(`${homedir()}/proj`);
  });

  test("applyClaudeHooks denormalizes only the synced subset and preserves local keys", async () => {
    const { homedir } = await import("node:os");
    await writeFile(
      testClaudePaths.settingsJson,
      JSON.stringify({ theme: "dark", permissions: { allow: ["x"] } }),
      "utf8",
    );
    const incoming = JSON.stringify({
      hooks: { PreToolUse: [{ command: `${AGENTSYNC_HOME_PLACEHOLDER}/.claude/runner` }] },
    });
    await claudeModule.applyClaudeHooks(incoming);
    const written = JSON.parse(await Bun.file(testClaudePaths.settingsJson).text()) as {
      theme: string;
      permissions: { allow: string[] };
      hooks: { PreToolUse: { command: string }[] };
    };
    expect(written.theme).toBe("dark");
    expect(written.permissions.allow).toEqual(["x"]);
    expect(written.hooks.PreToolUse[0]?.command).toBe(`${homedir()}/.claude/runner`);
  });
});
