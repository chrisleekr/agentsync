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

    // Flush microtask so fn is called and resolveFirst is assigned
    await Promise.resolve();
    // First is still pending (its inner promise hasn't resolved)
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

    // Flush microtask so fn is called and resolveFirst is assigned
    await Promise.resolve();

    // First is still pending — second must not have started
    expect(secondStarted).toBe(false);

    resolveFirst();
    await first;

    // Now second should have run
    await new Promise((r) => setTimeout(r, 0));
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

    // Flush microtask so fn is called and resolveFirst is assigned
    await Promise.resolve();
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

  // Multiple (3+) operations all run in order
  test("three enqueued operations all run in declared order", async () => {
    const q = new SyncQueue();
    const order: number[] = [];

    const p1 = q.enqueue(async () => {
      order.push(1);
    });
    const p2 = q.enqueue(async () => {
      order.push(2);
    });
    const p3 = q.enqueue(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  // Mixed success/failure: all operations still run
  test("mixed success/failure sequence runs all operations to completion", async () => {
    const q = new SyncQueue();
    const ran: string[] = [];

    const p1 = q.enqueue(async () => {
      ran.push("ok");
    });
    const p2 = q.enqueue(async () => {
      ran.push("fail");
      throw new Error("transient");
    });
    const p3 = q.enqueue(async () => {
      ran.push("ok2");
    });

    await p1;
    await expect(p2).rejects.toThrow("transient");
    await p3;

    expect(ran).toEqual(["ok", "fail", "ok2"]);
  });

  // whenIdle() called on a brand-new queue resolves immediately
  test("whenIdle() on a fresh queue resolves without delay", async () => {
    const q = new SyncQueue();
    let resolved = false;
    q.whenIdle().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  // Calling whenIdle() twice returns independent promises that both resolve
  test("calling whenIdle() multiple times returns independently resolvable promises", async () => {
    const q = new SyncQueue();
    let count = 0;

    q.enqueue(async () => {
      count++;
    });

    const idle1 = q.whenIdle();
    const idle2 = q.whenIdle();

    await Promise.all([idle1, idle2]);
    expect(count).toBe(1);
  });

  // Regression: enqueue after whenIdle still runs correctly
  test("enqueue after whenIdle has resolved still executes the new operation", async () => {
    const q = new SyncQueue();

    await q.enqueue(async () => {});
    await q.whenIdle();

    // Enqueue again after idle
    const result = await q.enqueue(async () => "late");
    expect(result).toBe("late");
  });
});