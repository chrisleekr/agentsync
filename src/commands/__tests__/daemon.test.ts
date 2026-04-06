/**
 * T004a — Tests for getExecutableArgs() in src/commands/daemon.ts
 *
 * These tests verify:
 * 1. Compiled binary path: returns single-element array with process.execPath
 * 2. Bun + non-ephemeral script: returns [argv[0], argv[1]]
 * 3. Ephemeral (bunx temp) path: throws with actionable install message
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// We test the internal function by re-exporting it. Since getExecutableArgs is not
// currently exported, we import the module and cast to access it for testing.
// The implementation will export it or expose it via the tested module contract.

// Store originals to restore after each test
const originalArgv0 = process.argv[0];
const originalArgv1 = process.argv[1];
const originalExecPath = process.execPath;

// Helper to patch process properties for duration of test
function withArgv(argv0: string, argv1: string, fn: () => void | Promise<void>) {
  return async () => {
    Object.defineProperty(process, "argv", {
      value: [argv0, argv1, ...process.argv.slice(2)],
      writable: true,
      configurable: true,
    });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, "argv", {
        value: [originalArgv0, originalArgv1, ...process.argv.slice(2)],
        writable: true,
        configurable: true,
      });
    }
  };
}

// We test getExecutableArgs by importing it dynamically after patching argv.
// The function must be exported from daemon.ts for these tests to work.
describe("getExecutableArgs", () => {
  test(
    "returns [process.execPath] when argv[0] is not bun",
    withArgv("/usr/local/bin/agentsync", "/irrelevant/path", async () => {
      // Clear module cache to re-evaluate with new argv
      const { getExecutableArgs } = await import("../daemon");
      const result = getExecutableArgs();
      expect(result).toEqual([process.execPath]);
    }),
  );

  test(
    "returns [argv[0], argv[1]] when argv[0] ends with 'bun' and path is non-ephemeral",
    withArgv("/home/user/.bun/bin/bun", "/home/user/.bun/install/global/node_modules/.bin/cli.js", async () => {
      const { getExecutableArgs } = await import("../daemon");
      const result = getExecutableArgs();
      expect(result).toEqual([
        "/home/user/.bun/bin/bun",
        "/home/user/.bun/install/global/node_modules/.bin/cli.js",
      ]);
    }),
  );

  test(
    "throws with install hint when argv[1] contains 'bunx-'",
    withArgv("/home/user/.bun/bin/bun", "/tmp/bunx-501-abc/node_modules/.bin/cli.js", async () => {
      const { getExecutableArgs } = await import("../daemon");
      expect(() => getExecutableArgs()).toThrow("Install the package globally first");
    }),
  );
});
