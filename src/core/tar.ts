import type { Stats } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// tar v7 is a TypeScript rewrite that ships its own .d.ts — import named exports directly.
import { type ReadEntry, c as tarCreate, x as tarExtract } from "tar";

/** Optional knobs for {@link archiveDirectory}. */
export interface ArchiveDirectoryOptions {
  /**
   * When true, symlink entries (files OR sub-directories) inside `dirPath` are
   * filtered out of the archive. Real entries surrounding the symlinks are
   * still archived. Default `false` preserves the existing tar-everything
   * behavior used by Copilot agent-tarballs.
   *
   * Set this to `true` for skill-directory archives so vendored helper files
   * symlinked into a user skill never reach the encrypted vault (FR-016 inner
   * tier of the agent-skills-sync feature).
   */
  skipSymlinks?: boolean;
}

/**
 * Create a gzipped tar archive of a directory and return the result as a Buffer.
 *
 * @param dirPath Absolute path to the directory to archive.
 * @param options Optional flags. Pass `{ skipSymlinks: true }` to omit
 *                symlink entries from the resulting archive — required by
 *                the skills walker so vendored pool data is never indirectly
 *                leaked into the vault through a follow-the-link archival.
 */
export async function archiveDirectory(
  dirPath: string,
  options: ArchiveDirectoryOptions = {},
): Promise<Buffer> {
  const chunks: Buffer[] = [];

  // tar v7's filter callback receives `Stats | ReadEntry`. In create-mode
  // (which is what we use here) the entry is always a `node:fs` Stats object
  // produced by tar's internal lstat — but the union signature exists because
  // the same callback type is reused by extract-mode. We narrow at runtime
  // by feature-detecting `isSymbolicLink` and fall back to checking the
  // ReadEntry `type` field for forward compatibility. TypeScript's `in`
  // operator narrows the union arms automatically, so no explicit casts are
  // needed inside the branches.
  const filter = options.skipSymlinks
    ? (_path: string, entry: Stats | ReadEntry): boolean => {
        if ("isSymbolicLink" in entry && typeof entry.isSymbolicLink === "function") {
          return !entry.isSymbolicLink();
        }
        if ("type" in entry) {
          return entry.type !== "SymbolicLink";
        }
        return true;
      }
    : undefined;

  // tarCreate() with no `file` option returns a streaming Pack (ReadableStream).
  await new Promise<void>((resolve, reject) => {
    const stream = tarCreate(
      {
        gzip: true,
        cwd: dirPath,
        portable: true,
        ...(filter ? { filter } : {}),
      },
      ["."],
    ) as unknown as NodeJS.ReadableStream;

    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  return Buffer.concat(chunks);
}

/**
 * Extract a gzipped tar archive (provided as Buffer) into a target directory.
 *
 * Security: entries with absolute paths or path-traversal (`..`) segments are
 * silently dropped before extraction to prevent a "zip-slip" attack on crafted
 * archives delivered through the encrypted vault.
 *
 * @param buffer    The tar.gz buffer to extract.
 * @param targetDir Absolute path of the directory to extract into.
 */
export async function extractArchive(buffer: Buffer, targetDir: string): Promise<void> {
  const readable = Readable.from(buffer);
  const extract = tarExtract({
    cwd: targetDir,
    strip: 0,
    filter: (entryPath: string) => {
      // Normalise separators and reject any traversal attempt.
      const normalised = entryPath.replaceAll("\\", "/");
      if (normalised.startsWith("/")) return false;
      if (normalised.split("/").includes("..")) return false;
      return true;
    },
  });
  await pipeline(readable, extract as unknown as NodeJS.WritableStream);
}
