import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import type { UpdateStatus } from "../../core/version-check";

// getUpdateStatus is stubbed so the upgrade command's orchestration runs
// without a network call. The real module is spread in (keeping
// detectInstallMethod and the rest genuine) and re-installed in afterAll so
// the stub does not bleed into other test files.
const versionCheckSpecifier = "../../core/version-check";
const realVersionCheck = createRequire(import.meta.url)(
  versionCheckSpecifier,
) as typeof import("../../core/version-check");

let stubStatus: UpdateStatus = {
  current: "0.1.8",
  latest: null,
  updateAvailable: false,
  method: "npm-global",
};
mock.module(versionCheckSpecifier, () => ({
  ...realVersionCheck,
  getUpdateStatus: async () => stubStatus,
}));

const { performUpgrade, upgradeInstructions, upgradeCommand } = await import("../upgrade");

afterEach(() => {
  process.exitCode = 0;
});
afterAll(() => mock.module(versionCheckSpecifier, () => realVersionCheck));

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
    stubStatus = { current: "0.1.8", latest: null, updateAvailable: false, method: "npm-global" };
    await runUpgrade(false);
    expect(process.exitCode).toBe(1);
  });

  test("reports success and no failure code when already on the latest version", async () => {
    stubStatus = {
      current: "0.1.8",
      latest: "0.1.8",
      updateAvailable: false,
      method: "npm-global",
    };
    await runUpgrade(false);
    expect(process.exitCode).toBe(0);
  });

  test("--check reports an available update without installing it", async () => {
    stubStatus = { current: "0.1.8", latest: "0.2.0", updateAvailable: true, method: "standalone" };
    await runUpgrade(true);
    expect(process.exitCode).toBe(0);
  });

  test("a standalone install is handed instructions, never installed in place", async () => {
    stubStatus = { current: "0.1.8", latest: "0.2.0", updateAvailable: true, method: "standalone" };
    await runUpgrade(false);
    expect(process.exitCode).toBe(0);
  });
});
