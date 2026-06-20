/**
 * Tests for the durable daemon-state module: the pure success/failure
 * transitions (including the stuck latch on divergence), the duration
 * formatter, and the read/write round-trip with degrade-to-empty on a corrupt
 * file. No daemon process is started — the transitions are pure functions.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  applyFailure,
  applySuccess,
  type DaemonState,
  EMPTY_DAEMON_STATE,
  formatAge,
  isDivergence,
  readDaemonState,
  writeDaemonState,
} from "../state";

{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: deliberate alias to bypass mock cache
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => ({ ...realFsPromises, default: realFsPromises }));
}

const NOW = "2026-06-20T00:00:00.000Z";

describe("daemon state transitions", () => {
  test("isDivergence matches the GitReconciliationError divergence message", () => {
    expect(isDivergence("Vault history diverged from 'origin/main'.")).toBe(true);
    expect(isDivergence("network timeout")).toBe(false);
  });

  test("applySuccess clears failures and the stuck flag", () => {
    const stuck: DaemonState = { ...EMPTY_DAEMON_STATE, consecutiveFailures: 3, stuck: true };
    const next = applySuccess(stuck, NOW);
    expect(next.lastSuccessAt).toBe(NOW);
    expect(next.consecutiveFailures).toBe(0);
    expect(next.lastError).toBeNull();
    expect(next.stuck).toBe(false);
  });

  test("applyFailure bumps the counter and latches stuck on divergence", () => {
    const once = applyFailure(EMPTY_DAEMON_STATE, "push", "Vault history diverged", NOW);
    expect(once.consecutiveFailures).toBe(1);
    expect(once.lastError).toBe("[push] Vault history diverged");
    expect(once.stuck).toBe(true);

    // A later non-divergence failure keeps stuck latched until a success.
    const again = applyFailure(once, "push", "network timeout", NOW);
    expect(again.consecutiveFailures).toBe(2);
    expect(again.stuck).toBe(true);
  });

  test("applyFailure on a transient error does not set stuck", () => {
    const next = applyFailure(EMPTY_DAEMON_STATE, "push", "network timeout", NOW);
    expect(next.stuck).toBe(false);
  });

  test("formatAge renders coarse durations", () => {
    expect(formatAge(5_000)).toBe("5s");
    expect(formatAge(5 * 60_000)).toBe("5m");
    expect(formatAge(3 * 3_600_000)).toBe("3h");
    expect(formatAge(2 * 86_400_000)).toBe("2d");
    expect(formatAge(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});

describe("daemon state persistence", () => {
  let tmpDir: string;
  let savedDir: string | undefined;

  beforeEach(() => {
    tmpDir = join(
      process.cwd(),
      ".agentsync-test-tmp",
      `daemon-state-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    savedDir = process.env.AGENTSYNC_DIR;
    process.env.AGENTSYNC_DIR = tmpDir;
  });

  afterEach(async () => {
    if (savedDir === undefined) delete process.env.AGENTSYNC_DIR;
    else process.env.AGENTSYNC_DIR = savedDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("round-trips a written state", async () => {
    const state: DaemonState = {
      pid: 1234,
      startedAt: NOW,
      lastSuccessAt: NOW,
      lastErrorAt: null,
      lastError: null,
      consecutiveFailures: 0,
      stuck: false,
    };
    await writeDaemonState(state);
    expect(await readDaemonState()).toEqual(state);
  });

  test("degrades to empty state on a corrupt file", async () => {
    writeFileSync(join(tmpDir, "daemon-state.json"), "{ not json", "utf8");
    expect(await readDaemonState()).toEqual(EMPTY_DAEMON_STATE);
  });

  test("returns empty state when no file exists", async () => {
    expect(await readDaemonState()).toEqual(EMPTY_DAEMON_STATE);
  });
});
