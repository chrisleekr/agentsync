import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// tar v7 is a TypeScript rewrite that ships its own .d.ts — import named exports directly.
import { c as tarCreate, x as tarExtract } from "tar";

/**
 * Create a gzipped tar archive of a directory and return the result as a Buffer.
 *
 * @param dirPath Absolute path to the directory to archive.
 */
export async function archiveDirectory(dirPath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];

  // tarCreate() with no `file` option returns a streaming Pack (ReadableStream).
  await new Promise<void>((resolve, reject) => {
    const stream = tarCreate(
      {
        gzip: true,
        cwd: dirPath,
        portable: true,
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
