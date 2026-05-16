import type { Stats } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// tar v7 is a TypeScript rewrite that ships its own .d.ts — import named exports directly.
import { type ReadEntry, c as tarCreate, x as tarExtract, t as tarList } from "tar";

/** Optional knobs for {@link archiveDirectory}. */
export interface ArchiveDirectoryOptions {
  /**
   * When true, symlink entries (files OR sub-directories) inside `dirPath` are
   * filtered out of the archive. Real entries surrounding the symlinks are
   * still archived. Default `false` preserves the existing tar-everything
   * behavior used by Copilot agent-tarballs.
   *
   * Set to `true` for skill-directory archives so vendored helper files
   * symlinked into a user skill never reach the encrypted vault.
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

/** A single regular-file entry decoded from a tar.gz buffer. */
export interface TarEntry {
  /** POSIX-style path relative to the archive root, leading `./` stripped. */
  path: string;
  content: Buffer;
}

/**
 * Read every regular-file entry from a gzipped tar buffer into memory.
 * Used by the TUI's skill drill-in to inspect bundle contents without
 * extracting decrypted plaintext to disk. Symlinks, directories, and
 * traversal entries are dropped — same security posture as
 * {@link extractArchive}.
 */
export async function listArchiveEntries(buffer: Buffer): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const pending: Promise<void>[] = [];

  // tar v7 defaults to `noResume: false`, which auto-resumes each entry
  // stream after this callback returns — no explicit `entry.resume()` needed
  // for the non-File branches we drop on the floor.
  const list = tarList({
    onReadEntry: (entry: ReadEntry) => {
      if (entry.type !== "File") return;
      const normalised = entry.path.replace(/^\.\//, "").replaceAll("\\", "/");
      // Reject POSIX-absolute (`/foo`), Windows drive-letter (`C:/foo`),
      // and any traversal segment (`..`). The drive-letter check matters
      // even on Unix targets so a crafted Windows tar cannot place its
      // payload at a controlled drive root if an operator ever runs the
      // drill-in on a Windows host.
      if (
        normalised.startsWith("/") ||
        /^[A-Za-z]:/.test(normalised) ||
        normalised.split("/").includes("..")
      ) {
        return;
      }
      pending.push(
        new Promise<void>((resolve, reject) => {
          const chunks: Buffer[] = [];
          entry.on("data", (c: Buffer) => chunks.push(c));
          entry.on("end", () => {
            entries.push({ path: normalised, content: Buffer.concat(chunks) });
            resolve();
          });
          entry.on("error", reject);
        }),
      );
    },
  });

  await pipeline(Readable.from(buffer), list as unknown as NodeJS.WritableStream);
  await Promise.all(pending);
  return entries;
}
