import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";
import { atomicWrite, collect, readIfExists } from "../_utils";

// T017 — _utils helpers

describe("agents/_utils", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // readIfExists

  test("readIfExists returns file contents for an existing file", async () => {
    const p = join(tmpDir, "file.txt");
    await writeFile(p, "hello from file", "utf8");
    const result = await readIfExists(p);
    expect(result).toBe("hello from file");
  });

  test("readIfExists returns null when file does not exist", async () => {
    const result = await readIfExists(join(tmpDir, "nonexistent.txt"));
    expect(result).toBeNull();
  });

  test("readIfExists returns empty string for empty file", async () => {
    const p = join(tmpDir, "empty.txt");
    await writeFile(p, "", "utf8");
    const result = await readIfExists(p);
    expect(result).toBe("");
  });

  // atomicWrite

  test("atomicWrite creates a file with the correct content", async () => {
    const p = join(tmpDir, "output.txt");
    await atomicWrite(p, "atomic content");
    const read = await Bun.file(p).text();
    expect(read).toBe("atomic content");
  });

  test("atomicWrite creates nested directories if they do not exist", async () => {
    const p = join(tmpDir, "nested", "dir", "file.txt");
    await atomicWrite(p, "nested content");
    const read = await Bun.file(p).text();
    expect(read).toBe("nested content");
  });

  test("atomicWrite leaves no .tmp sidecar after success", async () => {
    const p = join(tmpDir, "atomic.txt");
    await atomicWrite(p, "data");
    const tmpFile = Bun.file(`${p}.tmp`);
    expect(await tmpFile.exists()).toBeFalse();
  });

  test("atomicWrite accepts a Buffer", async () => {
    const p = join(tmpDir, "buf.bin");
    const buf = Buffer.from("binary data", "utf8");
    await atomicWrite(p, buf);
    const content = await Bun.file(p).text();
    expect(content).toBe("binary data");
  });

  // collect

  test("collect returns a SnapshotArtifact with correct shape", () => {
    const result = { value: "plaintext content", warnings: [] };
    const artifact = collect(result, "/source/path/file.txt", "agent/file.txt.age");
    expect(artifact.vaultPath).toBe("agent/file.txt.age");
    expect(artifact.sourcePath).toBe("/source/path/file.txt");
    expect(artifact.plaintext).toBe("plaintext content");
    expect(artifact.warnings).toHaveLength(0);
  });

  test("collect propagates warnings from RedactionResult", () => {
    const result = {
      value: "$AGENTSYNC_REDACTED_SECRET",
      warnings: ["Redacted literal secret in field 'token'"],
    };
    const artifact = collect(result, "/src/settings.json", "claude/settings.json.age");
    expect(artifact.warnings).toHaveLength(1);
    expect(artifact.warnings[0]).toContain("Redacted");
  });
});
