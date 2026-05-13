/**
 * Tests for the doctor command's skills-directory checks.
 *
 * The check rows are produced by `buildSkillsDirChecks` so we can unit-test
 * the rule directly without mocking the rest of the doctor pipeline (private
 * key, git remote, vault scan, etc.).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { AgentSyncConfigSchema } from "../../config/schema";
import { createTmpDir } from "../../test-helpers/fixtures";
import { buildSkillsDirChecks, formatSchemaError } from "../doctor";

type MutablePaths = {
  claude: { skillsDir: string };
  codex: { skillsDir: string };
  cursor: { skillsDir: string };
};
const mutablePaths = AgentPaths as unknown as MutablePaths;

describe("buildSkillsDirChecks", () => {
  let tmpDir: string;
  const saved = {
    claude: mutablePaths.claude.skillsDir,
    codex: mutablePaths.codex.skillsDir,
    cursor: mutablePaths.cursor.skillsDir,
  };

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    mutablePaths.claude.skillsDir = saved.claude;
    mutablePaths.codex.skillsDir = saved.codex;
    mutablePaths.cursor.skillsDir = saved.cursor;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns one row per supported agent", async () => {
    // Point all three at non-existent paths.
    mutablePaths.claude.skillsDir = join(tmpDir, "missing-claude");
    mutablePaths.codex.skillsDir = join(tmpDir, "missing-codex");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    expect(rows).toHaveLength(3);
    const names = rows.map((r) => r.name);
    expect(names).toContain("Claude skills directory");
    expect(names).toContain("Codex skills directory");
    expect(names).toContain("Cursor skills directory");
  });

  test("reports `pass` when a skills directory is readable", async () => {
    const claudeDir = join(tmpDir, "claude-skills");
    const codexDir = join(tmpDir, "codex-skills");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mutablePaths.claude.skillsDir = claudeDir;
    mutablePaths.codex.skillsDir = codexDir;
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    const claudeRow = rows.find((r) => r.name === "Claude skills directory");
    const codexRow = rows.find((r) => r.name === "Codex skills directory");
    expect(claudeRow?.status).toBe("pass");
    expect(claudeRow?.detail).toBe(claudeDir);
    expect(codexRow?.status).toBe("pass");
    expect(codexRow?.detail).toBe(codexDir);
  });

  test("reports `warn` when a skills directory is missing", async () => {
    mutablePaths.claude.skillsDir = join(tmpDir, "missing-claude");
    mutablePaths.codex.skillsDir = join(tmpDir, "missing-codex");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    expect(rows.every((r) => r.status === "warn")).toBe(true);
    for (const r of rows) {
      expect(r.detail).toContain("Not found or unreadable");
    }
  });

  test("does NOT include a Copilot row (Copilot is wired through other paths)", async () => {
    mutablePaths.claude.skillsDir = join(tmpDir, "missing");
    mutablePaths.codex.skillsDir = join(tmpDir, "missing");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing");

    const rows = await buildSkillsDirChecks();
    expect(rows.find((r) => r.name.toLowerCase().includes("copilot"))).toBeUndefined();
  });

  // Phase 8 L1 — guard against a misconfigured skillsDir that is a regular
  // file, not a directory. `access(R_OK)` alone passes in that case, so a
  // bare readability check would produce a false-positive `pass` row.
  test("reports `warn` when a skills path exists but is not a directory", async () => {
    const claudeFile = join(tmpDir, "claude-skills-is-a-file");
    writeFileSync(claudeFile, "oops — this should be a directory", "utf8");
    mutablePaths.claude.skillsDir = claudeFile;
    mutablePaths.codex.skillsDir = join(tmpDir, "missing-codex");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    const claudeRow = rows.find((r) => r.name === "Claude skills directory");
    expect(claudeRow?.status).toBe("warn");
    expect(claudeRow?.detail).toContain("not a directory");
  });

  // Parity with the walker's symlink-rejection rule. The walker refuses to
  // enumerate a skills root that is itself a symlink, so doctor must not
  // report `pass` for that same layout. Using `stat` alone would follow the
  // link and see a real directory, hiding the walker's silent refusal from
  // the user.
  test("reports `warn` when a skills path is a symlink", async () => {
    const realRoot = join(tmpDir, "real-claude-skills");
    mkdirSync(realRoot, { recursive: true });
    const linkedRoot = join(tmpDir, "linked-claude-skills");
    await symlink(realRoot, linkedRoot);

    mutablePaths.claude.skillsDir = linkedRoot;
    mutablePaths.codex.skillsDir = join(tmpDir, "missing-codex");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    const claudeRow = rows.find((r) => r.name === "Claude skills directory");
    expect(claudeRow?.status).toBe("warn");
    expect(claudeRow?.detail).toContain("Symlinked skills root");
  });
});

describe("formatSchemaError", () => {
  test("names the offending recipient alias on a non-age1 value", () => {
    const result = AgentSyncConfigSchema.safeParse({
      recipients: { alice: "notage1xyz" },
      agents: {
        cursor: true,
        claude: true,
        codex: true,
        copilot: true,
        vscode: false,
      },
      remote: { url: "git@github.com:user/vault.git", branch: "main" },
      sync: {
        debounceMs: 300,
        autoPush: true,
        autoPull: true,
        pullIntervalMs: 300_000,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const detail = formatSchemaError(result.error);
      expect(detail).toContain("recipients.alice");
    }
  });

  test("names remote.branch on empty branch", () => {
    const result = AgentSyncConfigSchema.safeParse({
      recipients: { me: "age1qpzry9x8gf2tvdw0s3jn54khce6mua7l" },
      agents: {
        cursor: true,
        claude: true,
        codex: true,
        copilot: true,
        vscode: false,
      },
      remote: { url: "git@github.com:user/vault.git", branch: "" },
      sync: {
        debounceMs: 300,
        autoPush: true,
        autoPull: true,
        pullIntervalMs: 300_000,
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const detail = formatSchemaError(result.error);
      expect(detail).toContain("remote.branch");
    }
  });

  test("falls back to String(err) for non-Zod errors", () => {
    expect(formatSchemaError(new Error("disk full"))).toBe("Invalid: Error: disk full");
  });
});
