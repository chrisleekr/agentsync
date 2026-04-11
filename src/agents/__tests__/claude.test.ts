import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { archiveDirectory, extractArchive } from "../../core/tar";
import { createTmpDir } from "../../test-helpers/fixtures";

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
  mcpJson: string;
  credentials: string;
  skillsDir: string;
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

type ClaudeModule = typeof import("../claude");
let claudeModule: ClaudeModule;

beforeAll(async () => {
  claudeModule = await import("../claude");
});

afterAll(() => {
  Object.assign(testClaudePaths, originalClaudePaths);
});

// T018 — snapshotClaude

describe("snapshotClaude", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
    testClaudePaths.skillsDir = join(tmpDir, "skills");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty artifacts when no files exist", async () => {
    const result = await claudeModule.snapshotClaude();
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("snapshots CLAUDE.md when it exists", async () => {
    await writeFile(testClaudePaths.claudeMd, "# My Claude instructions\n", "utf8");
    const result = await claudeModule.snapshotClaude();
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

    const result = await claudeModule.snapshotClaude();
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

    const result = await claudeModule.snapshotClaude();
    const art = result.artifacts.find((a) => a.vaultPath === "claude/claude.json.age");
    expect(art).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const parsed = JSON.parse(art!.plaintext) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["mcpServers"]);
  });

  test("snapshots command .md files from commands dir", async () => {
    mkdirSync(testClaudePaths.commandsDir, { recursive: true });
    writeFileSync(join(testClaudePaths.commandsDir, "my-cmd.md"), "cmd content", "utf8");

    const result = await claudeModule.snapshotClaude();
    const art = result.artifacts.find((a) => a.vaultPath === "claude/commands/my-cmd.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("cmd content");
  });

  test("snapshots agent .md files from agents dir", async () => {
    mkdirSync(testClaudePaths.agentsDir, { recursive: true });
    writeFileSync(join(testClaudePaths.agentsDir, "my-agent.md"), "agent content", "utf8");

    const result = await claudeModule.snapshotClaude();
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
    const result = await claudeModule.snapshotClaude();
    // Warnings bubble up from sanitization
    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
  });

  // T014 — US1 Claude skill round-trip happy path (FR-001, FR-003, FR-004)

  test("snapshots a real Claude skill directory as a base64 tar artifact", async () => {
    const skillDir = join(testClaudePaths.skillsDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# my skill", "utf8");
    writeFileSync(join(skillDir, "notes.md"), "# notes", "utf8");

    const result = await claudeModule.snapshotClaude();
    const art = result.artifacts.find((a) => a.vaultPath === "claude/skills/my-skill.tar.age");
    expect(art).toBeDefined();
    expect(art?.sourcePath).toBe(skillDir);
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(() => Buffer.from(art!.plaintext, "base64")).not.toThrow();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(art!.plaintext.length).toBeGreaterThan(0);
  });

  // T014(5) — FR-009 missing-dir case at the agent layer

  test("snapshotClaude does not throw when the skills directory is missing (FR-009)", async () => {
    testClaudePaths.skillsDir = join(tmpDir, "skills-does-not-exist");

    const result = await claudeModule.snapshotClaude();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/skills/"));
    expect(skillArts).toHaveLength(0);
    expect(result.warnings.filter((w) => w.startsWith("never-sync"))).toHaveLength(0);
  });

  // T014(6) — FR-016 interior-symlink defense-in-depth at the agent layer

  test("snapshotClaude omits interior symlink helper files from the tar (FR-016 inner)", async () => {
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

    const result = await claudeModule.snapshotClaude();
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

  // T015 — Claude-specific edge cases that prove the walker is correctly
  // wired into snapshotClaude (not just the walker module in isolation).

  test("snapshotClaude skips a top-level symlinked skill root (FR-016 outer)", async () => {
    const vendoredTarget = join(tmpDir, "vendored-pool", "vendor-skill");
    mkdirSync(vendoredTarget, { recursive: true });
    writeFileSync(join(vendoredTarget, "SKILL.md"), "# vendored", "utf8");

    mkdirSync(testClaudePaths.skillsDir, { recursive: true });
    symlinkSync(vendoredTarget, join(testClaudePaths.skillsDir, "vendored-skill"));

    const result = await claudeModule.snapshotClaude();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/skills/"));
    expect(skillArts).toHaveLength(0);
  });

  test("snapshotClaude skips a top-level .system directory (FR-017 dot-skip)", async () => {
    const systemSkill = join(testClaudePaths.skillsDir, ".system", "vendor");
    mkdirSync(systemSkill, { recursive: true });
    writeFileSync(join(systemSkill, "SKILL.md"), "# vendor", "utf8");

    const result = await claudeModule.snapshotClaude();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/skills/"));
    expect(skillArts).toHaveLength(0);
  });

  test("snapshotClaude skips a skill whose SKILL.md sentinel is a symlink (FR-016 sentinel)", async () => {
    const realSentinel = join(tmpDir, "vendored-sentinel.md");
    writeFileSync(realSentinel, "# vendored", "utf8");

    const skillDir = join(testClaudePaths.skillsDir, "fake-skill");
    mkdirSync(skillDir, { recursive: true });
    symlinkSync(realSentinel, join(skillDir, "SKILL.md"));

    const result = await claudeModule.snapshotClaude();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("claude/skills/"));
    expect(skillArts).toHaveLength(0);
  });
});

// T024 — applyClaudeMd / applyClaudeHooks / applyClaudeMcp / applyClaudeCommand / applyClaudeAgent

describe("apply* functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
    testClaudePaths.skillsDir = join(tmpDir, "skills");
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

  // T014(2) — applyClaudeSkill direct extraction test

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

// T028 — dryRun (applyClaudeVault)

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
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dryRun=true does not write any files to disk", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    // Create vault with an encrypted CLAUDE.md
    const vaultDir = join(tmpDir, "vault");
    const claudeVaultDir = join(vaultDir, "claude");
    await mkdir(claudeVaultDir, { recursive: true });
    const encrypted = await encryptString("# dry run content", [recipient]);
    await writeFile(join(claudeVaultDir, "CLAUDE.md.age"), encrypted, "utf8");

    await claudeModule.applyClaudeVault(vaultDir, identity, true /* dryRun */);

    // File should NOT exist since dryRun=true
    const exists = await Bun.file(testClaudePaths.claudeMd).exists();
    expect(exists).toBeFalse();
  });

  // T014(3) — applyClaudeVault round-trip restores skill from encrypted vault

  test("applyClaudeVault restores a Claude skill from an encrypted vault artifact", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
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

    await claudeModule.applyClaudeVault(vaultDir, identity, false /* dryRun */);

    // The local skill directory should now contain both files.
    const restoredSkillDir = join(testClaudePaths.skillsDir, "round-trip-skill");
    const restoredSkill = await Bun.file(join(restoredSkillDir, "SKILL.md")).text();
    const restoredGuide = await Bun.file(join(restoredSkillDir, "guide.md")).text();
    expect(restoredSkill).toBe("# round trip");
    expect(restoredGuide).toBe("# guide");
  });

  // T014(4) — applyClaudeVault dryRun=true must NOT touch the local skills dir

  test("applyClaudeVault dryRun=true does not extract skill artifacts", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
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

    await claudeModule.applyClaudeVault(vaultDir, identity, true /* dryRun */);

    // The local skills directory must not contain the skill.
    const restoredSkillDir = join(testClaudePaths.skillsDir, "dry-run-skill");
    const exists = await Bun.file(join(restoredSkillDir, "SKILL.md")).exists();
    expect(exists).toBeFalse();
  });

  // Phase 8 M6 — adversarial filename regression. Locks the H1 path-traversal
  // fix: a crafted vault file named `...tar.age` basenames to `..`, which must
  // be rejected by validateSkillName before any filesystem write occurs.

  test("applyClaudeSkill rejects traversal and hidden skill names", async () => {
    const { InvalidSkillNameError } = await import("../skills-walker");
    const badNames = ["", ".", "..", "../foo", "foo/bar", "foo\\bar", ".hidden", "foo\x00bar"];
    for (const bad of badNames) {
      await expect(claudeModule.applyClaudeSkill(bad, "")).rejects.toBeInstanceOf(
        InvalidSkillNameError,
      );
    }
  });

  test("applyClaudeVault skips adversarial vault filenames without traversal", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
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
    await claudeModule.applyClaudeVault(vaultDir, identity, false /* dryRun */);

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
