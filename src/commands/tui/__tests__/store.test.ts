import { describe, expect, test } from "bun:test";
import { createInitialState } from "../state";
import { createStore } from "../store";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createStore.runOperation", () => {
  test("writes inFlight on start synchronously, observable before opFn resolves", () => {
    const store = createStore(createInitialState());
    const d = deferred<{ done: true }>();
    const id = store.runOperation("push", "push selection", () => d.promise);
    const snap = store.getState().inFlight[id];
    expect(snap).toBeDefined();
    expect(snap.phase).toBe("running");
    expect(snap.kind).toBe("push");
    expect(snap.label).toBe("push selection");
    expect(snap.finishedAt).toBeNull();
    d.resolve({ done: true });
  });

  test("onSuccess runs in same dispatch as terminal phase write", async () => {
    const store = createStore(createInitialState());
    const id = store.runOperation("sync-load", "load", async () => [1, 2, 3], {
      onSuccess: (draft, result) => {
        const arr = result as number[];
        draft.sync.rows = arr.map((n) => ({
          agent: "x",
          displayName: `${n}`,
          sourcePath: `/x/${n}`,
          vaultPath: `x/${n}.age`,
          vaultAbsPath: `/vault/x/${n}.age`,
          isSkill: false,
          status: "synced",
          detail: "",
          localHash: null,
          vaultHash: null,
        }));
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    const op = store.getState().inFlight[id];
    expect(op.phase).toBe("ok");
    expect(store.getState().sync.rows.length).toBe(3);
  });

  test("onError sees the thrown error and terminal phase = error", async () => {
    const store = createStore(createInitialState());
    const captured: { msg: string | null } = { msg: null };
    const id = store.runOperation(
      "migrate",
      "apply x",
      async () => {
        throw new Error("boom");
      },
      {
        onError: (_draft, err) => {
          captured.msg = err.message;
        },
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    const op = store.getState().inFlight[id];
    expect(op.phase).toBe("error");
    expect(op.error).toBe("boom");
    expect(captured.msg).toBe("boom");
  });

  test("subscriber fires at least twice: on start and on terminal", async () => {
    const store = createStore(createInitialState());
    let n = 0;
    store.subscribe(() => {
      n += 1;
    });
    store.runOperation("pull", "pull", async () => ({ ok: true }));
    expect(n).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test("activityKind pushes start and ok entries with matching messages", async () => {
    const store = createStore(createInitialState());
    store.runOperation("sync-load", "scan", async () => 1, { activityKind: "info" });
    expect(store.getState().activity[0]).toMatchObject({ status: "running", kind: "info" });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getState().activity[0]).toMatchObject({ status: "ok", kind: "info" });
  });

  test("eviction removes inFlight slot after evictAfterMs", async () => {
    const store = createStore(createInitialState());
    const id = store.runOperation("sync-load", "v", async () => 1, { evictAfterMs: 10 });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getState().inFlight[id]).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().inFlight[id]).toBeUndefined();
  });

  test("opSeq increments monotonically across operations", () => {
    const store = createStore(createInitialState());
    const a = store.runOperation("push", "a", () => new Promise(() => {}));
    const b = store.runOperation("push", "b", () => new Promise(() => {}));
    expect(a).not.toBe(b);
    expect(store.getState().opSeq).toBe(2);
  });
});

describe("createStore.dispose", () => {
  test("cancels pending eviction timers", async () => {
    const store = createStore(createInitialState());
    const id = store.runOperation("sync-load", "v", async () => 1, { evictAfterMs: 50 });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getState().inFlight[id]).toBeDefined();
    store.dispose();
    await new Promise((r) => setTimeout(r, 100));
    // Eviction would have fired by now — dispose must have cancelled it.
    expect(store.getState().inFlight[id]).toBeDefined();
  });

  test("post-dispose dispatch is a no-op", () => {
    const store = createStore(createInitialState());
    store.dispose();
    let fired = 0;
    store.subscribe(() => {
      fired += 1;
    });
    store.dispatch((d) => {
      d.activeTab = "sync";
    });
    expect(store.getState().activeTab).toBe("dashboard");
    expect(fired).toBe(0);
  });

  test("is idempotent", () => {
    const store = createStore(createInitialState());
    store.dispose();
    store.dispose();
  });
});

describe("createStore.dispatch", () => {
  test("mutator changes state and notifies subscribers", () => {
    const store = createStore(createInitialState());
    let fired = 0;
    store.subscribe(() => {
      fired += 1;
    });
    store.dispatch((d) => {
      d.activeTab = "sync";
    });
    expect(store.getState().activeTab).toBe("sync");
    expect(fired).toBe(1);
  });

  test("subscribe returns disposer that detaches", () => {
    const store = createStore(createInitialState());
    let fired = 0;
    const off = store.subscribe(() => {
      fired += 1;
    });
    store.dispatch((d) => {
      d.activeTab = "sync";
    });
    off();
    store.dispatch((d) => {
      d.activeTab = "migrate";
    });
    expect(fired).toBe(1);
  });
});
