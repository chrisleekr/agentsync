import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";
import { Watcher } from "../watcher";

// Defensive re-install of the real node:fs/promises — see migrate.test.ts
// for the full explanation of the bleed this guards against.
{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

// Poll for an event-driven condition instead of a fixed sleep — fs.watch on
// macOS (FSEvents) batches with non-deterministic latency, so positive
// assertions need to await callback arrival rather than assume a budget.
async function waitFor(condition: () => boolean, maxMs = 2000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > maxMs) {
      throw new Error(`waitFor: condition not met within ${maxMs}ms`);
    }
    await Bun.sleep(stepMs);
  }
}

// Watcher debounce and lifecycle

describe("Watcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // debounce collapses rapid writes into one callback
  test("callback fires exactly once for rapid writes within the debounce window", async () => {
    const watcher = new Watcher();
    const fired: string[] = [];
    const filePath = join(tmpDir, "debounce.txt");

    watcher.add(tmpDir, 100, (p) => void fired.push(p));

    // Write 5 times inside the 100 ms window
    for (let i = 0; i < 5; i++) {
      await writeFile(filePath, `write-${i}`, "utf8");
    }

    // Await the actual callback rather than a fixed sleep — FSEvents latency
    // can exceed any fixed budget under full-suite I/O contention.
    await waitFor(() => fired.length >= 1);
    // Give any spurious extras a chance to land before snapshotting.
    await Bun.sleep(150);
    watcher.close();

    // Debounce must collapse all writes into exactly one callback
    expect(fired.length).toBe(1);
  });

  // remove stops callbacks for that path
  test("Watcher.remove stops callbacks; subsequent writes do not fire", async () => {
    const watcher = new Watcher();
    let fireCount = 0;
    const filePath = join(tmpDir, "removable.txt");

    watcher.add(tmpDir, 50, () => {
      fireCount++;
    });

    // First write — must observe the callback before snapshotting, otherwise
    // the negative assertion can pass for the wrong reason on slow event delivery.
    await writeFile(filePath, "initial", "utf8");
    await waitFor(() => fireCount >= 1);
    const beforeRemove = fireCount;

    watcher.remove(tmpDir);

    // Write after remove — must NOT trigger. Use a wider margin than the
    // original 150 ms so FSEvents latency can't masquerade as a quiet watcher.
    await writeFile(filePath, "after-remove", "utf8");
    await Bun.sleep(300);

    expect(fireCount).toBe(beforeRemove); // no new events
  });

  // close stops all watchers
  test("Watcher.close stops all watchers; writes after close invoke no callbacks", async () => {
    const watcher = new Watcher();
    let fireCount = 0;
    const warmupPath = join(tmpDir, "warmup.txt");
    const filePath = join(tmpDir, "post-close.txt");

    watcher.add(tmpDir, 50, () => {
      fireCount++;
    });

    // Warm-up write proves the watcher is live before we close it; without
    // this, a slow FSEvents subscribe could let a pre-close event leak past.
    await writeFile(warmupPath, "warmup", "utf8");
    await waitFor(() => fireCount >= 1);
    const beforeClose = fireCount;

    watcher.close();

    await writeFile(filePath, "after-close", "utf8");
    await Bun.sleep(300);

    expect(fireCount).toBe(beforeClose);
  });
});
