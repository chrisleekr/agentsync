/**
 * src/agents/_utils.ts
 *
 * Shared helpers used by all agent snapshot/apply modules.
 * Centralised here so that adding a new agent never requires copy-pasting these utilities.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RedactionResult } from "../core/sanitizer";

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
