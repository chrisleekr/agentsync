import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";

// node:fs/promises is mocked so getUpdateStatus's 24h cache stays in memory
// and never touches the real ~/.config/agentsync directory. The real module
// is spread in (so unrelated exports survive) and re-installed in afterAll so
// the override does not bleed into other test files. The version-check module
// itself is deliberately NOT mocked — mocking an internal module that many
// files import bleeds unpredictably across the shared test process.
const realFsPromises = createRequire(import.meta.url)(
  "node:fs/promises",
) as typeof import("node:fs/promises");

let cacheJson: string | null = null;
mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  readFile: async () => {
    if (cacheJson === null) throw new Error("ENOENT");
    return cacheJson;
  },
  writeFile: async (_path: string, data: string) => {
    cacheJson = data;
  },
  mkdir: async () => undefined,
}));

const { performUpgrade, upgradeInstructions, upgradeCommand } = await import("../upgrade");

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  cacheJson = null;
  process.exitCode = 0;
});
afterAll(() => mock.module("node:fs/promises", () => realFsPromises));

function fetchReturning(tag: string): void {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ tag_name: tag }), { status: 200 }),
  ) as unknown as typeof fetch;
}
function fetchFailing(): void {
  globalThis.fetch = mock(async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
}

function runUpgrade(check: boolean): Promise<void> {
  return upgradeCommand.run?.({ args: { check } } as never) as Promise<void>;
}

describe("upgradeInstructions", () => {
  test("standalone points at the releases page and SHA256SUMS", () => {
    const msg = upgradeInstructions("standalone", "0.2.0");
    expect(msg).toContain("releases");
    expect(msg).toContain("SHA256SUMS");
  });
  test("bunx tells the user to re-run the command", () => {
    expect(upgradeInstructions("bunx", "0.2.0")).toContain("re-run");
  });
  test("dev tells the user to git pull", () => {
    expect(upgradeInstructions("dev", "0.2.0")).toContain("git pull");
  });
});

describe("performUpgrade", () => {
  test("does nothing when no update is available", async () => {
    const result = await performUpgrade({
      current: "0.1.8",
      latest: "0.1.8",
      updateAvailable: false,
      method: "npm-global",
    });
    expect(result.upgraded).toBe(false);
    expect(result.message).toContain("latest");
  });

  // The npm-global install path spawns `bun install -g` and is left to
  // integration coverage; here we assert a standalone install is never
  // installed in place — it can only return instructions.
  test("a standalone install returns instructions and never installs", async () => {
    const result = await performUpgrade({
      current: "0.1.8",
      latest: "0.2.0",
      updateAvailable: true,
      method: "standalone",
    });
    expect(result.upgraded).toBe(false);
    expect(result.message).toContain("SHA256SUMS");
  });
});

describe("upgrade command", () => {
  test("warns and sets a failure exit code when GitHub is unreachable", async () => {
    fetchFailing();
    await runUpgrade(false);
    expect(process.exitCode).toBe(1);
  });

  test("reports success and no failure code when already on the latest version", async () => {
    // An older published tag than the running version means no update.
    fetchReturning("v0.0.1");
    await runUpgrade(false);
    expect(process.exitCode).toBe(0);
  });

  test("--check reports an available update without installing it", async () => {
    fetchReturning("v9999.0.0");
    await runUpgrade(true);
    expect(process.exitCode).toBe(0);
  });

  test("an available update on a non-installable method yields instructions", async () => {
    // The test process is not an npm-global install, so performUpgrade takes
    // the instructions branch — no `bun install -g` is ever spawned.
    fetchReturning("v9999.0.0");
    await runUpgrade(false);
    expect(process.exitCode).toBe(0);
  });
});
