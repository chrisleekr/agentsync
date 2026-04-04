import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";
import { loadConfig, resolveConfigPath, writeConfig } from "../loader";

const MINIMAL_TOML = `
version = "1"

[recipients]
alice = "age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs8xmq8"

[agents]
cursor = true
claude = true
codex = true
copilot = true
vscode = false

[remote]
url = "git@github.com:alice/vault.git"
branch = "main"

[sync]
debounceMs = 300
autoPush = true
autoPull = true
pullIntervalMs = 300000
`;

describe("loader", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    configPath = join(tmpDir, "agentsync.toml");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // T012 — loadConfig happy path

  test("loadConfig parses a valid TOML file", async () => {
    await writeFile(configPath, MINIMAL_TOML, "utf8");
    const config = await loadConfig(configPath);
    expect(config.version).toBe("1");
    expect(config.remote.url).toBe("git@github.com:alice/vault.git");
    expect(config.agents.cursor).toBeTrue();
    expect(config.agents.vscode).toBeFalse();
    expect(config.sync.debounceMs).toBe(300);
  });

  test("loadConfig throws on missing file", async () => {
    await expect(loadConfig(join(tmpDir, "nonexistent.toml"))).rejects.toThrow();
  });

  test("loadConfig throws on TOML that fails Zod validation", async () => {
    const invalid = `[remote]\nurl = ""\nbranch = "main"\n`;
    await writeFile(configPath, invalid, "utf8");
    await expect(loadConfig(configPath)).rejects.toThrow();
  });

  // T013 — writeConfig round-trip

  test("writeConfig + loadConfig round-trips a config object", async () => {
    await writeFile(configPath, MINIMAL_TOML, "utf8");
    const original = await loadConfig(configPath);

    const roundTripPath = join(tmpDir, "agentsync-rt.toml");
    await writeConfig(roundTripPath, original);
    const reloaded = await loadConfig(roundTripPath);

    expect(reloaded.remote.url).toBe(original.remote.url);
    expect(reloaded.recipients).toEqual(original.recipients);
    expect(reloaded.agents).toEqual(original.agents);
    expect(reloaded.sync.debounceMs).toBe(original.sync.debounceMs);
  });

  test("writeConfig creates parent directories if needed", async () => {
    const nestedPath = join(tmpDir, "nested", "dir", "agentsync.toml");
    await writeFile(configPath, MINIMAL_TOML, "utf8");
    const config = await loadConfig(configPath);
    await expect(writeConfig(nestedPath, config)).resolves.toBeUndefined();
    const reloaded = await loadConfig(nestedPath);
    expect(reloaded.version).toBe("1");
  });

  // T014 — resolveConfigPath

  test("resolveConfigPath appends agentsync.toml to vaultDir", () => {
    const result = resolveConfigPath("/my/vault");
    expect(result).toBe("/my/vault/agentsync.toml");
  });
});
