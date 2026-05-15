import { describe, expect, test } from "bun:test";
import { countRunning, createInitialState } from "../state";
import { createStore } from "../store";

describe("cross-tab visibility", () => {
  test("operation started on Migrate is visible from Dashboard render path without polling", () => {
    const store = createStore(createInitialState());
    store.runOperation("migrate", "apply x→y@global-rules", () => new Promise(() => {}));

    // Simulate a user pressing "1" to switch to dashboard.
    store.dispatch((d) => {
      d.activeTab = "dashboard";
    });

    // Dashboard render path reads countRunning(state) — the running op must be
    // observable right now, not after the next 1.5s poll.
    const running = countRunning(store.getState());
    expect(running).toBe(1);
  });

  test("multiple in-flight operations from different tabs all counted", () => {
    const store = createStore(createInitialState());
    store.runOperation("migrate-preview", "preview", () => new Promise(() => {}));
    store.runOperation("vault-load", "load vault", () => new Promise(() => {}));
    store.runOperation("agents-load", "load agents", () => new Promise(() => {}));
    expect(countRunning(store.getState())).toBe(3);
  });

  test("completed operations stop counting in countRunning", async () => {
    const store = createStore(createInitialState());
    store.runOperation("pull", "pull", async () => ({ ok: true }));
    expect(countRunning(store.getState())).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(countRunning(store.getState())).toBe(0);
  });

  test("migrate preview onSuccess hook updates state.migrate visible cross-tab", async () => {
    const store = createStore(createInitialState());
    store.runOperation(
      "migrate-preview",
      "preview",
      async () => ({ migrated: [], skipped: [], errors: [] }),
      {
        onSuccess: (draft) => {
          draft.migrate.preview = "no-op";
          draft.migrate.previewKey = "claude→cursor@global-rules";
        },
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    // Even if active tab is dashboard, migrate slice is updated.
    store.dispatch((d) => {
      d.activeTab = "dashboard";
    });
    expect(store.getState().migrate.preview).toBe("no-op");
    expect(store.getState().migrate.previewKey).toBe("claude→cursor@global-rules");
  });
});
