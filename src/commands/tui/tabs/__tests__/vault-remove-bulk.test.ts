/**
 * Tests for runBulkVaultRemove — the TUI bulk-remove runner. The real
 * performVaultRemove core (git + fs) is mocked here so we exercise only the
 * runner's own logic: selection pruning on partial failure, phase reset, and
 * success-vs-error toast keying. The core itself is covered end-to-end in
 * src/commands/__tests__/vault-remove.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the core BEFORE the helper module is imported so its static
// `import { performVaultRemove } from "../../vault-remove"` resolves to this
// stub. Paths ending in ".fail" report a git-error; everything else succeeds.
mock.module("../../../vault-remove", () => ({
  performVaultRemove: async ({ vaultRelPath }: { vaultRelPath: string }) =>
    vaultRelPath.endsWith(".fail")
      ? { status: "git-error", path: vaultRelPath, error: "boom" }
      : { status: "success", path: vaultRelPath, commitSha: "abc1234" },
}));

type HelperMod = typeof import("../_vault-remove");
type StoreMod = typeof import("../../store");
type StateMod = typeof import("../../state");

let helper: HelperMod;
let createStore: StoreMod["createStore"];
let createInitialState: StateMod["createInitialState"];

beforeAll(async () => {
  helper = await import("../_vault-remove");
  ({ createStore } = await import("../../store"));
  ({ createInitialState } = await import("../../state"));
});

afterAll(() => {
  mock.restore();
});

function seedSelection(paths: string[]) {
  const store = createStore(createInitialState());
  store.dispatch((d) => {
    for (const p of paths) d.selection.add(p);
    d.sync.phase = "ready";
  });
  return store;
}

async function waitForToast(store: ReturnType<typeof createStore>) {
  for (let i = 0; i < 300; i++) {
    if ((store.getState().toast?.text ?? "").startsWith("Removed")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("runBulkVaultRemove", () => {
  beforeEach(() => {
    // createStore/createInitialState are bound in beforeAll; nothing per-test.
  });

  test("all success — prunes every path from selection, resets phase, success toast", async () => {
    const store = seedSelection(["a.age", "b.age"]);
    helper.runBulkVaultRemove(store, ["a.age", "b.age"]);
    await waitForToast(store);

    const s = store.getState();
    expect(s.selection.size).toBe(0);
    expect(s.sync.phase).toBe("idle");
    expect(s.toast?.level).toBe("success");
    expect(s.toast?.text).toBe("Removed 2 artifact(s)");
  });

  test("partial failure — keeps the failed path selected, error toast with count", async () => {
    const store = seedSelection(["ok.age", "bad.fail"]);
    helper.runBulkVaultRemove(store, ["ok.age", "bad.fail"]);
    await waitForToast(store);

    const s = store.getState();
    // Only the successful path is dropped; the failed one survives for retry.
    expect(s.selection.has("ok.age")).toBe(false);
    expect(s.selection.has("bad.fail")).toBe(true);
    expect(s.toast?.level).toBe("error");
    expect(s.toast?.text).toContain("1 failed");
  });

  test("empty input is a no-op", () => {
    const store = seedSelection(["keep.age"]);
    helper.runBulkVaultRemove(store, []);
    expect(store.getState().selection.has("keep.age")).toBe(true);
    expect(store.getState().toast).toBeNull();
  });
});
