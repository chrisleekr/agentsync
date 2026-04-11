import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { archiveDirectory, extractArchive } from "../../core/tar";
import { createAgeIdentity, createTmpDir } from "../../test-helpers/fixtures";

{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

type MutableCursorPaths = {
  mcpGlobal: string;
  commandsDir: string;
  settingsJson: string;
  skillsDir: string;
};

const testCursorPaths = AgentPaths.cursor as MutableCursorPaths;

type CursorModule = typeof import("../cursor");
let cursorModule: CursorModule;

beforeAll(async () => {
  cursorModule = await import("../cursor");
});

// ── T021 — snapshotCursor ─────────────────────────────────────────────────────

describe("snapshotCursor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCursorPaths.settingsJson = join(tmpDir, "settings.json");
    testCursorPaths.mcpGlobal = join(tmpDir, "mcp.json");
    testCursorPaths.commandsDir = join(tmpDir, "commands");
    testCursorPaths.skillsDir = join(tmpDir, "skills");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty when no files exist", async () => {
    const { snapshotCursor } = cursorModule;
    const result = await snapshotCursor();
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("captures rules string from settings.json as cursor/user-rules.md.age", async () => {
    const { snapshotCursor } = cursorModule;
    const settings = {
      rules: "Always write tests\n- prefer TDD",
      theme: "dark",
    };
    await writeFile(testCursorPaths.settingsJson, JSON.stringify(settings), "utf8");

    const result = await snapshotCursor();
    const artifact = result.artifacts.find((a) => a.vaultPath === "cursor/user-rules.md.age");
    expect(artifact).toBeDefined();
    expect(artifact?.plaintext).toBe(settings.rules);
    expect(artifact?.sourcePath).toBe(testCursorPaths.settingsJson);
  });

  test("skips rules when settings.json has no rules field", async () => {
    const { snapshotCursor } = cursorModule;
    await writeFile(
      testCursorPaths.settingsJson,
      JSON.stringify({ theme: "light", fontSize: 14 }),
      "utf8",
    );
    const result = await snapshotCursor();
    expect(result.artifacts.find((a) => a.vaultPath.includes("user-rules"))).toBeUndefined();
  });

  test("skips rules when rules field is not a string", async () => {
    const { snapshotCursor } = cursorModule;
    await writeFile(
      testCursorPaths.settingsJson,
      JSON.stringify({ rules: ["array", "of", "rules"] }),
      "utf8",
    );
    const result = await snapshotCursor();
    expect(result.artifacts.find((a) => a.vaultPath.includes("user-rules"))).toBeUndefined();
  });

  test("captures mcp.json as cursor/mcp.json.age", async () => {
    const { snapshotCursor } = cursorModule;
    const mcp = {
      mcpServers: { "my-server": { command: "node", args: ["server.js"] } },
    };
    await writeFile(testCursorPaths.mcpGlobal, JSON.stringify(mcp), "utf8");

    const result = await snapshotCursor();
    const artifact = result.artifacts.find((a) => a.vaultPath === "cursor/mcp.json.age");
    expect(artifact).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const parsed = JSON.parse(artifact!.plaintext.trim()) as Record<string, unknown>;
    expect((parsed.mcpServers as Record<string, { command: string }>)["my-server"].command).toBe(
      "node",
    );
  });

  test("captures command .md files as cursor/commands/<name>.age", async () => {
    const { snapshotCursor } = cursorModule;
    mkdirSync(testCursorPaths.commandsDir, { recursive: true });
    writeFileSync(join(testCursorPaths.commandsDir, "fix.md"), "# Fix\nFix the bug.", "utf8");
    writeFileSync(join(testCursorPaths.commandsDir, "explain.md"), "# Explain\nExplain.", "utf8");

    const result = await snapshotCursor();
    const commands = result.artifacts.filter((a) => a.vaultPath.startsWith("cursor/commands/"));
    expect(commands).toHaveLength(2);
    expect(commands.some((a) => a.vaultPath === "cursor/commands/fix.md.age")).toBe(true);
    expect(commands.some((a) => a.vaultPath === "cursor/commands/explain.md.age")).toBe(true);
  });

  // T020(1) — US3 Cursor skill round-trip happy path (FR-001, FR-003, FR-004)

  test("snapshots a real Cursor skill directory as a base64 tar artifact", async () => {
    const { snapshotCursor } = cursorModule;
    const skillDir = join(testCursorPaths.skillsDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# my cursor skill", "utf8");
    writeFileSync(join(skillDir, "notes.md"), "# notes", "utf8");

    const result = await snapshotCursor();
    const art = result.artifacts.find((a) => a.vaultPath === "cursor/skills/my-skill.tar.age");
    expect(art).toBeDefined();
    expect(art?.sourcePath).toBe(skillDir);
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(() => Buffer.from(art!.plaintext, "base64")).not.toThrow();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(art!.plaintext.length).toBeGreaterThan(0);
  });

  // T020(5) — FR-009 missing-dir case at the agent layer

  test("snapshotCursor does not throw when the skills directory is missing (FR-009)", async () => {
    const { snapshotCursor } = cursorModule;
    testCursorPaths.skillsDir = join(tmpDir, "skills-does-not-exist");

    const result = await snapshotCursor();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("cursor/skills/"));
    expect(skillArts).toHaveLength(0);
    expect(result.warnings.filter((w) => w.startsWith("never-sync"))).toHaveLength(0);
  });

  // T020(6) — FR-016 interior-symlink defense-in-depth at the agent layer

  test("snapshotCursor omits interior symlink helper files from the tar (FR-016 inner)", async () => {
    const { snapshotCursor } = cursorModule;
    const helperTargetParent = join(tmpDir, "vendored-helpers");
    mkdirSync(helperTargetParent, { recursive: true });
    const helperTarget = join(helperTargetParent, "shared.md");
    writeFileSync(helperTarget, "# vendored helper", "utf8");

    const skillDir = join(testCursorPaths.skillsDir, "skill-with-helper");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# real", "utf8");
    writeFileSync(join(skillDir, "real-note.md"), "# real note", "utf8");
    symlinkSync(helperTarget, join(skillDir, "helper.md"));

    const result = await snapshotCursor();
    const art = result.artifacts.find(
      (a) => a.vaultPath === "cursor/skills/skill-with-helper.tar.age",
    );
    expect(art).toBeDefined();

    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const tarBuf = Buffer.from(art!.plaintext, "base64");
    const extractDir = join(tmpDir, "extract-cursor-helper");
    mkdirSync(extractDir, { recursive: true });
    await extractArchive(tarBuf, extractDir);

    const entries = await readdir(extractDir);
    expect(entries).toContain("SKILL.md");
    expect(entries).toContain("real-note.md");
    expect(entries).not.toContain("helper.md");
  });

  // T021 — FR-010 negative assertion: ~/.cursor/skills-cursor/ is never read.
  // This is the load-bearing test for US3 because it is the only direct
  // evidence that the Cursor adapter is pointed at the canonical "skills"
  // path and never touches the bundled "skills-cursor" directory.

  test("snapshotCursor never touches ~/.cursor/skills-cursor/ (FR-010)", async () => {
    const { snapshotCursor } = cursorModule;
    // Real skill at the canonical path.
    const realSkill = join(testCursorPaths.skillsDir, "my-skill");
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(join(realSkill, "SKILL.md"), "# real", "utf8");

    // Decoy bundled directory at the path the spec says must be ignored.
    const bundledSkill = join(tmpDir, "skills-cursor", "other-skill");
    mkdirSync(bundledSkill, { recursive: true });
    writeFileSync(join(bundledSkill, "SKILL.md"), "# bundled vendor", "utf8");

    const result = await snapshotCursor();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("cursor/skills/"));
    expect(skillArts).toHaveLength(1);
    expect(skillArts[0]?.vaultPath).toBe("cursor/skills/my-skill.tar.age");
    // Negative-space assertion: nothing under skills-cursor can have leaked
    // into the vault namespace, regardless of sub-path.
    expect(result.artifacts.every((a) => !a.vaultPath.includes("skills-cursor"))).toBe(true);
  });
});

// ── T027 — cursor apply functions ─────────────────────────────────────────────

describe("cursor apply functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCursorPaths.settingsJson = join(tmpDir, "settings.json");
    testCursorPaths.mcpGlobal = join(tmpDir, "mcp.json");
    testCursorPaths.commandsDir = join(tmpDir, "commands");
    testCursorPaths.skillsDir = join(tmpDir, "skills");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applyCursorRules merges rules into existing settings.json, preserving other keys", async () => {
    const { applyCursorRules } = cursorModule;
    await writeFile(
      testCursorPaths.settingsJson,
      JSON.stringify({ theme: "dark", fontSize: 14 }),
      "utf8",
    );

    await applyCursorRules("Always write tests");

    const written = JSON.parse(await Bun.file(testCursorPaths.settingsJson).text()) as Record<
      string,
      unknown
    >;
    expect(written.rules).toBe("Always write tests");
    expect(written.theme).toBe("dark");
    expect(written.fontSize).toBe(14);
  });

  test("applyCursorRules creates new settings.json when file does not exist", async () => {
    const { applyCursorRules } = cursorModule;
    await applyCursorRules("My new rules");

    const written = JSON.parse(await Bun.file(testCursorPaths.settingsJson).text()) as Record<
      string,
      unknown
    >;
    expect(written.rules).toBe("My new rules");
  });

  test("applyCursorMcp writes content to mcpGlobal path", async () => {
    const { applyCursorMcp } = cursorModule;
    const content = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
    await applyCursorMcp(content);
    expect(await Bun.file(testCursorPaths.mcpGlobal).text()).toBe(content);
  });

  test("applyCursorCommand writes named command file under commandsDir", async () => {
    const { applyCursorCommand } = cursorModule;
    await applyCursorCommand("my-cmd.md", "# My Cmd\nDo things.");

    const target = join(testCursorPaths.commandsDir, "my-cmd.md");
    expect(await Bun.file(target).text()).toBe("# My Cmd\nDo things.");
  });

  // T020(2) — applyCursorSkill direct extraction test

  test("applyCursorSkill extracts a tar archive into the local skills dir", async () => {
    const { applyCursorSkill } = cursorModule;
    const srcSkill = join(tmpDir, "src-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# cursor skill body", "utf8");
    writeFileSync(join(srcSkill, "extra.md"), "# extra", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");

    await applyCursorSkill("my-skill", base64);

    const targetSkillDir = join(testCursorPaths.skillsDir, "my-skill");
    const skillMd = await Bun.file(join(targetSkillDir, "SKILL.md")).text();
    const extra = await Bun.file(join(targetSkillDir, "extra.md")).text();
    expect(skillMd).toBe("# cursor skill body");
    expect(extra).toBe("# extra");
  });
});

// ── T028 — dryRun vault apply ─────────────────────────────────────────────────

describe("applyCursorVault dryRun", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCursorPaths.settingsJson = join(tmpDir, "settings.json");
    testCursorPaths.mcpGlobal = join(tmpDir, "mcp.json");
    testCursorPaths.commandsDir = join(tmpDir, "commands");
    testCursorPaths.skillsDir = join(tmpDir, "skills");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dryRun=true does not write any local files", async () => {
    const { applyCursorVault } = cursorModule;
    const { encryptString } = await import("../../core/encryptor");
    const { identity, recipient } = await createAgeIdentity();

    const vaultDir = join(tmpDir, "vault");
    const cursorVaultDir = join(vaultDir, "cursor");
    await mkdir(cursorVaultDir, { recursive: true });

    const encrypted = await encryptString("Always use TDD", [recipient]);
    await writeFile(join(cursorVaultDir, "user-rules.md.age"), encrypted, "utf8");

    await applyCursorVault(vaultDir, identity, true);

    // settings.json must NOT be created on dryRun
    expect(await Bun.file(testCursorPaths.settingsJson).exists()).toBe(false);
  });

  // T020(3) — applyCursorVault restores a Cursor skill from an encrypted artifact

  test("applyCursorVault restores a Cursor skill from an encrypted vault artifact", async () => {
    const { applyCursorVault } = cursorModule;
    const { encryptString } = await import("../../core/encryptor");
    const { identity, recipient } = await createAgeIdentity();

    const srcSkill = join(tmpDir, "src", "round-trip-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# cursor round trip", "utf8");
    writeFileSync(join(srcSkill, "guide.md"), "# guide", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-skill-roundtrip");
    const skillsVaultDir = join(vaultDir, "cursor", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    await writeFile(join(skillsVaultDir, "round-trip-skill.tar.age"), encrypted, "utf8");

    await applyCursorVault(vaultDir, identity, false);

    const restoredSkillDir = join(testCursorPaths.skillsDir, "round-trip-skill");
    const restoredSkill = await Bun.file(join(restoredSkillDir, "SKILL.md")).text();
    const restoredGuide = await Bun.file(join(restoredSkillDir, "guide.md")).text();
    expect(restoredSkill).toBe("# cursor round trip");
    expect(restoredGuide).toBe("# guide");
  });

  // T020(4) — applyCursorVault dryRun=true must NOT touch the local skills dir

  test("applyCursorVault dryRun=true does not extract skill artifacts", async () => {
    const { applyCursorVault } = cursorModule;
    const { encryptString } = await import("../../core/encryptor");
    const { identity, recipient } = await createAgeIdentity();

    const srcSkill = join(tmpDir, "src", "dry-run-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# cursor dry run skill", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-skill-dryrun");
    const skillsVaultDir = join(vaultDir, "cursor", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    await writeFile(join(skillsVaultDir, "dry-run-skill.tar.age"), encrypted, "utf8");

    await applyCursorVault(vaultDir, identity, true);

    const restoredSkillDir = join(testCursorPaths.skillsDir, "dry-run-skill");
    const exists = await Bun.file(join(restoredSkillDir, "SKILL.md")).exists();
    expect(exists).toBeFalse();
  });

  // Phase 8 M6 — adversarial filename regression for Cursor.

  test("applyCursorSkill rejects traversal and hidden skill names", async () => {
    const { applyCursorSkill } = cursorModule;
    const { InvalidSkillNameError } = await import("../skills-walker");
    const badNames = ["", ".", "..", "../foo", "foo/bar", "foo\\bar", ".hidden", "foo\x00bar"];
    for (const bad of badNames) {
      await expect(applyCursorSkill(bad, "")).rejects.toBeInstanceOf(InvalidSkillNameError);
    }
  });

  test("applyCursorVault skips adversarial vault filenames without traversal", async () => {
    const { applyCursorVault } = cursorModule;
    const { encryptString } = await import("../../core/encryptor");
    const { identity, recipient } = await createAgeIdentity();

    const payloadSrc = join(tmpDir, "payload-src");
    mkdirSync(payloadSrc, { recursive: true });
    writeFileSync(join(payloadSrc, "user-rules.md"), "LEAKED_PAYLOAD", "utf8");
    const tarBuffer = await archiveDirectory(payloadSrc);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-adversarial");
    const skillsVaultDir = join(vaultDir, "cursor", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    await writeFile(join(skillsVaultDir, "...tar.age"), encrypted, "utf8");

    await applyCursorVault(vaultDir, identity, false);

    const escapedPayload = join(testCursorPaths.skillsDir, "..", "user-rules.md");
    const leakedExists = await Bun.file(escapedPayload).exists();
    expect(leakedExists).toBeFalse();
  });
});

// ── applyCursorVault unknown file warning ─────────────────────────────────────

describe("applyCursorVault unknown .age file warning", () => {
  let tmpDir: string;
  const warnMessages: string[] = [];
  let originalWarn: typeof import("@clack/prompts").log.warn;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCursorPaths.settingsJson = join(tmpDir, "settings.json");
    testCursorPaths.mcpGlobal = join(tmpDir, "mcp.json");
    testCursorPaths.commandsDir = join(tmpDir, "commands");
    warnMessages.length = 0;
    const clack = await import("@clack/prompts");
    originalWarn = clack.log.warn;
    clack.log.warn = (msg?: string) => {
      if (msg) warnMessages.push(msg);
    };
  });

  afterEach(async () => {
    const clack = await import("@clack/prompts");
    clack.log.warn = originalWarn;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("logs warning when encountering unrecognised .age file in cursor vault", async () => {
    const { applyCursorVault } = cursorModule;
    const { encryptString } = await import("../../core/encryptor");
    const { identity, recipient } = await createAgeIdentity();

    const vaultDir = join(tmpDir, "vault");
    const cursorVaultDir = join(vaultDir, "cursor");
    await mkdir(cursorVaultDir, { recursive: true });

    // Place an unknown .age file
    const encrypted = await encryptString("unknown content", [recipient]);
    await writeFile(join(cursorVaultDir, "unknown-thing.age"), encrypted, "utf8");

    await applyCursorVault(vaultDir, identity, false);

    expect(warnMessages.some((m) => m.includes("unknown-thing.age"))).toBe(true);
  });
});
