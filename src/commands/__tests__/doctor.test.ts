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
import { type DaemonState, writeDaemonState } from "../../daemon/state";
import { createTmpDir } from "../../test-helpers/fixtures";
import { buildDaemonHealthCheck, buildSkillsDirChecks } from "../doctor";

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

describe("buildDaemonHealthCheck", () => {
  let tmpDir: string;
  let savedDir: string | undefined;

  const base: DaemonState = {
    pid: null,
    startedAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    stuck: false,
  };

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    savedDir = process.env.AGENTSYNC_DIR;
    process.env.AGENTSYNC_DIR = tmpDir;
  });

  afterEach(async () => {
    if (savedDir === undefined) delete process.env.AGENTSYNC_DIR;
    else process.env.AGENTSYNC_DIR = savedDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("fails when the daemon is stuck on a divergence", async () => {
    await writeDaemonState({ ...base, stuck: true, lastError: "[push] diverged" });
    const row = await buildDaemonHealthCheck(true);
    expect(row.status).toBe("fail");
    expect(row.detail).toContain("STUCK");
  });

  test("warns when installed but no sync has ever succeeded", async () => {
    await writeDaemonState(base);
    const row = await buildDaemonHealthCheck(true);
    expect(row.status).toBe("warn");
  });

  test("passes when not installed and no sync has run", async () => {
    await writeDaemonState(base);
    const row = await buildDaemonHealthCheck(false);
    expect(row.status).toBe("pass");
  });

  test("warns when the last success is stale", async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await writeDaemonState({ ...base, lastSuccessAt: old });
    const row = await buildDaemonHealthCheck(true);
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("stale");
  });

  test("passes on a recent successful sync", async () => {
    await writeDaemonState({ ...base, lastSuccessAt: new Date().toISOString() });
    const row = await buildDaemonHealthCheck(true);
    expect(row.status).toBe("pass");
  });
});
