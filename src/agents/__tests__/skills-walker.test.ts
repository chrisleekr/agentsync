/**
 * Tests for the shared skills walker (src/agents/skills-walker.ts).
 *
 * Covers the 12-row behavioral matrix from contracts/walker-interface.md.
 * Each row builds an independent fixture under a tmp dir, calls
 * collectSkillArtifacts, and asserts on the returned shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractArchive } from "../../core/tar";
import { createTmpDir } from "../../test-helpers/fixtures";
import { collectSkillArtifacts } from "../skills-walker";

describe("collectSkillArtifacts", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Row 1 — empty skills root
  test("returns empty result for an empty skills root", async () => {
    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 2 — missing skills root (FR-009)
  test("returns empty result when skills root does not exist (FR-009)", async () => {
    const result = await collectSkillArtifacts("claude", join(tmpDir, "does-not-exist"));
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 3 — happy path: real skill with SKILL.md plus extra files
  test("archives one real skill (happy path)", async () => {
    const skillDir = join(tmpDir, "my-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# skill", "utf8");
    await writeFile(join(skillDir, "README.md"), "# notes", "utf8");

    const result = await collectSkillArtifacts("claude", tmpDir);

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.vaultPath).toBe("claude/skills/my-skill.tar.age");
    expect(result.artifacts[0]?.sourcePath).toBe(skillDir);
    expect(result.artifacts[0]?.plaintext.length).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 4 — directory missing SKILL.md sentinel
  test("skips a directory that has no SKILL.md sentinel (FR-002)", async () => {
    const skillDir = join(tmpDir, "no-sentinel");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "README.md"), "# notes", "utf8");

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 5 — SKILL.md is itself a symlink (FR-016 sentinel back-door)
  test("skips a skill whose SKILL.md is itself a symlink (FR-016 sentinel guard)", async () => {
    const realSentinel = join(tmpDir, ".vendored-sentinel.md");
    await writeFile(realSentinel, "# vendored", "utf8");

    const skillDir = join(tmpDir, "fake-skill");
    await mkdir(skillDir, { recursive: true });
    await symlink(realSentinel, join(skillDir, "SKILL.md"));

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 6 — top-level symlink root pointing into a vendored pool (FR-016 outer)
  test("skips a top-level symlinked skill root (FR-016 outer tier)", async () => {
    const targetSkill = join(tmpDir, ".vendored-pool", "real-target");
    await mkdir(targetSkill, { recursive: true });
    await writeFile(join(targetSkill, "SKILL.md"), "# vendored skill", "utf8");

    await symlink(targetSkill, join(tmpDir, "vendored-skill"));

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 7 — top-level .system directory containing a real skill (FR-017)
  test("skips a top-level .system directory (FR-017 dot-skip)", async () => {
    const systemSkill = join(tmpDir, ".system", "vendor-skill");
    await mkdir(systemSkill, { recursive: true });
    await writeFile(join(systemSkill, "SKILL.md"), "# vendor", "utf8");

    const result = await collectSkillArtifacts("codex", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 8 — top-level .DS_Store regular file (FR-017)
  test("skips a top-level .DS_Store file (FR-017 dot-skip)", async () => {
    await writeFile(join(tmpDir, ".DS_Store"), "binary", "utf8");
    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 9 — two real skills + one symlinked root → 2 artifacts
  test("archives multiple real skills while skipping a symlinked root", async () => {
    const a = join(tmpDir, "skill-a");
    await mkdir(a, { recursive: true });
    await writeFile(join(a, "SKILL.md"), "# a", "utf8");

    const b = join(tmpDir, "skill-b");
    await mkdir(b, { recursive: true });
    await writeFile(join(b, "SKILL.md"), "# b", "utf8");

    const target = join(tmpDir, ".outside-pool", "vendored");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# vendored", "utf8");
    await symlink(target, join(tmpDir, "skill-c"));

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(2);
    const vaultPaths = result.artifacts.map((art) => art.vaultPath).sort();
    expect(vaultPaths).toEqual(["claude/skills/skill-a.tar.age", "claude/skills/skill-b.tar.age"]);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 10 — real skill with interior symlink helper file (FR-016 inner)
  test("archives a real skill while omitting interior symlink helper files (FR-016 inner tier)", async () => {
    const helperTargetParent = join(tmpDir, ".helper-pool");
    await mkdir(helperTargetParent, { recursive: true });
    const helperTarget = join(helperTargetParent, "shared.md");
    await writeFile(helperTarget, "# vendored helper", "utf8");

    const skillDir = join(tmpDir, "skill-with-helper");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# real", "utf8");
    await writeFile(join(skillDir, "real-note.md"), "# real note", "utf8");
    await symlink(helperTarget, join(skillDir, "helper.md"));

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.vaultPath).toBe("claude/skills/skill-with-helper.tar.age");

    // Decrypt the tar back to disk and verify helper.md is NOT present.
    const tarBuf = Buffer.from(result.artifacts[0]?.plaintext ?? "", "base64");
    const extractDir = join(tmpDir, "extract-row-10");
    await mkdir(extractDir, { recursive: true });
    await extractArchive(tarBuf, extractDir);

    const entries = await readdir(extractDir);
    expect(entries).toContain("SKILL.md");
    expect(entries).toContain("real-note.md");
    expect(entries).not.toContain("helper.md");
  });

  // Row 11 — skill containing a never-sync file (FR-006)
  test("rejects a skill that contains a never-sync file (FR-006)", async () => {
    const skillDir = join(tmpDir, "dirty-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# dirty", "utf8");
    await writeFile(join(skillDir, "auth.json"), '{"token":"x"}', "utf8");

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    // Exactly one warning — the contract promises one entry per offending path,
    // and this fixture seeds exactly one. A looser assertion would silently
    // accept a walker regression that duplicated warnings.
    expect(result.warnings).toHaveLength(1);
    const offending = result.warnings[0];
    expect(offending).toBeDefined();
    expect(offending).toContain("auth.json");
    expect(offending?.startsWith("never-sync inside skill: ")).toBe(true);
  });

  // Row 12 — two skills, one clean + one dirty → walker collects clean, warns dirty (R3)
  test("collects clean skills even when another skill has a never-sync hit (R3)", async () => {
    const clean = join(tmpDir, "clean-skill");
    await mkdir(clean, { recursive: true });
    await writeFile(join(clean, "SKILL.md"), "# clean", "utf8");

    const dirty = join(tmpDir, "dirty-skill");
    await mkdir(dirty, { recursive: true });
    await writeFile(join(dirty, "SKILL.md"), "# dirty", "utf8");
    await writeFile(join(dirty, "auth.json"), '{"token":"x"}', "utf8");

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.vaultPath).toBe("claude/skills/clean-skill.tar.age");
    // One dirty skill with one offending file → exactly one warning.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.startsWith("never-sync inside skill: ")).toBe(true);
  });

  // Row 13 — the skills root path itself is a symlink (NC-1 from PR review).
  // Resolves the spec ambiguity toward the conservative "skills I created"
  // intent: if the entire root is a symlink (e.g., a power user has done
  // `ln -s /srv/team-pool ~/.claude/skills`), the walker MUST refuse to
  // enumerate it. The same anti-vendoring rule that FR-016 applies to
  // individual entries extends to the root by consistency.
  test("returns empty when the skills root path is itself a symlink (NC-1)", async () => {
    const realRoot = join(tmpDir, "real-pool");
    await mkdir(realRoot, { recursive: true });
    // Populate it with a real skill so we can prove the walker WOULD have
    // collected it had the root not been a symlink.
    const realSkill = join(realRoot, "would-be-vendored");
    await mkdir(realSkill, { recursive: true });
    await writeFile(join(realSkill, "SKILL.md"), "# would be vendored", "utf8");

    const linkedRoot = join(tmpDir, "linked-root");
    await symlink(realRoot, linkedRoot);

    const result = await collectSkillArtifacts("claude", linkedRoot);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
