import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";
import { Watcher } from "../watcher";

// T033-T035 — Watcher debounce and lifecycle

describe("Watcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // T033 — debounce collapses rapid writes into one callback
  test("callback fires exactly once for rapid writes within the debounce window", async () => {
    const watcher = new Watcher();
    const fired: string[] = [];
    const filePath = join(tmpDir, "debounce.txt");

    watcher.add(tmpDir, 100, (p) => void fired.push(p));

    // Write 5 times inside the 100 ms window
    for (let i = 0; i < 5; i++) {
      await writeFile(filePath, `write-${i}`, "utf8");
    }

    // Wait debounce window + generous buffer
    await Bun.sleep(250);
    watcher.close();

    // Debounce must collapse all writes into exactly one callback
    expect(fired.length).toBe(1);
  });

  // T034 — remove stops callbacks for that path
  test("Watcher.remove stops callbacks; subsequent writes do not fire", async () => {
    const watcher = new Watcher();
    let fireCount = 0;
    const filePath = join(tmpDir, "removable.txt");

    watcher.add(tmpDir, 50, () => {
      fireCount++;
    });

    // First write — should trigger
    await writeFile(filePath, "initial", "utf8");
    await Bun.sleep(150);
    const beforeRemove = fireCount;

    watcher.remove(tmpDir);

    // Write after remove — must NOT trigger
    await writeFile(filePath, "after-remove", "utf8");
    await Bun.sleep(150);

    expect(fireCount).toBe(beforeRemove); // no new events
  });

  // T035 — close stops all watchers
  test("Watcher.close stops all watchers; writes after close invoke no callbacks", async () => {
    const watcher = new Watcher();
    let fireCount = 0;
    const filePath = join(tmpDir, "post-close.txt");

    watcher.add(tmpDir, 50, () => {
      fireCount++;
    });
    await Bun.sleep(50); // let the watcher initialise

    watcher.close();

    await writeFile(filePath, "after-close", "utf8");
    await Bun.sleep(150);

    expect(fireCount).toBe(0);
  });
});
