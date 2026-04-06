import { describe, expect, test } from "bun:test";
import { SyncQueue } from "../sync-queue";

describe("SyncQueue", () => {
  // T013 — two enqueued operations run serially
  test("two enqueued operations run serially — second starts only after first resolves", async () => {
    const q = new SyncQueue();
    const order: number[] = [];

    let resolveFirst!: () => void;
    const first = q.enqueue(
      () =>
        new Promise<void>((res) => {
          resolveFirst = () => {
            order.push(1);
            res();
          };
        }),
    );

    const second = q.enqueue(async () => {
      order.push(2);
    });

    // At this point neither has completed — first is still pending
    expect(order).toEqual([]);

    resolveFirst();
    await first;
    await second;

    expect(order).toEqual([1, 2]);
  });

  // T013 — serialisation: second does not start while first is running
  test("second operation does not start while first is in progress", async () => {
    const q = new SyncQueue();
    let secondStarted = false;

    let resolveFirst!: () => void;
    const first = q.enqueue(
      () =>
        new Promise<void>((res) => {
          resolveFirst = res;
        }),
    );

    q.enqueue(async () => {
      secondStarted = true;
    });

    // First is still pending — second must not have started
    expect(secondStarted).toBe(false);

    resolveFirst();
    await first;

    // Now second should have run
    await new Promise((r) => setTimeout(r, 0)); // flush microtasks
    expect(secondStarted).toBe(true);
  });

  // T014 — whenIdle resolves only after all enqueued work settles
  test("whenIdle() resolves only after all enqueued work settles", async () => {
    const q = new SyncQueue();
    const results: number[] = [];

    let resolveFirst!: () => void;
    q.enqueue(
      () =>
        new Promise<void>((res) => {
          resolveFirst = res;
        }),
    );

    q.enqueue(async () => {
      results.push(1);
    });

    const idle = q.whenIdle();

    // idle must not be resolved yet
    let idleResolved = false;
    idle.then(() => {
      idleResolved = true;
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(idleResolved).toBe(false);

    resolveFirst();
    await idle;

    expect(idleResolved).toBe(true);
    expect(results).toEqual([1]);
  });

  // T014 — whenIdle resolves immediately when queue is empty
  test("whenIdle() resolves immediately when the queue is idle", async () => {
    const q = new SyncQueue();
    await expect(q.whenIdle()).resolves.toBeUndefined();
  });

  // enqueue returns the value from fn
  test("enqueue returns the resolved value of fn", async () => {
    const q = new SyncQueue();
    const result = await q.enqueue(async () => 42);
    expect(result).toBe(42);
  });

  // failed operation does not block subsequent enqueued work
  test("a failed operation does not block subsequent enqueued work", async () => {
    const q = new SyncQueue();
    let secondRan = false;

    const first = q.enqueue(async () => {
      throw new Error("boom");
    });

    const second = q.enqueue(async () => {
      secondRan = true;
    });

    await expect(first).rejects.toThrow("boom");
    await second;
    expect(secondRan).toBe(true);
  });
});
