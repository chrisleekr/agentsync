import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";

// In-memory stand-in for the update-check cache so tests never read or write
// the real ~/.config/agentsync directory. The real module is spread in so
// unrelated exports (readdir, etc.) survive the mock, and re-installed in
// afterAll so the override does not bleed into later test files.
const realFsPromises = createRequire(import.meta.url)(
  "node:fs/promises",
) as typeof import("node:fs/promises");

let cacheJson: string | null = null;
mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  // require() omits the synthesized default export; Linux Bun links named
  // imports through CJS-interop default, so it must be present.
  default: realFsPromises,
  readFile: async () => {
    if (cacheJson === null) throw new Error("ENOENT");
    return cacheJson;
  },
  writeFile: async (_path: string, data: string) => {
    cacheJson = data;
  },
  mkdir: async () => undefined,
}));

const { detectInstallMethod, getUpdateStatus } = await import("../version-check");

const realArgv = process.argv;
const realFetch = globalThis.fetch;

afterEach(() => {
  process.argv = realArgv;
  globalThis.fetch = realFetch;
  cacheJson = null;
});
afterAll(() =>
  mock.module("node:fs/promises", () => ({ ...realFsPromises, default: realFsPromises })),
);

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

describe("detectInstallMethod", () => {
  test("standalone — argv[0] is the compiled binary, not bun", () => {
    process.argv = ["/usr/local/bin/agentsync", "status"];
    expect(detectInstallMethod()).toBe("standalone");
  });
  test("npm-global — bun runs a script inside node_modules", () => {
    process.argv = [
      "/home/u/.bun/bin/bun",
      "/home/u/.bun/install/global/node_modules/@chrisleekr/agentsync/dist/cli.js",
    ];
    expect(detectInstallMethod()).toBe("npm-global");
  });
  test("bunx — script path carries the bunx marker", () => {
    process.argv = [
      "/home/u/.bun/bin/bun",
      "/tmp/bunx-501-agentsync/node_modules/@chrisleekr/agentsync/dist/cli.js",
    ];
    expect(detectInstallMethod()).toBe("bunx");
  });
  test("dev — bun runs source outside node_modules", () => {
    process.argv = ["/home/u/.bun/bin/bun", "/home/u/srv/agentsync/src/cli.ts"];
    expect(detectInstallMethod()).toBe("dev");
  });
});

describe("getUpdateStatus", () => {
  test("flags an update when GitHub has a newer tag", async () => {
    fetchReturning("v9999.0.0");
    const status = await getUpdateStatus({ forceRefresh: true });
    expect(status.latest).toBe("9999.0.0");
    expect(status.updateAvailable).toBe(true);
  });

  test("no update when the latest tag is older than the running version", async () => {
    fetchReturning("v0.0.1");
    const status = await getUpdateStatus({ forceRefresh: true });
    expect(status.latest).toBe("0.0.1");
    expect(status.updateAvailable).toBe(false);
  });

  test("latest is null and no update when GitHub is unreachable", async () => {
    fetchFailing();
    const status = await getUpdateStatus({ forceRefresh: true });
    expect(status.latest).toBeNull();
    expect(status.updateAvailable).toBe(false);
  });

  test("a non-semver release tag is rejected, not crashed on", async () => {
    fetchReturning("nightly-build");
    const status = await getUpdateStatus({ forceRefresh: true });
    expect(status.latest).toBeNull();
    expect(status.updateAvailable).toBe(false);
  });

  test("a fresh cache is reused without a network call", async () => {
    fetchReturning("v9999.0.0");
    await getUpdateStatus({ forceRefresh: true }); // populates the cache
    fetchFailing(); // any network call now would resolve latest to null
    const status = await getUpdateStatus();
    expect(status.latest).toBe("9999.0.0");
    expect(status.updateAvailable).toBe(true);
  });
});
