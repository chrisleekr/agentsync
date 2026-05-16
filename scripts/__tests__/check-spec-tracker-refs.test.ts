import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFiles,
  runCheck,
  SCAN_ROOTS,
  SPEC_ID_RE,
  scan,
  scanText,
} from "../check-spec-tracker-refs";

describe("scanText — spec-tracker leakage detection", () => {
  test("clean prose returns zero hits", () => {
    const text = "The skill is silently ignored when the SKILL.md sentinel is missing.";
    expect(scanText(text, "fake.md")).toEqual([]);
  });

  test("detects bare FR-### token", () => {
    const text = "Skip the directory (FR-002) and emit a warning.";
    const hits = scanText(text, "operations.md");
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe("FR-002");
    expect(hits[0].file).toBe("operations.md");
    expect(hits[0].line).toBe(1);
  });

  test("detects every spec-tracker form", () => {
    const text = [
      "First line FR-001.",
      "Second SC-014 line.",
      "Third has US3 and T123 together.",
      "Fourth NC-7 alone.",
      "Fifth cites (research R5).",
    ].join("\n");
    const hits = scanText(text, "f.md");
    const found = hits.map((h) => h.match).sort();
    expect(found).toEqual(["FR-001", "NC-7", "R5", "SC-014", "T123", "US3"]);
  });

  test("records column and 120-char preview", () => {
    const text = "  prefix words then FR-042 trailing.";
    const hits = scanText(text, "x.md");
    expect(hits[0].column).toBe(21);
    expect(hits[0].preview).toBe("prefix words then FR-042 trailing.");
  });

  test("placeholder forms with # characters are NOT matched", () => {
    // The rule itself must be quotable in CLAUDE.md / docs/contributing.md.
    const text = "spec IDs (FR-###, SC-###, US#, T###, NC-#, (research R#)) belong in commits";
    expect(scanText(text, "CLAUDE.md")).toEqual([]);
  });

  test("substring of a larger word is not matched", () => {
    // Word boundary guards against false positives like UNIT-FR-001 → matches
    // only the bare FR-001; XYZSC-1 should not match because there's no \b
    // before S. Verified by the \b anchor.
    expect(scanText("contextFR-1trailing", "x.md")).toEqual([]);
    expect(scanText("XYZSC-99suffix", "x.md")).toEqual([]);
  });

  test("hyphen-suffixed IDs still match the leading ID", () => {
    // SC-99-suffix has a \b between 9 and the trailing -, so the regex matches
    // SC-99. This is intentional: a spec ID with a trailing qualifier is still
    // a spec ID and must be flagged.
    const hits = scanText("see SC-99-suffix details", "x.md");
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toBe("SC-99");
  });

  test("bare research R-refs match in every speckit shape", () => {
    // Real specs/ corpus emits these forms; the guard must catch them when
    // they migrate into shipped surfaces.
    expect(scanText("(per research R2/R4/R7)", "x.md").map((h) => h.match)).toEqual([
      "R2",
      "R4",
      "R7",
    ]);
    expect(scanText("research R9", "x.md")).toHaveLength(1);
    expect(scanText("(R3)", "x.md")).toHaveLength(1);
    expect(scanText("(FR-016 inner tier, R2)", "x.md").map((h) => h.match)).toEqual([
      "FR-016",
      "R2",
    ]);
  });

  test("multiple hits on the same line are all reported", () => {
    const text = "FR-001 then FR-002 then SC-003 all together";
    const hits = scanText(text, "x.md");
    expect(hits).toHaveLength(3);
    expect(hits[0].line).toBe(1);
    expect(hits.map((h) => h.match)).toEqual(["FR-001", "FR-002", "SC-003"]);
  });

  test("T### requires exactly three digits", () => {
    expect(scanText("T12 is too short", "x.md")).toEqual([]);
    expect(scanText("T1234 is too long", "x.md")).toEqual([]);
    expect(scanText("T123 matches", "x.md")).toHaveLength(1);
  });
});

describe("SPEC_ID_RE global flag", () => {
  test("matchAll yields every occurrence without sticky-state surprise", () => {
    const text = "FR-1 SC-2 US3 T123";
    const matches = [...text.matchAll(SPEC_ID_RE)];
    expect(matches.map((m) => m[0])).toEqual(["FR-1", "SC-2", "US3", "T123"]);
  });
});

describe("collectFiles + scan + runCheck against tmpdir fixtures", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spec-refs-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("collectFiles on a single-file root returns the path verbatim", async () => {
    await writeFile(join(dir, "README.md"), "clean prose\n");
    const out = await collectFiles({ path: "README.md", recursive: false }, dir);
    expect(out).toEqual(["README.md"]);
  });

  test("collectFiles returns empty list when the root is missing", async () => {
    const out = await collectFiles({ path: "does-not-exist.md", recursive: false }, dir);
    expect(out).toEqual([]);
  });

  test("collectFiles non-recursive on a directory returns empty list", async () => {
    await mkdir(join(dir, "docs"));
    await writeFile(join(dir, "docs/x.md"), "x\n");
    const out = await collectFiles({ path: "docs", recursive: false }, dir);
    expect(out).toEqual([]);
  });

  test("collectFiles recursive applies ext filter and skips excluded dirs", async () => {
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "src/node_modules"));
    await mkdir(join(dir, "src/.git"));
    await mkdir(join(dir, "src/dist"));
    await mkdir(join(dir, "src/sub"));
    await writeFile(join(dir, "src/a.ts"), "");
    await writeFile(join(dir, "src/b.js"), "");
    await writeFile(join(dir, "src/sub/c.ts"), "");
    await writeFile(join(dir, "src/node_modules/d.ts"), "");
    await writeFile(join(dir, "src/.git/HEAD"), "");
    await writeFile(join(dir, "src/dist/e.ts"), "");

    const out = await collectFiles({ path: "src", recursive: true, ext: ".ts" }, dir);
    expect(out).toEqual(["src/a.ts", "src/sub/c.ts"]);
  });

  test("scan reads a file and returns its hits", async () => {
    await writeFile(join(dir, "leaky.md"), "first FR-007 line\nclean second\nlast SC-3\n");
    const hits = await scan("leaky.md", dir);
    expect(hits.map((h) => `${h.line}:${h.match}`)).toEqual(["1:FR-007", "3:SC-3"]);
  });

  test("scan returns empty list when the file is missing", async () => {
    expect(await scan("nope.md", dir)).toEqual([]);
  });

  test("runCheck against a clean tmpdir returns exit 0 with file count", async () => {
    await writeFile(join(dir, "clean.md"), "no spec ids here\n");
    const result = await runCheck([{ path: "clean.md", recursive: false }], dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/passed \(1 files\)/);
    expect(result.stderr).toBe("");
  });

  test("runCheck against a leaky tmpdir returns exit 1 and reports each hit", async () => {
    await writeFile(join(dir, "leaky.md"), "skip per FR-002 rule\n");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/t.ts"), "// see R3 for the why\n");
    const result = await runCheck(
      [
        { path: "leaky.md", recursive: false },
        { path: "src", recursive: true, ext: ".ts" },
      ],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("failed: 2 ref(s)");
    expect(result.stderr).toContain("leaky.md:1:10  FR-002");
    expect(result.stderr).toContain("src/t.ts:1:8  R3");
    expect(result.stderr).toContain("→ Spec IDs belong in commit messages");
  });

  test("runCheck with default args scans the live repo and matches the CLI run", async () => {
    // No baseDir / no roots → uses the real SCAN_ROOTS against REPO_ROOT.
    // The repo is clean by enforcement, so the default invocation should pass.
    const result = await runCheck();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/passed \(\d+ files\)/);
  });

  test("SCAN_ROOTS includes every advertised shipped/config surface", () => {
    expect(SCAN_ROOTS.map((r) => r.path).sort()).toEqual([
      ".github/CODEOWNERS",
      ".github/copilot-instructions.md",
      ".github/dependabot.yml",
      ".github/workflows",
      "CLAUDE.md",
      "README.md",
      "biome.json",
      "bunfig.toml",
      "docs",
      "lefthook.yml",
      "package.json",
      "src",
    ]);
  });

  test("scripts/ is NOT in SCAN_ROOTS — the guard's own tests need spec IDs as fixtures", () => {
    // Same reason specs/ is excluded: this directory is allowed to contain
    // the very tokens the guard catches elsewhere. Pinning the absence is
    // the contract that protects the test suite from regression.
    expect(
      SCAN_ROOTS.find((r) => r.path === "scripts" || r.path.startsWith("scripts/")),
    ).toBeUndefined();
  });
});
