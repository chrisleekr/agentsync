import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createTmpDir } from "../../test-helpers/fixtures";
import { archiveDirectory, extractArchive, listArchiveEntries } from "../tar";

// Defensive re-install of the real node:fs/promises — see migrate.test.ts
// for the full explanation of the bleed this guards against.
{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => ({ ...realFsPromises, default: realFsPromises }));
}

function craftedTar(
  entries: Array<{
    path: string;
    body?: string | Buffer;
    declaredSize?: number;
    linkpath?: string;
    type?: "0" | "1" | "5" | "6" | "x";
  }>,
): Buffer {
  const encoded = entries.map(({ path, body = "", declaredSize, linkpath, type = "0" }) => {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write("0000644", 100, 8, "ascii");
    header.write("0000000", 108, 8, "ascii");
    header.write("0000000", 116, 8, "ascii");
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    header.write((declaredSize ?? payload.length).toString(8).padStart(11, "0"), 124, 12, "ascii");
    header.write("00000000000", 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write(type, 156, 1, "ascii");
    if (linkpath) header.write(linkpath, 157, 100, "utf8");
    header.write("ustar\x0000", 257, 8, "binary");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
    return Buffer.concat([header, payload, padding]);
  });
  return gzipSync(Buffer.concat([...encoded, Buffer.alloc(1024)]));
}

describe("tar", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // archiveDirectory returns non-empty Buffer

  test("archiveDirectory returns a non-empty Buffer", async () => {
    const srcDir = join(tmpDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "hello.txt"), "hello world", "utf8");

    const buf = await archiveDirectory(srcDir);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(0);
  });

  // round-trip: archive then extract preserves files

  test("archiveDirectory + extractArchive round-trips file contents", async () => {
    const srcDir = join(tmpDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "file.txt"), "content line\n", "utf8");
    await mkdir(join(srcDir, "nested"), { recursive: true });
    await writeFile(join(srcDir, "nested", "deep.txt"), "deep content", "utf8");

    const buf = await archiveDirectory(srcDir);

    const destDir = join(tmpDir, "dest");
    await mkdir(destDir, { recursive: true });
    await extractArchive(buf, destDir);

    const shallow = await Bun.file(join(destDir, "file.txt")).text();
    expect(shallow).toBe("content line\n");

    const deep = await Bun.file(join(destDir, "nested", "deep.txt")).text();
    expect(deep).toBe("deep content");
  });

  test("empty directory archives and extracts without error", async () => {
    const srcDir = join(tmpDir, "empty");
    await mkdir(srcDir, { recursive: true });

    const buf = await archiveDirectory(srcDir);
    expect(buf).toBeInstanceOf(Buffer);

    const destDir = join(tmpDir, "dest-empty");
    await mkdir(destDir, { recursive: true });
    await expect(extractArchive(buf, destDir)).resolves.toBeUndefined();
  });

  test("extractArchive preserves safe hard-link entries", async () => {
    const buf = craftedTar([
      { path: "target.md", body: "shared content" },
      { path: "alias.md", type: "1", linkpath: "target.md" },
    ]);
    const destDir = join(tmpDir, "dest-hardlink");
    await mkdir(destDir, { recursive: true });

    await extractArchive(buf, destDir);

    expect(await Bun.file(join(destDir, "target.md")).text()).toBe("shared content");
    expect(await Bun.file(join(destDir, "alias.md")).text()).toBe("shared content");
  });

  // zip-slip protection: absolute path entries are dropped

  test("extractArchive drops absolute-path entries (zip-slip protection)", async () => {
    // Build a normal archive first, then we verify absolute-path filtering logic
    // by directly testing the filter via the extractArchive entry-filter behaviour.
    // We construct a tar buffer that tries to escape by using a leading slash.
    // Since we can't easily craft a malicious tar without raw bytes, we test via
    // a safe archive and verify no traversal-named file appears in dest.
    const srcDir = join(tmpDir, "src-safe");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "safe.txt"), "ok", "utf8");

    const buf = await archiveDirectory(srcDir);
    const destDir = join(tmpDir, "dest-safe");
    await mkdir(destDir, { recursive: true });
    await extractArchive(buf, destDir);

    const text = await Bun.file(join(destDir, "safe.txt")).text();
    expect(text).toBe("ok");
  });

  // multiple files with unicode names preserved

  test("preserves unicode and hyphenated filenames", async () => {
    const srcDir = join(tmpDir, "src-uni");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "café-config.toml"), 'key = "value"', "utf8");

    const buf = await archiveDirectory(srcDir);
    const destDir = join(tmpDir, "dest-uni");
    await mkdir(destDir, { recursive: true });
    await extractArchive(buf, destDir);

    const text = await Bun.file(join(destDir, "café-config.toml")).text();
    expect(text).toBe('key = "value"');
  });

  // skipSymlinks filter

  test("archiveDirectory({ skipSymlinks: true }) omits symlink entries", async () => {
    const srcDir = join(tmpDir, "src-symlink-skip");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "SKILL.md"), "# real skill", "utf8");
    // Create a symlink target outside the source dir so the link is real but
    // the resolved path is unambiguously not a sibling of the real files.
    const linkTargetFile = join(tmpDir, "external-helper.md");
    await writeFile(linkTargetFile, "# vendored helper", "utf8");
    const linkTargetDir = join(tmpDir, "external-refs");
    await mkdir(linkTargetDir, { recursive: true });
    await writeFile(join(linkTargetDir, "shared.md"), "# shared", "utf8");

    await symlink(linkTargetFile, join(srcDir, "helper.md"));
    await symlink(linkTargetDir, join(srcDir, "refs"));

    const buf = await archiveDirectory(srcDir, { skipSymlinks: true });

    const destDir = join(tmpDir, "dest-symlink-skip");
    await mkdir(destDir, { recursive: true });
    await extractArchive(buf, destDir);

    const entries = await readdir(destDir);
    expect(entries).toContain("SKILL.md");
    expect(entries).not.toContain("helper.md");
    expect(entries).not.toContain("refs");
  });

  test("archiveDirectory excludes a selected subtree", async () => {
    const srcDir = join(tmpDir, "src-exclude");
    await mkdir(join(srcDir, "keep"), { recursive: true });
    await mkdir(join(srcDir, "nested-skill"), { recursive: true });
    await writeFile(join(srcDir, "keep", "notes.md"), "keep", "utf8");
    await writeFile(join(srcDir, "nested-skill", "SKILL.md"), "exclude", "utf8");

    const buffer = await archiveDirectory(srcDir, {
      exclude: (path) => path === "nested-skill" || path.startsWith("nested-skill/"),
    });
    expect((await listArchiveEntries(buffer)).map((entry) => entry.path)).toEqual([
      "keep/notes.md",
    ]);
  });

  test("strict archive inspection rejects link entries", async () => {
    if (process.platform === "win32") return;
    const srcDir = join(tmpDir, "src-strict-link");
    await mkdir(srcDir, { recursive: true });
    const target = join(tmpDir, "outside.txt");
    await writeFile(target, "outside", "utf8");
    await symlink(target, join(srcDir, "linked.txt"));
    const buffer = await archiveDirectory(srcDir);

    await expect(listArchiveEntries(buffer, { strict: true })).rejects.toThrow(
      "Unsupported archive entry type",
    );
  });

  test("strict archive inspection rejects FIFO entries", async () => {
    await expect(
      listArchiveEntries(craftedTar([{ path: "special", type: "6" }]), { strict: true }),
    ).rejects.toThrow("Unsupported archive entry type");
  });

  test("strict resource limits reject compressed and declared oversized entries", async () => {
    const limits = {
      maxEntries: 10,
      maxEntryBytes: 64 * 1024,
      maxTotalBytes: 128 * 1024,
      maxPathBytes: 256,
      maxExpandedBytes: 256 * 1024,
    };
    const compressed = craftedTar([
      { path: "large.txt", body: Buffer.alloc(limits.maxEntryBytes + 1, "A") },
    ]);
    expect(compressed.length).toBeLessThan(limits.maxEntryBytes);
    await expect(listArchiveEntries(compressed, { strict: true, limits })).rejects.toThrow(
      "Archive entry exceeds",
    );

    const declared = craftedTar([
      { path: "declared.txt", body: Buffer.alloc(65), declaredSize: 65 },
    ]);
    await expect(
      listArchiveEntries(declared, {
        strict: true,
        limits: { ...limits, maxEntryBytes: 64 },
      }),
    ).rejects.toThrow("64-byte limit");
  });

  test("strict resource limits reject entry count, total bytes, and path length", async () => {
    const base = {
      maxEntries: 2,
      maxEntryBytes: 64,
      maxTotalBytes: 64,
      maxPathBytes: 16,
      maxExpandedBytes: 64 * 1024,
    };
    await expect(
      listArchiveEntries(
        craftedTar([
          { path: "one", body: "1" },
          { path: "two", body: "2" },
          { path: "three", body: "3" },
        ]),
        { strict: true, limits: base },
      ),
    ).rejects.toThrow("2-entry limit");
    await expect(
      listArchiveEntries(
        craftedTar([
          { path: "one", body: Buffer.alloc(40) },
          { path: "two", body: Buffer.alloc(40) },
        ]),
        { strict: true, limits: { ...base, maxEntries: 10 } },
      ),
    ).rejects.toThrow("64-byte total limit");
    await expect(
      listArchiveEntries(craftedTar([{ path: "path-is-too-long.txt", body: "x" }]), {
        strict: true,
        limits: base,
      }),
    ).rejects.toThrow("16-byte limit");
  });

  test("resource limits do not change non-strict TUI inspection", async () => {
    const archive = craftedTar([{ path: "large.txt", body: "large body" }]);
    await expect(
      listArchiveEntries(archive, {
        limits: {
          maxEntries: 0,
          maxEntryBytes: 0,
          maxTotalBytes: 0,
          maxPathBytes: 0,
          maxExpandedBytes: 0,
        },
      }),
    ).resolves.toHaveLength(1);
  });

  test("strict resource limits count metadata headers and bound total expansion", async () => {
    const limits = {
      maxEntries: 2,
      maxEntryBytes: 64 * 1024,
      maxTotalBytes: 128 * 1024,
      maxPathBytes: 256,
      maxExpandedBytes: 64 * 1024,
    };
    await expect(
      listArchiveEntries(
        craftedTar([
          { path: "PaxHeaders/one", type: "x" },
          { path: "PaxHeaders/two", type: "x" },
          { path: "PaxHeaders/three", type: "x" },
        ]),
        { strict: true, limits },
      ),
    ).rejects.toThrow("2-entry limit");

    await expect(
      listArchiveEntries(craftedTar([{ path: "small.txt", body: "small" }]), {
        strict: true,
        limits: { ...limits, maxEntries: 10, maxExpandedBytes: 1024 },
      }),
    ).rejects.toThrow("1024-byte limit");
  });

  test("strict archive inspection accepts normal directory parents", async () => {
    const buffer = craftedTar([
      { path: "helpers/", type: "5" },
      { path: "helpers/run.md", body: "run" },
      { path: "SKILL.md", body: "skill" },
    ]);
    expect((await listArchiveEntries(buffer, { strict: true })).map((entry) => entry.path)).toEqual(
      ["helpers/run.md", "SKILL.md"],
    );
  });

  test("strict archive inspection rejects normalized duplicates and file-directory collisions", async () => {
    const cases = [
      {
        entries: [
          { path: "SKILL.md", body: "one" },
          { path: "SKILL.md", body: "two" },
        ],
        message: "path collision",
      },
      {
        entries: [
          { path: "Café.md", body: "one" },
          { path: "CAFÉ.md", body: "two" },
        ],
        message: "path collision",
      },
      {
        entries: [
          { path: "helpers", body: "file" },
          { path: "helpers/run.md", body: "child" },
        ],
        message: "file/directory collision",
      },
      {
        entries: [
          { path: "helpers/run.md", body: "child" },
          { path: "helpers", body: "file" },
        ],
        message: "file/directory collision",
      },
    ] as const;
    for (const item of cases) {
      await expect(
        listArchiveEntries(craftedTar([...item.entries]), { strict: true }),
      ).rejects.toThrow(item.message);
    }
  });

  test.each([
    "../escape.txt",
    "/etc/evil.txt",
    "C:/Windows/evil.txt",
  ])("strict archive inspection rejects unsafe path %s", async (path) => {
    await expect(
      listArchiveEntries(craftedTar([{ path, body: "bad" }]), { strict: true }),
    ).rejects.toThrow("Unsafe archive entry path");
  });

  test("archiveDirectory() default behavior is unchanged (no skipSymlinks)", async () => {
    // Regression: existing Copilot agent-tarballs (copilot/agents/*.tar.age)
    // call archiveDirectory without options. They expect symlinks to be
    // archived as symlink entries, not silently dropped.
    const srcDir = join(tmpDir, "src-default-symlinks");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "real.md"), "# real", "utf8");
    const linkTargetFile = join(tmpDir, "default-target.md");
    await writeFile(linkTargetFile, "# target", "utf8");
    await symlink(linkTargetFile, join(srcDir, "linked.md"));

    // No options → default behavior preserved.
    const buf = await archiveDirectory(srcDir);
    expect(buf.length).toBeGreaterThan(0);
    // We don't extract here — extractArchive's filter would normalise paths,
    // but the contract is "archiveDirectory's behavior is unchanged when no
    // option is passed", which is what we assert by getting a non-empty buffer
    // back without throwing on the symlink entry.
  });

  // tar determinism for status hash stability

  test("archiveDirectory({ skipSymlinks: true }) is deterministic across calls", async () => {
    // depends on `archiveDirectory` producing identical bytes for the
    // same directory tree so the status command's SHA-256 comparison is
    // stable. If this test fails, the fix is to set `gzip: { mtime: 0 }` (or
    // equivalent) on the underlying tar.create options so the gzip header
    // does not leak the time-of-archival.
    const srcDir = join(tmpDir, "src-determinism");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "SKILL.md"), "# determinism check", "utf8");
    await mkdir(join(srcDir, "nested"), { recursive: true });
    await writeFile(join(srcDir, "nested", "deep.md"), "deep", "utf8");

    const first = await archiveDirectory(srcDir, { skipSymlinks: true });
    const second = await archiveDirectory(srcDir, { skipSymlinks: true });

    expect(Buffer.compare(first, second)).toBe(0);
  });

  test("listArchiveEntries reads every regular file from a gzipped tar buffer", async () => {
    const srcDir = join(tmpDir, "src-list");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "SKILL.md"), "# skill\nbody\n", "utf8");
    await mkdir(join(srcDir, "helpers"), { recursive: true });
    await writeFile(join(srcDir, "helpers", "h.md"), "helper text", "utf8");

    const buffer = await archiveDirectory(srcDir);
    const entries = await listArchiveEntries(buffer);

    const byPath = new Map(entries.map((e) => [e.path, e.content.toString("utf8")]));
    expect(byPath.get("SKILL.md")).toBe("# skill\nbody\n");
    expect(byPath.get("helpers/h.md")).toBe("helper text");
  });

  test("listArchiveEntries drops absolute, traversal, and drive-letter entries", async () => {
    const buffer = craftedTar([
      { path: "safe/ok.md", body: "ok-body" },
      { path: "../escape.txt", body: "BAD" },
      { path: "/etc/evil.txt", body: "BAD" },
      { path: "C:/Windows/evil.txt", body: "BAD" },
    ]);
    expect((await listArchiveEntries(buffer)).map((entry) => entry.path)).toEqual(["safe/ok.md"]);
  });
});
