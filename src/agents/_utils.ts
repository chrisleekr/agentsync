/**
 * src/agents/_utils.ts
 *
 * Shared helpers used by all agent snapshot/apply modules.
 * Centralised here so that adding a new agent never requires copy-pasting these utilities.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";
import type { RedactionResult } from "../core/sanitizer";

/**
 * Preserve the previous file content next to the original as `<path>.bak`
 * before an overwrite. Called by every adapter's apply path so a destructive
 * pull leaves an undo handle on disk. No-op when the file doesn't yet exist.
 */
export async function ensureCommandBackup(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (err) {
    // No existing file → nothing to back up. Any other stat error
    // (permission denied, I/O failure) propagates because it signals a
    // real problem the caller needs to see.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await writeFile(`${path}.bak`, await readFile(path, "utf8"), "utf8");
}

// ─── Canonical snapshot types ────────────────────────────────────────────────

export interface SnapshotArtifact {
  /** Relative path inside the vault (always ends in `.age` or `.tar.age`). */
  vaultPath: string;
  /** Plaintext content — UTF-8 string, or base64 for binary archives. */
  plaintext: string;
  /** Absolute path of the source file or directory on the local machine. */
  sourcePath: string;
  warnings: string[];
}

export interface SnapshotResult {
  artifacts: SnapshotArtifact[];
  warnings: string[];
}

// ─── File helpers ─────────────────────────────────────────────────────────────

/** Read a file as UTF-8, returning null instead of throwing on ENOENT. */
export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Write `content` to `path`, creating parent directories as needed.
 *
 * Note: synchronous fs APIs are used intentionally here.
 * On Linux (e.g. GitHub Actions / ubuntu runners with Bun 1.3.x), Bun's async fs
 * operations against tmpfs-backed paths can resolve before the file is visible to a
 * subsequent open/readdir call in the same test. Using sync mkdir/write avoids both
 * the earlier rename race and the direct write visibility race for these tiny files.
 */
export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Set a single top-level key in a JSONC document, leaving the rest of the file
 * verbatim — comments, trailing commas, and formatting all survive.
 *
 * Agent config files (Cursor/VS Code settings.json, ~/.claude/settings.json,
 * ~/.claude.json) are JSONC, not strict JSON. A plain `JSON.parse` on the apply
 * path aborts the whole pull on a trailing comma, and a `JSON.parse` →
 * `JSON.stringify` round-trip silently discards the user's comments. The
 * `jsonc-parser` edit API tolerates JSONC and rewrites only the owned key, so a
 * pull never reformats config AgentSync does not control.
 *
 * When `raw` has no editable JSONC object — it is empty, whitespace-only,
 * malformed, or a non-object root (array/primitive) — there is nothing to edit
 * in place: `modify` would either throw or splice a fresh object before the
 * residual content. A clean single-key object is written instead. A freshly
 * written file ends in a newline; an edited file keeps the user's own EOF.
 */
export function setJsoncTopLevelKey(raw: string, key: string, value: unknown): string {
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  const rootIsObject =
    errors.length === 0 && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  if (!rootIsObject) {
    return `${JSON.stringify({ [key]: value }, null, 2)}\n`;
  }
  const edits = modify(raw, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  return applyEdits(raw, edits);
}

/**
 * Read a single top-level key from a JSONC document, tolerating comments and
 * trailing commas. Returns undefined when the document is empty, malformed, a
 * non-object root, or the key is absent — callers treat "no local value" the
 * same as a missing file, so a best-effort parse is the right contract here.
 */
export function getJsoncTopLevelKey(raw: string, key: string): unknown {
  const parsed = parse(raw, [], { allowTrailingComma: true });
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Parse a whole JSONC document into a plain object, tolerating comments and
 * trailing commas. Returns undefined for an empty, malformed, or non-object
 * root — callers treat that as "no local value to merge against".
 */
export function parseJsoncObject(raw: string): Record<string, unknown> | undefined {
  const parsed = parse(raw, [], { allowTrailingComma: true });
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * Build a `SnapshotArtifact` from a `RedactionResult<string>`.
 * Using this helper keeps the artifact shape consistent across agents.
 */
export function collect(
  result: RedactionResult<string>,
  sourcePath: string,
  vaultPath: string,
): SnapshotArtifact {
  return {
    vaultPath,
    sourcePath,
    plaintext: result.value,
    warnings: result.warnings,
  };
}
