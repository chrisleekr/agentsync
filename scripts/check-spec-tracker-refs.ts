#!/usr/bin/env bun
/**
 * Fails CI when a user-facing doc, README, or CLAUDE.md leaks a
 * speckit spec-tracker ID (FR-###, SC-###, US#, T###, NC-#, research R#).
 *
 * Why: spec IDs are local to a single specs/<slug>/ directory that is
 * never rendered to the public docs site (mkdocs nav excludes specs/),
 * so a reader who lands on docs.example/troubleshooting via search has
 * no way to resolve "(FR-002)". The rule lives in CLAUDE.md and
 * docs/contributing.md; this script enforces it.
 *
 * Placeholder forms inside backticks (`FR-###`, `T###`, `NC-#`) are NOT
 * matched because the digit placeholders are # characters, not digits.
 * This is intentional: the rule itself must be quotable.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath handles Windows drive letters, percent-encoding, and UNC
// paths correctly. The naive `new URL(...).pathname` form leaks `/C:/...`
// shaped strings on Windows that node:path.join cannot resolve.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Surfaces scanned at every `bun run check`. README + CLAUDE + every
 * docs page are user-facing; src/** carries comments and test names
 * the original CLAUDE.md rule also bans; root configs and the GitHub
 * Actions workflows are shipped-with-the-repo surfaces where a
 * spec-ID leak would land on main with no other guard catching it.
 *
 * specs/** is deliberately NOT scanned — it is the one place spec
 * IDs are correct. scripts/__tests__/ is implicitly skipped because
 * scripts/ is not in any root — the guard's own tests need the spec
 * IDs as fixture material (same reason specs/ is excluded). The
 * .github/agents/ and .github/prompts/ trees are speckit tooling
 * downloaded with the plugin, not project-authored, so they are
 * excluded too.
 */
export const SCAN_ROOTS: ReadonlyArray<{ path: string; recursive: boolean; ext?: string }> = [
  { path: "README.md", recursive: false },
  { path: "CLAUDE.md", recursive: false },
  { path: "package.json", recursive: false },
  { path: "biome.json", recursive: false },
  { path: "bunfig.toml", recursive: false },
  { path: "lefthook.yml", recursive: false },
  { path: ".github/copilot-instructions.md", recursive: false },
  { path: ".github/CODEOWNERS", recursive: false },
  { path: ".github/dependabot.yml", recursive: false },
  { path: ".github/workflows", recursive: true, ext: ".yml" },
  { path: "docs", recursive: true, ext: ".md" },
  { path: "src", recursive: true, ext: ".ts" },
];

// Anchored on digits so the in-prose placeholder forms (FR-###, US#)
// inside the rule's own definition continue to compile cleanly.
// `R\d+` catches the bare research-ref forms speckit emits, e.g.
// `(R3)`, `(per research R2/R4/R7)`, `research R9`.
export const SPEC_ID_RE = /\b(?:FR-\d+|SC-\d+|US\d+|T\d{3}|NC-\d+|R\d+)\b/g;

export type Hit = {
  file: string;
  line: number;
  column: number;
  match: string;
  preview: string;
};

/** Scan a single text buffer for spec-tracker leakage. Pure — no I/O. */
export function scanText(text: string, file: string): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(SPEC_ID_RE)) {
      hits.push({
        file,
        line: i + 1,
        column: (m.index ?? 0) + 1,
        match: m[0],
        preview: line.trim().slice(0, 120),
      });
    }
  }
  return hits;
}

export async function collectFiles(
  root: { path: string; recursive: boolean; ext?: string },
  baseDir: string = REPO_ROOT,
): Promise<string[]> {
  const fullRoot = join(baseDir, root.path);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(fullRoot);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
  if (info.isFile()) return [root.path];
  if (!root.recursive) return [];

  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
        await walk(full);
      } else if (e.isFile()) {
        if (root.ext && !e.name.endsWith(root.ext)) continue;
        found.push(relative(baseDir, full));
      }
    }
  }
  await walk(fullRoot);
  return found.sort();
}

export async function scan(relPath: string, baseDir: string = REPO_ROOT): Promise<Hit[]> {
  const full = join(baseDir, relPath);
  let text: string;
  try {
    text = await readFile(full, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return scanText(text, relPath);
}

export type RunResult = { exitCode: 0 | 1; stdout: string; stderr: string };

/** Pure orchestration — returns the (exitCode, output) tuple instead of calling
 * process.exit, so the same code path is unit-testable against a tmpdir. */
export async function runCheck(
  roots: ReadonlyArray<{ path: string; recursive: boolean; ext?: string }> = SCAN_ROOTS,
  baseDir: string = REPO_ROOT,
): Promise<RunResult> {
  const allHits: Hit[] = [];
  let scannedCount = 0;
  for (const root of roots) {
    const files = await collectFiles(root, baseDir);
    scannedCount += files.length;
    for (const f of files) {
      allHits.push(...(await scan(f, baseDir)));
    }
  }

  if (allHits.length === 0) {
    return {
      exitCode: 0,
      stdout: `spec-tracker leakage check passed (${scannedCount} files).\n`,
      stderr: "",
    };
  }

  let stderr = `spec-tracker leakage check failed: ${allHits.length} ref(s)\n\n`;
  for (const h of allHits) {
    stderr += `  ${h.file}:${h.line}:${h.column}  ${h.match}\n    > ${h.preview}\n`;
  }
  stderr +=
    "\n  → Spec IDs belong in commit messages and PR descriptions, not in code or shipped docs.\n" +
    "    Replace with the rule name or the failure-mode description (see CLAUDE.md).\n";
  return { exitCode: 1, stdout: "", stderr };
}

async function main(): Promise<void> {
  const result = await runCheck();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}
