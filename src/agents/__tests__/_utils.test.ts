import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";
import { atomicWrite, collect, readIfExists, setJsoncTopLevelKey } from "../_utils";

// _utils helpers

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
      warnings: ["Detected literal secret in field 'token'"],
    };
    const artifact = collect(result, "/src/settings.json", "claude/settings.json.age");
    expect(artifact.warnings).toHaveLength(1);
    expect(artifact.warnings[0]).toContain("Detected");
  });

  // setJsoncTopLevelKey

  test("setJsoncTopLevelKey writes a fresh object for empty input", () => {
    const out = setJsoncTopLevelKey("", "rules", "be concise");
    expect(JSON.parse(out)).toEqual({ rules: "be concise" });
  });

  test("setJsoncTopLevelKey edits one key in a strict-JSON document", () => {
    const raw = `{\n  "editor.fontSize": 14,\n  "rules": "old"\n}\n`;
    const parsed = JSON.parse(setJsoncTopLevelKey(raw, "rules", "new")) as Record<string, unknown>;
    expect(parsed.rules).toBe("new");
    expect(parsed["editor.fontSize"]).toBe(14);
  });

  test("setJsoncTopLevelKey tolerates a trailing comma instead of aborting", () => {
    // A trailing comma is the JSONC feature that made strict JSON.parse throw
    // "Property name must be a string literal" and abort the whole pull. The
    // jsonc-parser edit API must set the key and leave the comma in place.
    const raw = `{\n  "[typescript]": {\n    "editor.defaultFormatter": "esbenp.prettier-vscode",\n  },\n}\n`;
    const out = setJsoncTopLevelKey(raw, "rules", "be concise");
    expect(out).toContain('"rules": "be concise"');
    expect(out).toContain('"esbenp.prettier-vscode"');
  });

  test("setJsoncTopLevelKey preserves comments in the document", () => {
    const raw = `{\n  // user preference\n  "editor.wordWrap": "on"\n}\n`;
    const out = setJsoncTopLevelKey(raw, "rules", "x");
    expect(out).toContain("// user preference");
    expect(out).toContain('"rules": "x"');
  });

  test("setJsoncTopLevelKey sets an object value (hooks/mcpServers path)", () => {
    const raw = `{\n  "model": "opus"\n}\n`;
    const parsed = JSON.parse(setJsoncTopLevelKey(raw, "hooks", { PreToolUse: [] })) as Record<
      string,
      unknown
    >;
    expect(parsed.hooks).toEqual({ PreToolUse: [] });
    expect(parsed.model).toBe("opus");
  });

  test("setJsoncTopLevelKey writes a fresh object for whitespace-only input", () => {
    expect(JSON.parse(setJsoncTopLevelKey("  \n\t ", "rules", "x"))).toEqual({ rules: "x" });
  });

  test("setJsoncTopLevelKey replaces a non-object root instead of throwing", () => {
    expect(JSON.parse(setJsoncTopLevelKey("[1, 2, 3]", "rules", "x"))).toEqual({ rules: "x" });
  });

  test("setJsoncTopLevelKey replaces a malformed document instead of corrupting it", () => {
    const out = setJsoncTopLevelKey("{not valid json", "rules", "x");
    expect(JSON.parse(out)).toEqual({ rules: "x" });
  });
});
