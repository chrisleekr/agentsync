/**
 * Tests for the shared skills walker (src/agents/skills-walker.ts).
 *
 * Covers the 12-row behavioral matrix from contracts/walker-interface.md.
 * Each row builds an independent fixture under a tmp dir, calls
 * collectSkillArtifacts, and asserts on the returned shape.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractArchive } from "../../core/tar";
import { createTmpDir } from "../../test-helpers/fixtures";
import { applySkillArchive, collectSkillArtifacts, InvalidSkillNameError } from "../skills-walker";

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

  // Row 2 — missing skills root
  test("returns empty result when skills root does not exist", async () => {
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
  test("skips a directory that has no SKILL.md sentinel", async () => {
    const skillDir = join(tmpDir, "no-sentinel");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "README.md"), "# notes", "utf8");

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 5 — SKILL.md is itself a symlink
  test("skips a skill whose SKILL.md is itself a symlink", async () => {
    const realSentinel = join(tmpDir, ".vendored-sentinel.md");
    await writeFile(realSentinel, "# vendored", "utf8");

    const skillDir = join(tmpDir, "fake-skill");
    await mkdir(skillDir, { recursive: true });
    await symlink(realSentinel, join(skillDir, "SKILL.md"));

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 6 — top-level symlink root pointing into a vendored pool
  test("skips a top-level symlinked skill root", async () => {
    const targetSkill = join(tmpDir, ".vendored-pool", "real-target");
    await mkdir(targetSkill, { recursive: true });
    await writeFile(join(targetSkill, "SKILL.md"), "# vendored skill", "utf8");

    await symlink(targetSkill, join(tmpDir, "vendored-skill"));

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 7 — top-level .system directory containing a real skill
  test("skips a top-level .system directory", async () => {
    const systemSkill = join(tmpDir, ".system", "vendor-skill");
    await mkdir(systemSkill, { recursive: true });
    await writeFile(join(systemSkill, "SKILL.md"), "# vendor", "utf8");

    const result = await collectSkillArtifacts("codex", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  // Row 8 — top-level .DS_Store regular file
  test("skips a top-level .DS_Store file", async () => {
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

  // Row 10 — real skill with interior symlink helper file
  test("archives a real skill while omitting interior symlink helper files", async () => {
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

  // Row 11 — skill containing a never-sync file
  test("rejects a skill that contains a never-sync file", async () => {
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

  // Row 12 — two skills, one clean + one dirty → walker collects clean, warns dirty.
  // The whole-picture invariant: one offending skill must NOT mask the other clean
  // skills from being collected; the push gate handles escalation, not the walker.
  test("collects clean skills even when another skill has a never-sync hit", async () => {
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

  // Literal-secret coverage at the walker layer. The central scan in
  // `commands/push.ts` skips `.tar.age` artifacts because base64 scrambles
  // credential prefixes and statistically overlaps `AKIA…`/`AIza…` shapes —
  // so a key pasted into `SKILL.md` would otherwise be encrypted and shipped.
  // The walker now scans each readable interior file body before tarring.

  test("rejects a skill whose SKILL.md contains a literal Claude API key", async () => {
    const skillDir = join(tmpDir, "leaky-skill");
    await mkdir(skillDir, { recursive: true });
    const fakeKey = `sk-ant-api03-${"A".repeat(48)}`;
    await writeFile(join(skillDir, "SKILL.md"), `# leaky\n\ntoken: ${fakeKey}\n`, "utf8");

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    const warn = result.warnings[0] ?? "";
    expect(warn.startsWith("Detected literal secret")).toBe(true);
    expect(warn).toContain("anthropic-api-key");
    expect(warn).toContain(join(skillDir, "SKILL.md"));
  });

  test("rejects a skill with a nested markdown file containing an AWS key", async () => {
    const skillDir = join(tmpDir, "nested-leak");
    await mkdir(join(skillDir, "notes"), { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# clean sentinel", "utf8");
    // Embedded AWS access-key-id prefix (16-char alphanumeric body).
    const leak = join(skillDir, "notes", "leak.md");
    await writeFile(leak, "deploy with AKIAIOSFODNN7EXAMPLE\n", "utf8");

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    const warn = result.warnings[0] ?? "";
    expect(warn.startsWith("Detected literal secret")).toBe(true);
    expect(warn).toContain("aws-access-key");
    expect(warn).toContain(leak);
  });

  test("does NOT false-positive on a clean skill with AKIA-shaped prose", async () => {
    const skillDir = join(tmpDir, "clean-prose");
    await mkdir(skillDir, { recursive: true });
    // `sha256:` digest is a long base64-ish run that the original
    // anchored-only redactor would have flagged. Here we are exercising
    // the unanchored EMBEDDED_SECRET_PATTERNS — none of which match a
    // plain `AKIA` substring without the 16-char alphanumeric body.
    await writeFile(
      join(skillDir, "SKILL.md"),
      "# clean\n\nrelated word: AKIA-history-of-aviation\n\nsha256:abcdef0123456789abcdef0123456789abcdef0123456789\n",
      "utf8",
    );

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.vaultPath).toBe("claude/skills/clean-prose.tar.age");
    expect(result.warnings).toHaveLength(0);
  });

  test("collects clean skills even when another skill has a literal-secret hit", async () => {
    const clean = join(tmpDir, "clean-skill");
    await mkdir(clean, { recursive: true });
    await writeFile(join(clean, "SKILL.md"), "# clean", "utf8");

    const dirty = join(tmpDir, "dirty-skill");
    await mkdir(dirty, { recursive: true });
    const fakeKey = `sk-ant-api03-${"B".repeat(48)}`;
    await writeFile(join(dirty, "SKILL.md"), `# dirty\n\ntoken: ${fakeKey}\n`, "utf8");

    const result = await collectSkillArtifacts("claude", tmpDir);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.vaultPath).toBe("claude/skills/clean-skill.tar.age");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.startsWith("Detected literal secret")).toBe(true);
    expect(result.warnings[0]).toContain(join(dirty, "SKILL.md"));
  });

  // Row 13 — the skills root path itself is a symlink. Resolves the spec
  // ambiguity toward the conservative "skills I created" intent: if the
  // entire root is a symlink (e.g., a power user has done
  // `ln -s /srv/team-pool ~/.claude/skills`), the walker MUST refuse to
  // enumerate it. The anti-vendoring rule that rejects symlinked entries
  // extends to the root by consistency.
  test("returns empty when the skills root path is itself a symlink", async () => {
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

describe("applySkillArchive", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("extracts a skill's base64 tar into <root>/<name>/ preserving interior layout", async () => {
    // Round-trip: build a real skill, snapshot it to a base64 artifact, then
    // restore it through applySkillArchive into a fresh root.
    const src = join(tmpDir, "src");
    const skill = join(src, "my-skill");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "# my skill\n");
    await writeFile(join(skill, "body.md"), "interior\n");
    const [artifact] = (await collectSkillArtifacts("claude", src)).artifacts;

    const dest = join(tmpDir, "dest");
    await applySkillArchive(dest, "my-skill", artifact.plaintext);
    expect(await readFile(join(dest, "my-skill", "SKILL.md"), "utf8")).toBe("# my skill\n");
    expect(await readFile(join(dest, "my-skill", "body.md"), "utf8")).toBe("interior\n");
  });

  test("rejects a traversal skill name before touching the filesystem", async () => {
    await expect(applySkillArchive(join(tmpDir, "dest"), "..", "")).rejects.toBeInstanceOf(
      InvalidSkillNameError,
    );
  });
});
