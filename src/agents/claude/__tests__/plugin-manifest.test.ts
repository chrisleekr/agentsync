import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../../test-helpers/fixtures";
import { buildPluginManifest, parsePluginManifest, serializeManifest } from "../plugin-manifest";

/** Write the two upstream plugin state files into a fixture plugins dir. */
async function seedPluginsDir(
  dir: string,
  installed: unknown,
  marketplaces: unknown | undefined,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "installed_plugins.json"), JSON.stringify(installed), "utf8");
  if (marketplaces !== undefined) {
    await writeFile(join(dir, "known_marketplaces.json"), JSON.stringify(marketplaces), "utf8");
  }
}

const INSTALLED = {
  version: 2,
  plugins: {
    "pr-review-toolkit@claude-plugins-official": [
      {
        scope: "user",
        installPath: "/Users/someone/.claude/plugins/cache/x/pr-review-toolkit/unknown",
        version: "unknown",
      },
    ],
    "context-mode@context-mode": [{ scope: "user", installPath: "/abs/path", version: "1.0.0" }],
  },
  enabledPlugins: {
    "context-mode@context-mode": true,
  },
};

const MARKETPLACES = {
  "claude-plugins-official": {
    source: { source: "github", repo: "anthropics/claude-plugins-official" },
    installLocation: "/Users/someone/.claude/plugins/marketplaces/claude-plugins-official",
    lastUpdated: "2026-06-06T01:49:52.179Z",
  },
  "context-mode": {
    source: { source: "github", repo: "mksglu/context-mode" },
    installLocation: "/abs/marketplaces/context-mode",
    lastUpdated: "2026-05-21T22:22:16.240Z",
  },
};

describe("buildPluginManifest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("distills installed + known_marketplaces into name@marketplace records", async () => {
    const dir = join(tmpDir, "plugins");
    await seedPluginsDir(dir, INSTALLED, MARKETPLACES);

    const built = await buildPluginManifest(dir);
    expect(built).not.toBeNull();
    const m = built?.manifest;

    expect(m?.marketplaces).toEqual([
      { name: "claude-plugins-official", source: "anthropics/claude-plugins-official" },
      { name: "context-mode", source: "mksglu/context-mode" },
    ]);
    // enabled comes from enabledPlugins; absent → false. Scope from the entry.
    expect(m?.plugins).toContainEqual({
      name: "pr-review-toolkit",
      marketplace: "claude-plugins-official",
      scope: "user",
      enabled: false,
    });
    expect(m?.plugins).toContainEqual({
      name: "context-mode",
      marketplace: "context-mode",
      scope: "user",
      enabled: true,
    });
  });

  test("drops machine-specific absolute paths — no installPath / installLocation leaks", async () => {
    const dir = join(tmpDir, "plugins");
    await seedPluginsDir(dir, INSTALLED, MARKETPLACES);
    const built = await buildPluginManifest(dir);
    const serialized = serializeManifest(built?.manifest ?? { marketplaces: [], plugins: [] });
    expect(serialized).not.toContain("installPath");
    expect(serialized).not.toContain("installLocation");
    expect(serialized).not.toContain("/Users/someone");
    expect(serialized).not.toContain("/abs/");
  });

  test("returns null when installed_plugins.json is absent (nothing to back up)", async () => {
    const dir = join(tmpDir, "plugins");
    await mkdir(dir, { recursive: true });
    expect(await buildPluginManifest(dir)).toBeNull();
  });

  test("tolerates a missing known_marketplaces.json — no marketplaces, plugins still listed", async () => {
    const dir = join(tmpDir, "plugins");
    await seedPluginsDir(dir, INSTALLED, undefined);
    const built = await buildPluginManifest(dir);
    expect(built?.manifest.marketplaces).toEqual([]);
    expect(built?.manifest.plugins.length).toBe(2);
  });

  test("throws when installed_plugins.json is present but not valid JSON", async () => {
    const dir = join(tmpDir, "plugins");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "installed_plugins.json"), "{not json", "utf8");
    expect(buildPluginManifest(dir)).rejects.toThrow();
  });

  test("clamps an unknown install scope to user", async () => {
    const dir = join(tmpDir, "plugins");
    await seedPluginsDir(
      dir,
      {
        version: 2,
        plugins: { "p@m": [{ scope: "--evil", installPath: "/x" }] },
        enabledPlugins: {},
      },
      { m: { source: { source: "github", repo: "o/r" } } },
    );
    const built = await buildPluginManifest(dir);
    expect(built?.manifest.plugins).toEqual([
      { name: "p", marketplace: "m", scope: "user", enabled: false },
    ]);
  });

  test("warns and skips a marketplace whose source shape is unrecognized", async () => {
    const dir = join(tmpDir, "plugins");
    await seedPluginsDir(dir, INSTALLED, {
      weird: { source: { source: "carrier-pigeon" } },
      "context-mode": { source: { source: "github", repo: "mksglu/context-mode" } },
    });
    const built = await buildPluginManifest(dir);
    expect(built?.manifest.marketplaces).toEqual([
      { name: "context-mode", source: "mksglu/context-mode" },
    ]);
    expect(built?.warnings.some((w) => w.includes("weird"))).toBeTrue();
  });
});

describe("parsePluginManifest", () => {
  test("round-trips a serialized manifest", () => {
    const manifest = {
      marketplaces: [{ name: "mkt", source: "owner/repo" }],
      plugins: [{ name: "p", marketplace: "mkt", scope: "user", enabled: true }],
    };
    const parsed = parsePluginManifest(serializeManifest(manifest));
    expect(parsed).toEqual(manifest);
  });

  test("rejects a manifest with a path-traversal plugin name", () => {
    const raw = JSON.stringify({
      marketplaces: [],
      plugins: [{ name: "../evil", marketplace: "mkt", scope: "user", enabled: true }],
    });
    expect(() => parsePluginManifest(raw)).toThrow();
  });

  test("rejects a structurally invalid manifest", () => {
    expect(() => parsePluginManifest(JSON.stringify({ marketplaces: "nope" }))).toThrow();
  });

  test("rejects a leading-dash marketplace source (argv flag-injection)", () => {
    const raw = JSON.stringify({
      marketplaces: [{ name: "mkt", source: "--config=evil" }],
      plugins: [],
    });
    expect(() => parsePluginManifest(raw)).toThrow();
  });

  test("rejects a leading-dash plugin scope (argv flag-injection)", () => {
    const raw = JSON.stringify({
      marketplaces: [],
      plugins: [{ name: "p", marketplace: "mkt", scope: "--evil", enabled: true }],
    });
    expect(() => parsePluginManifest(raw)).toThrow();
  });
});
