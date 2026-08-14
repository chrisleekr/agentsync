import type { Stats } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
// tar v7 is a TypeScript rewrite that ships its own .d.ts — import named exports directly.
import { type ReadEntry, c as tarCreate, x as tarExtract, t as tarList } from "tar";
import { Header } from "tar/header";

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
  /** Exclude a source-relative path and its descendants from the archive. */
  exclude?: (relativePath: string) => boolean;
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
  const filter =
    options.skipSymlinks || options.exclude
      ? (entryPath: string, entry: Stats | ReadEntry): boolean => {
          const relativePath = entryPath.replace(/^\.\/?/, "").replaceAll("\\", "/");
          if (relativePath && options.exclude?.(relativePath)) return false;
          if (!options.skipSymlinks) return true;
          if ("isSymbolicLink" in entry && typeof entry.isSymbolicLink === "function") {
            return !entry.isSymbolicLink();
          }
          if ("type" in entry) return entry.type !== "SymbolicLink" && entry.type !== "Link";
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

/** A decoded tar entry. Directory entries are returned only when requested. */
export interface TarEntry {
  /** POSIX-style path relative to the archive root, leading `./` stripped. */
  path: string;
  type: "file" | "directory";
  content: Buffer;
}

export interface ArchiveInspectionLimits {
  /** Maximum number of archive headers, including directories. */
  maxEntries: number;
  /** Maximum decompressed byte length of one regular file. */
  maxEntryBytes: number;
  /** Maximum combined decompressed byte length of all regular files. */
  maxTotalBytes: number;
  /** Maximum UTF-8 byte length of one archive path. */
  maxPathBytes: number;
  /** Maximum expanded tar byte length, including metadata, headers, and padding. */
  maxExpandedBytes: number;
}

export interface ListArchiveEntriesOptions {
  /** Reject links, special entries, and unsafe paths instead of dropping them. */
  strict?: boolean;
  /** Include directory entries. Default false preserves file-only callers. */
  includeDirectories?: boolean;
  /** Resource bounds for strict, untrusted archive inspection. */
  limits?: ArchiveInspectionLimits;
}

function strictArchiveLimitGuard(limits: ArchiveInspectionLimits): Transform {
  let expandedBytes = 0;
  let entryCount = 0;
  let declaredFileBytes = 0;
  let bodyBytesRemaining = 0;
  let headerBytes = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        expandedBytes += chunk.length;
        if (expandedBytes > limits.maxExpandedBytes) {
          throw new Error(`Archive expands beyond the ${limits.maxExpandedBytes}-byte limit`);
        }

        let offset = 0;
        while (offset < chunk.length) {
          if (bodyBytesRemaining > 0) {
            const consumed = Math.min(bodyBytesRemaining, chunk.length - offset);
            bodyBytesRemaining -= consumed;
            offset += consumed;
            continue;
          }

          const consumed = Math.min(512 - headerBytes.length, chunk.length - offset);
          headerBytes = Buffer.concat([headerBytes, chunk.subarray(offset, offset + consumed)]);
          offset += consumed;
          if (headerBytes.length < 512) continue;

          const header = new Header(headerBytes);
          headerBytes = Buffer.alloc(0);
          if (header.nullBlock) continue;
          if (!header.cksumValid) throw new Error("Archive header checksum is invalid");

          entryCount++;
          if (entryCount > limits.maxEntries) {
            throw new Error(`Archive exceeds the ${limits.maxEntries}-entry limit`);
          }
          if (Buffer.byteLength(header.path ?? "", "utf8") > limits.maxPathBytes) {
            throw new Error(
              `Archive entry path exceeds the ${limits.maxPathBytes}-byte limit: ${header.path}`,
            );
          }

          const size = header.size ?? 0;
          if (!Number.isSafeInteger(size) || size < 0) {
            throw new Error(`Archive entry has an invalid declared size: ${header.path}`);
          }
          if (size > limits.maxExpandedBytes) {
            throw new Error(
              `Archive entry body exceeds the ${limits.maxExpandedBytes}-byte expanded limit: ${header.path}`,
            );
          }
          if (header.type === "File") {
            if (size > limits.maxEntryBytes) {
              throw new Error(
                `Archive entry exceeds the ${limits.maxEntryBytes}-byte limit: ${header.path}`,
              );
            }
            declaredFileBytes += size;
            if (declaredFileBytes > limits.maxTotalBytes) {
              throw new Error(
                `Archive exceeds the ${limits.maxTotalBytes}-byte total limit at: ${header.path}`,
              );
            }
          }

          bodyBytesRemaining = Math.ceil(size / 512) * 512;
          if (!Number.isSafeInteger(bodyBytesRemaining)) {
            throw new Error(`Archive entry has an invalid padded size: ${header.path}`);
          }
        }
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback) {
      if (headerBytes.length > 0 || bodyBytesRemaining > 0) {
        callback(new Error("Archive is truncated"));
        return;
      }
      callback();
    },
  });
}

/**
 * Read every regular-file entry from a gzipped tar buffer into memory.
 * Used by the TUI's skill drill-in to inspect bundle contents without
 * extracting decrypted plaintext to disk. Symlinks, directories, and
 * traversal entries are dropped — same security posture as
 * {@link extractArchive}.
 */
export async function listArchiveEntries(
  buffer: Buffer,
  options: ListArchiveEntriesOptions = {},
): Promise<TarEntry[]> {
  const entries: TarEntry[] = [];
  const pending: Promise<void>[] = [];
  let validationError: Error | null = null;
  const strictEntries = new Map<string, { path: string; type: "file" | "directory" }>();
  const limits = options.strict ? options.limits : undefined;
  let bufferedTotalBytes = 0;

  let failValidation = (message: string): void => {
    if (validationError === null) validationError = new Error(message);
  };

  // tar v7 defaults to `noResume: false`, which auto-resumes each entry
  // stream after this callback returns — no explicit `entry.resume()` needed
  // for the non-File branches we drop on the floor.
  const list = tarList({
    ...(limits ? { gzip: false, brotli: false, zstd: false } : {}),
    onReadEntry: (entry: ReadEntry) => {
      const normalised = entry.path.replace(/^\.\//, "").replaceAll("\\", "/").replace(/\/+$/, "");
      if (limits) {
        if (Buffer.byteLength(entry.path, "utf8") > limits.maxPathBytes) {
          failValidation(
            `Archive entry path exceeds the ${limits.maxPathBytes}-byte limit: ${entry.path}`,
          );
        }
        if (validationError) return;
      }
      if (normalised.length === 0 && entry.type === "Directory") return;
      // Reject POSIX-absolute (`/foo`), Windows drive-letter (`C:/foo`),
      // and any traversal segment (`..`). The drive-letter check matters
      // even on Unix targets so a crafted Windows tar cannot place its
      // payload at a controlled drive root if an operator ever runs the
      // drill-in on a Windows host.
      if (
        normalised.length === 0 ||
        normalised.startsWith("/") ||
        /^[A-Za-z]:/.test(normalised) ||
        normalised.split("/").includes("..")
      ) {
        if (options.strict && validationError === null) {
          failValidation(`Unsafe archive entry path: ${entry.path}`);
        }
        return;
      }
      if (entry.type !== "File") {
        if (options.strict && entry.type !== "Directory" && validationError === null) {
          failValidation(`Unsupported archive entry type '${entry.type}' at '${entry.path}'`);
        }
        if (entry.type !== "Directory") return;
      }
      if (options.strict) {
        const type = entry.type === "File" ? "file" : "directory";
        const key = normalised.normalize("NFC").toLowerCase();
        const existing = strictEntries.get(key);
        if (existing && validationError === null) {
          failValidation(`Archive entry path collision: '${existing.path}' and '${normalised}'`);
        }
        const segments = normalised.split("/");
        for (let index = 1; index < segments.length; index++) {
          const parentKey = segments.slice(0, index).join("/").normalize("NFC").toLowerCase();
          const parent = strictEntries.get(parentKey);
          if (parent?.type === "file" && validationError === null) {
            failValidation(
              `Archive file/directory collision: '${parent.path}' and '${normalised}'`,
            );
          }
        }
        if (type === "file") {
          const child = [...strictEntries.entries()].find(([existingKey]) =>
            existingKey.startsWith(`${key}/`),
          );
          if (child && validationError === null) {
            failValidation(
              `Archive file/directory collision: '${normalised}' and '${child[1].path}'`,
            );
          }
        }
        if (!existing) strictEntries.set(key, { path: normalised, type });
        if (validationError) return;
      }
      if (entry.type !== "File") {
        if (options.includeDirectories && entry.type === "Directory") {
          entries.push({ path: normalised, type: "directory", content: Buffer.alloc(0) });
        }
        return;
      }
      pending.push(
        new Promise<void>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let entryBytes = 0;
          entry.on("data", (chunk: Buffer) => {
            if (validationError) return;
            if (limits) {
              entryBytes += chunk.length;
              bufferedTotalBytes += chunk.length;
              if (entryBytes > limits.maxEntryBytes) {
                failValidation(
                  `Archive entry exceeds the ${limits.maxEntryBytes}-byte limit: ${entry.path}`,
                );
                return;
              }
              if (bufferedTotalBytes > limits.maxTotalBytes) {
                failValidation(
                  `Archive exceeds the ${limits.maxTotalBytes}-byte total limit at: ${entry.path}`,
                );
                return;
              }
            }
            chunks.push(chunk);
          });
          entry.on("end", () => {
            entries.push({ path: normalised, type: "file", content: Buffer.concat(chunks) });
            resolve();
          });
          entry.on("error", reject);
        }),
      );
    },
  });

  failValidation = (message: string): void => {
    if (validationError) return;
    const error = new Error(message);
    validationError = error;
    list.abort(error);
  };

  if (limits) {
    const guard = strictArchiveLimitGuard(limits);
    const gzip = buffer[0] === 0x1f && buffer[1] === 0x8b;
    if (gzip) {
      await pipeline(
        Readable.from(buffer),
        createGunzip(),
        guard,
        list as unknown as NodeJS.WritableStream,
      );
    } else {
      await pipeline(Readable.from(buffer), guard, list as unknown as NodeJS.WritableStream);
    }
  } else {
    await pipeline(Readable.from(buffer), list as unknown as NodeJS.WritableStream);
  }
  await Promise.all(pending);
  if (validationError) throw validationError;
  return entries;
}
