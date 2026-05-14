import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../../test-helpers/fixtures";
import { collectClaudePlugins, InvalidPluginNameError, validatePluginName } from "../plugins";

describe("validatePluginName", () => {
  test("accepts a typical plugin name", () => {
    expect(() => validatePluginName("my-plugin")).not.toThrow();
    expect(() => validatePluginName("acme.toolkit")).not.toThrow();
  });

  test("rejects empty, dot, dot-dot, leading-dot, separators, and control chars", () => {
    const bad = ["", ".", "..", ".hidden", "a/b", "a\\b", "ctrl\x00name"];
    for (const name of bad) {
      expect(() => validatePluginName(name)).toThrow(InvalidPluginNameError);
    }
  });
});

describe("collectClaudePlugins", () => {
  let tmpDir: string;
  let pluginsDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    pluginsDir = join(tmpDir, "plugins");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty when plugins root is missing", async () => {
    const entries = await collectClaudePlugins(pluginsDir);
    expect(entries).toHaveLength(0);
  });

  test("returns empty when plugins root is a symlink", async () => {
    const realRoot = join(tmpDir, "vendored-plugins");
    mkdirSync(realRoot, { recursive: true });
    const sample = join(realRoot, "vendored-plugin");
    mkdirSync(join(sample, ".claude-plugin"), { recursive: true });
    writeFileSync(join(sample, ".claude-plugin", "plugin.json"), "{}", "utf8");
    symlinkSync(realRoot, pluginsDir);

    const entries = await collectClaudePlugins(pluginsDir);
    expect(entries).toHaveLength(0);
  });

  test("discovers a plugin whose .claude-plugin/plugin.json exists", async () => {
    const root = join(pluginsDir, "sample-plugin");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "sample", version: "0.1.0" }),
      "utf8",
    );

    const entries = await collectClaudePlugins(pluginsDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("sample-plugin");
    expect(entries[0]?.paths.commandsDir).toBe(join(root, "commands"));
  });

  test("skips dot-prefixed entries", async () => {
    const root = join(pluginsDir, ".system");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), "{}", "utf8");

    const entries = await collectClaudePlugins(pluginsDir);
    expect(entries).toHaveLength(0);
  });

  test("skips a plugin whose manifest is missing", async () => {
    const root = join(pluginsDir, "no-manifest-plugin");
    mkdirSync(root, { recursive: true });

    const entries = await collectClaudePlugins(pluginsDir);
    expect(entries).toHaveLength(0);
  });

  test("skips a plugin whose manifest is a symlink", async () => {
    const realManifest = join(tmpDir, "vendored-manifest.json");
    writeFileSync(realManifest, "{}", "utf8");
    const root = join(pluginsDir, "fake-plugin");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    symlinkSync(realManifest, join(root, ".claude-plugin", "plugin.json"));

    const entries = await collectClaudePlugins(pluginsDir);
    expect(entries).toHaveLength(0);
  });

  test("skips a plugin entry that is itself a symlink", async () => {
    const realPlugin = join(tmpDir, "real-elsewhere");
    mkdirSync(join(realPlugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(realPlugin, ".claude-plugin", "plugin.json"), "{}", "utf8");

    mkdirSync(pluginsDir, { recursive: true });
    symlinkSync(realPlugin, join(pluginsDir, "linked-plugin"));

    const entries = await collectClaudePlugins(pluginsDir);
    expect(entries).toHaveLength(0);
  });
});
