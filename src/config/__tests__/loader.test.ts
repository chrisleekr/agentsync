import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parse as parseToml } from "@iarna/toml";
import { createTmpDir } from "../../test-helpers/fixtures";
import {
  formatConfigError,
  isConfigParseError,
  loadConfig,
  peekVaultVersion,
  resolveConfigPath,
  writeConfig,
} from "../loader";
import { AgentSyncConfigSchema, CURRENT_VAULT_VERSION } from "../schema";

// Defensive re-install of the real node:fs/promises — see migrate.test.ts
// for the full explanation of the bleed this guards against.
{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

const MINIMAL_TOML = `
version = 2

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

  // loadConfig happy path

  test("loadConfig parses a valid TOML file", async () => {
    await writeFile(configPath, MINIMAL_TOML, "utf8");
    const config = await loadConfig(configPath);
    expect(config.version).toBe(2);
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

  // writeConfig round-trip

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

  test("writeConfig leaves no temp sibling after a successful write", async () => {
    await writeFile(configPath, MINIMAL_TOML, "utf8");
    const config = await loadConfig(configPath);
    await writeConfig(configPath, config);
    // The temp file must have been renamed over the destination, not left behind.
    const leftovers = (await readdir(tmpDir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect((await loadConfig(configPath)).version).toBe(2);
  });

  test("writeConfig preserves the destination and removes the temp when rename fails", async () => {
    // A directory at the destination path makes rename(file -> dir) fail,
    // standing in for any mid-write rename failure. The original must survive
    // and no partial temp may be left in the vault tree.
    const dirDest = join(tmpDir, "as-dir");
    await mkdir(dirDest, { recursive: true });
    await writeFile(configPath, MINIMAL_TOML, "utf8");
    const config = await loadConfig(configPath);
    await expect(writeConfig(dirDest, config)).rejects.toThrow();
    const leftovers = (await readdir(tmpDir)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect((await stat(dirDest)).isDirectory()).toBeTrue();
  });

  test("writeConfig creates parent directories if needed", async () => {
    const nestedPath = join(tmpDir, "nested", "dir", "agentsync.toml");
    await writeFile(configPath, MINIMAL_TOML, "utf8");
    const config = await loadConfig(configPath);
    await expect(writeConfig(nestedPath, config)).resolves.toBeUndefined();
    const reloaded = await loadConfig(nestedPath);
    expect(reloaded.version).toBe(2);
  });

  // peekVaultVersion — the two-phase load probe (routes v1 to `vault upgrade`)

  test("peekVaultVersion reports absent for a missing config file", async () => {
    expect(await peekVaultVersion(join(tmpDir, "nope.toml"))).toEqual({ kind: "absent" });
  });

  test("peekVaultVersion reports v2 for the integer version 2", async () => {
    await writeFile(configPath, 'version = 2\n[remote]\nurl = "x"\n', "utf8");
    expect(await peekVaultVersion(configPath)).toEqual({ kind: "v2" });
  });

  test("peekVaultVersion reports v1 for a string version (the legacy flat layout)", async () => {
    await writeFile(configPath, 'version = "1"\n[remote]\nurl = "x"\n', "utf8");
    expect(await peekVaultVersion(configPath)).toEqual({ kind: "v1" });
  });

  test("peekVaultVersion reports v1 when the version field is absent", async () => {
    await writeFile(configPath, '[remote]\nurl = "x"\n', "utf8");
    expect(await peekVaultVersion(configPath)).toEqual({ kind: "v1" });
  });

  test("peekVaultVersion reports unsupported for an integer above the current version", async () => {
    await writeFile(configPath, 'version = 3\n[remote]\nurl = "x"\n', "utf8");
    expect(await peekVaultVersion(configPath)).toEqual({ kind: "unsupported", version: 3 });
  });

  test("peekVaultVersion propagates a TOML parse error", async () => {
    await writeFile(configPath, "this is = not [ valid toml", "utf8");
    await expect(peekVaultVersion(configPath)).rejects.toThrow();
  });

  // resolveConfigPath

  test("resolveConfigPath appends agentsync.toml to vaultDir", () => {
    const result = resolveConfigPath("/my/vault");
    expect(result).toBe("/my/vault/agentsync.toml");
  });
});

describe("formatConfigError", () => {
  const CONFIG_PATH = "/vault/agentsync.toml";

  // A fully valid config; each test overrides exactly one field so the parse
  // produces a single isolated issue, independent of Zod's issue ordering or
  // formatConfigError's 3-issue cap.
  const validBase = {
    version: CURRENT_VAULT_VERSION,
    recipients: { me: "age1qpzry9x8gf2tvdw0s3jn54khce6mua7l" },
    agents: { cursor: true, claude: true, codex: true, copilot: true, vscode: false },
    remote: { url: "git@github.com:user/vault.git", branch: "main" },
    sync: { debounceMs: 300, autoPush: true },
  };

  test("names the offending recipient alias for a schema (Zod) error", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...validBase,
      recipients: { alice: "notage1xyz" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatConfigError(result.error, CONFIG_PATH);
      expect(msg).toContain(CONFIG_PATH);
      expect(msg).toContain("recipients.alice");
      expect(msg).toContain("Invalid config");
    }
  });

  test("names remote.branch for an empty-branch schema error", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...validBase,
      remote: { url: "git@github.com:user/vault.git", branch: "" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatConfigError(result.error, CONFIG_PATH)).toContain("remote.branch");
    }
  });

  test("renders a TOML syntax error as one line with the path, no stack trace", () => {
    let tomlErr: unknown;
    try {
      parseToml("a = ");
    } catch (e) {
      tomlErr = e;
    }
    expect(isConfigParseError(tomlErr)).toBeTrue();
    const msg = formatConfigError(tomlErr, CONFIG_PATH);
    expect(msg).toContain("Invalid TOML");
    expect(msg).toContain(CONFIG_PATH);
    expect(msg).not.toContain("\n");
  });

  test("isConfigParseError is true for a ZodError and false for ENOENT", () => {
    const zodResult = AgentSyncConfigSchema.safeParse({});
    expect(zodResult.success).toBe(false);
    if (!zodResult.success) {
      expect(isConfigParseError(zodResult.error)).toBeTrue();
    }
    const enoent = Object.assign(new Error("no file"), { code: "ENOENT" });
    expect(isConfigParseError(enoent)).toBeFalse();
  });

  test("falls back to a single generic line for non-config errors", () => {
    expect(formatConfigError(new Error("disk full"), CONFIG_PATH)).toBe(
      `Failed to load config ${CONFIG_PATH}: disk full`,
    );
  });
});
