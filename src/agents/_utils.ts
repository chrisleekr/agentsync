/**
 * src/agents/_utils.ts
 *
 * Shared helpers used by all agent snapshot/apply modules.
 * Centralised here so that adding a new agent never requires copy-pasting these utilities.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
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
 * Note: a write-to-tmp-then-rename atomic pattern is intentionally avoided here.
 * On Linux (e.g. GitHub Actions / ubuntu runners with Bun 1.3.x), `rename` after
 * `writeFile` to the same tmpfs directory reliably throws ENOENT because Bun's
 * io_uring back-end does not sequence the two operations as expected by the kernel.
 * For small config files written by a single-process CLI this direct write is safe.
 */
export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
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
