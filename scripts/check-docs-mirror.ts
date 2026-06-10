#!/usr/bin/env bun
/**
 * Fails CI when docs/ drifts from its declared ownership table.
 *
 * Why: a past dead link (README pointed at a docs/*.md page that
 * never existed) showed that strict mkdocs builds only validate links
 * inside the nav. Links from README and CLAUDE.md to docs/*.md slip
 * through. This check fills that gap by
 * pinning the docs/ page set to a single source of truth: the
 * ownership table in docs/contributing.md.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS_DIR = join(REPO_ROOT, "docs");
const CONTRIBUTING = join(DOCS_DIR, "contributing.md");
const README = join(REPO_ROOT, "README.md");
const CLAUDE_MD = join(REPO_ROOT, "CLAUDE.md");

const OWNERSHIP_HEADING = "## Doc ownership";

async function listDocs(): Promise<string[]> {
  const entries = await readdir(DOCS_DIR);
  return entries.filter((name) => name.endsWith(".md")).sort();
}

async function parseOwnershipTable(): Promise<string[]> {
  const text = await readFile(CONTRIBUTING, "utf8");
  const idx = text.indexOf(OWNERSHIP_HEADING);
  if (idx === -1) {
    throw new Error(
      `${CONTRIBUTING} is missing the "${OWNERSHIP_HEADING}" section. Every page listed in docs/ must appear in that table.`,
    );
  }
  const afterHeading = text.slice(idx + OWNERSHIP_HEADING.length);
  const nextHeadingMatch = afterHeading.match(/\n##\s/);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;

  const pages: string[] = [];
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trimStart();
    if (!line.startsWith("| `")) continue;
    const match = line.match(/^\|\s*`([^`]+\.md)`/);
    if (match) pages.push(match[1]);
  }

  if (pages.length === 0) {
    throw new Error(
      `${CONTRIBUTING} "${OWNERSHIP_HEADING}" section parsed to zero rows. The table is malformed or has been restructured. Expected rows of the form "| \`<filename>.md\` | ... |".`,
    );
  }

  return pages.sort();
}

async function scanDocLinks(filePath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const links = new Set<string>();
  const re = /\bdocs\/([A-Za-z0-9._-]+\.md)(?:#[A-Za-z0-9._-]+)?/g;
  for (const m of text.matchAll(re)) {
    links.add(m[1]);
  }
  return [...links];
}

async function main(): Promise<void> {
  const errors: string[] = [];

  const actual = await listDocs();
  const declared = await parseOwnershipTable();

  const declaredSet = new Set(declared);
  const actualSet = new Set(actual);

  const missingFromTable = actual.filter((f) => !declaredSet.has(f));
  if (missingFromTable.length) {
    errors.push(
      `docs/ files not listed in "${OWNERSHIP_HEADING}" of docs/contributing.md:\n  - ${missingFromTable.join("\n  - ")}\n  → add an ownership row for each.`,
    );
  }

  const missingFiles = declared.filter((f) => !actualSet.has(f));
  if (missingFiles.length) {
    errors.push(
      `Ownership table lists files that do not exist in docs/:\n  - ${missingFiles.join("\n  - ")}\n  → either create the file or remove the row.`,
    );
  }

  for (const source of [README, CLAUDE_MD]) {
    const links = await scanDocLinks(source);
    const dead = links.filter((name) => !actualSet.has(name));
    if (dead.length) {
      errors.push(
        `${source.replace(REPO_ROOT, "")} links to non-existent docs/ files:\n  - docs/${dead.join("\n  - docs/")}\n  → fix the link or restore the file.`,
      );
    }
  }

  if (errors.length) {
    process.stderr.write("docs/ ownership check failed:\n\n");
    for (const e of errors) process.stderr.write(`${e}\n\n`);
    process.exit(1);
  }

  process.stdout.write(`docs/ ownership check passed (${actual.length} files).\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
