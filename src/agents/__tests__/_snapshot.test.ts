import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";
import { collectMarkdownDir, collectSingleFile, collectSkillScopes } from "../_snapshot";

/** Create a qualifying skill directory (real SKILL.md sentinel) under `scope`. */
function makeSkill(scope: string, name: string, extraFiles: Record<string, string> = {}): void {
  const dir = join(scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `# ${name}\n`);
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

describe("collectMarkdownDir", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await createTmpDir();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns [] for a missing directory", async () => {
    const out = await collectMarkdownDir({
      dir: join(tmp, "nope"),
      vaultPath: (n) => `claude/commands/${n}.age`,
    });
    expect(out).toEqual([]);
  });

  test("collects .md files with the built vault path and skips non-.md", async () => {
    writeFileSync(join(tmp, "review.md"), "# review");
    writeFileSync(join(tmp, "notes.txt"), "ignore me");
    const out = await collectMarkdownDir({
      dir: tmp,
      vaultPath: (n) => `claude/commands/${n}.age`,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      vaultPath: "claude/commands/review.md.age",
      sourcePath: join(tmp, "review.md"),
      plaintext: "# review",
    });
  });

  test("honours a custom compound-suffix match predicate", async () => {
    writeFileSync(join(tmp, "global.instructions.md"), "x");
    writeFileSync(join(tmp, "plain.md"), "y");
    const out = await collectMarkdownDir({
      dir: tmp,
      vaultPath: (n) => `copilot/instructions/${n}.age`,
      match: (n) => n.endsWith(".instructions.md"),
    });
    expect(out.map((a) => a.vaultPath)).toEqual([
      "copilot/instructions/global.instructions.md.age",
    ]);
  });

  test("skips files matching a never-sync pattern", async () => {
    // `**/*.local.md` is a never-sync glob; the default `.md` match would
    // otherwise pick it up.
    writeFileSync(join(tmp, "secret.local.md"), "do not sync");
    writeFileSync(join(tmp, "keep.md"), "ok");
    const out = await collectMarkdownDir({
      dir: tmp,
      vaultPath: (n) => `claude/rules/${n}.age`,
    });
    expect(out.map((a) => a.vaultPath)).toEqual(["claude/rules/keep.md.age"]);
  });

  test("rejects a symlinked markdown entry so it cannot smuggle content past the never-sync gate", async () => {
    // A `commands/evil.md -> <outside>` symlink: readFile would follow it while
    // shouldNeverSync only sees the link path. The hardened walk must drop it.
    const secret = join(tmp, "outside-secret.md");
    writeFileSync(secret, "TOP SECRET");
    const scan = join(tmp, "scan");
    mkdirSync(scan, { recursive: true });
    writeFileSync(join(scan, "real.md"), "real content");
    symlinkSync(secret, join(scan, "evil.md"));
    const out = await collectMarkdownDir({
      dir: scan,
      vaultPath: (n) => `claude/commands/${n}.age`,
    });
    expect(out.map((a) => a.vaultPath)).toEqual(["claude/commands/real.md.age"]);
  });

  test("skips subdirectories", async () => {
    mkdirSync(join(tmp, "nested.md"), { recursive: true }); // a directory named like a file
    writeFileSync(join(tmp, "file.md"), "ok");
    const out = await collectMarkdownDir({
      dir: tmp,
      vaultPath: (n) => `claude/commands/${n}.age`,
    });
    expect(out.map((a) => a.vaultPath)).toEqual(["claude/commands/file.md.age"]);
  });
});

describe("collectSingleFile", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await createTmpDir();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("returns one artifact when the file exists", async () => {
    const p = join(tmp, "CLAUDE.md");
    writeFileSync(p, "# claude");
    const out = await collectSingleFile({ sourcePath: p, vaultPath: "claude/CLAUDE.md.age" });
    expect(out).toEqual([
      { vaultPath: "claude/CLAUDE.md.age", sourcePath: p, plaintext: "# claude", warnings: [] },
    ]);
  });

  test("returns [] when the file is absent", async () => {
    const out = await collectSingleFile({
      sourcePath: join(tmp, "missing.md"),
      vaultPath: "claude/CLAUDE.md.age",
    });
    expect(out).toEqual([]);
  });
});

describe("collectSkillScopes", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await createTmpDir();
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  function names(arts: { vaultPath: string }[]): string[] {
    return arts
      .map((a) => a.vaultPath.replace(/^codex\/skills\//, "").replace(/\.tar\.age$/, ""))
      .sort();
  }

  test("passes a single scope straight through", async () => {
    const canonical = join(tmp, "canonical");
    makeSkill(canonical, "alpha");
    makeSkill(canonical, "beta");
    const result = await collectSkillScopes("codex", [canonical]);
    expect(names(result.artifacts)).toEqual(["alpha", "beta"]);
  });

  test("dedups a legacy scope against the canonical directory listing", async () => {
    const canonical = join(tmp, "canonical");
    const legacy = join(tmp, "legacy");
    makeSkill(canonical, "shared");
    makeSkill(canonical, "canon-only");
    makeSkill(legacy, "shared"); // suppressed — canonical owns the name
    makeSkill(legacy, "legacy-only");
    const result = await collectSkillScopes("codex", [canonical, legacy]);
    expect(names(result.artifacts)).toEqual(["canon-only", "legacy-only", "shared"]);
    // exactly one "shared", and it comes from the canonical scope.
    const shared = result.artifacts.filter((a) => a.vaultPath === "codex/skills/shared.tar.age");
    expect(shared).toHaveLength(1);
    expect(shared[0].sourcePath).toBe(join(canonical, "shared"));
  });

  test("a name present-but-rejected in canonical still blocks the legacy copy", async () => {
    const canonical = join(tmp, "canonical");
    const legacy = join(tmp, "legacy");
    // canonical "blocked" carries an interior never-sync file, so the walker
    // emits a warning and NO artifact — but the name is on disk canonically.
    makeSkill(canonical, "blocked", { "auth.json": "{}" });
    makeSkill(legacy, "blocked"); // clean, but must stay suppressed
    const result = await collectSkillScopes("codex", [canonical, legacy]);
    expect(names(result.artifacts)).toEqual([]);
    expect(result.warnings.some((w) => w.includes("never-sync"))).toBe(true);
  });

  test("returns an empty result for no scopes", async () => {
    expect(await collectSkillScopes("codex", [])).toEqual({ artifacts: [], warnings: [] });
  });
});
