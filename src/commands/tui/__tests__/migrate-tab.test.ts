import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { AGENTS, createInitialState, MIGRATE_AGENTS, MIGRATE_TYPES } from "../state";
import { createStore } from "../store";
import { onMigrateKey } from "../tabs/migrate";

function key(name: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    sequence: name,
    ctrl: false,
    meta: false,
    shift: false,
    raw: name,
    number: false,
    ...mods,
  } as unknown as KeyEvent;
}

function seedOn(field: "from" | "to" | "type") {
  const store = createStore(createInitialState());
  store.dispatch((d) => {
    d.activeTab = "migrate";
    d.migrate.field = field;
  });
  return store;
}

describe("onMigrateKey — field navigation", () => {
  test("↓ moves between fields exactly like Tab", () => {
    const store = seedOn("from");
    onMigrateKey(key("down"), store);
    expect(store.getState().migrate.field).toBe("to");
    onMigrateKey(key("down"), store);
    expect(store.getState().migrate.field).toBe("type");
  });

  test("↑ moves backwards through fields", () => {
    const store = seedOn("type");
    onMigrateKey(key("up"), store);
    expect(store.getState().migrate.field).toBe("to");
    onMigrateKey(key("up"), store);
    expect(store.getState().migrate.field).toBe("from");
  });
});

describe("onMigrateKey — To: sub-cursor", () => {
  test("→ moves toCursor without toggling toSet", () => {
    const store = seedOn("to");
    const initialSet = new Set(store.getState().migrate.toSet);
    onMigrateKey(key("right"), store);
    expect(store.getState().migrate.toCursor).toBe(1);
    // toSet unchanged
    expect(new Set(store.getState().migrate.toSet)).toEqual(initialSet);
  });

  test("← wraps from 0 to last agent", () => {
    const store = seedOn("to");
    onMigrateKey(key("left"), store);
    expect(store.getState().migrate.toCursor).toBe(MIGRATE_AGENTS.length - 1);
  });

  test("space toggles toSet at toCursor", () => {
    const store = seedOn("to");
    store.dispatch((d) => {
      d.migrate.toCursor = 2; // codex
    });
    const target = AGENTS[2];
    const before = store.getState().migrate.toSet.has(target);
    onMigrateKey(key("space"), store);
    expect(store.getState().migrate.toSet.has(target)).toBe(!before);
    onMigrateKey(key("space"), store);
    expect(store.getState().migrate.toSet.has(target)).toBe(before);
  });

  test("space on To field invalidates a stale preview key", () => {
    const store = seedOn("to");
    store.dispatch((d) => {
      d.migrate.previewKey = "stale";
    });
    onMigrateKey(key("space"), store);
    expect(store.getState().migrate.previewKey).toBeNull();
  });
});

describe("onMigrateKey — Type: multi-select with sub-cursor", () => {
  test("exposes OpenCode in migration and vault agent choices", () => {
    expect(MIGRATE_AGENTS).toContain("opencode");
    expect(AGENTS).toContain("opencode");
  });
  test("C1 and C9 surface agents as a selectable migration type", () => {
    expect(MIGRATE_TYPES).toContain("agents");
    expect(MIGRATE_TYPES.filter((type) => type === "agents")).toHaveLength(1);
  });

  test("default state has one type selected and the cursor at 0", () => {
    const store = seedOn("type");
    expect(store.getState().migrate.typeSet.size).toBe(1);
    expect(store.getState().migrate.typeCursor).toBe(0);
  });

  test("→ moves typeCursor through MIGRATE_TYPES", () => {
    const store = seedOn("type");
    onMigrateKey(key("right"), store);
    expect(store.getState().migrate.typeCursor).toBe(1);
    onMigrateKey(key("right"), store);
    expect(store.getState().migrate.typeCursor).toBe(2);
  });

  test("space toggles typeSet at typeCursor", () => {
    const store = seedOn("type");
    onMigrateKey(key("right"), store); // move to MIGRATE_TYPES[1]
    const target = MIGRATE_TYPES[1];
    onMigrateKey(key("space"), store);
    expect(store.getState().migrate.typeSet.has(target)).toBe(true);
    onMigrateKey(key("space"), store);
    expect(store.getState().migrate.typeSet.has(target)).toBe(false);
  });

  test("typeSet can hold multiple values simultaneously", () => {
    const store = seedOn("type");
    // Add MIGRATE_TYPES[1] alongside the default MIGRATE_TYPES[0].
    onMigrateKey(key("right"), store);
    onMigrateKey(key("space"), store);
    expect(store.getState().migrate.typeSet.size).toBe(2);
  });

  test("C1 toggles the agents type through the same TUI selection path", () => {
    const store = seedOn("type");
    const agentsIndex = MIGRATE_TYPES.indexOf("agents");
    store.dispatch((d) => {
      d.migrate.typeCursor = agentsIndex;
    });
    onMigrateKey(key("space"), store);
    expect(store.getState().migrate.typeSet.has("agents")).toBe(true);
  });
});

describe("onMigrateKey — Preview ↔ Apply navigation", () => {
  test("→ on Preview field switches to Apply", () => {
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.activeTab = "migrate";
      d.migrate.field = "preview";
    });
    onMigrateKey(key("right"), store);
    expect(store.getState().migrate.field).toBe("apply");
  });

  test("← on Apply field switches back to Preview", () => {
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.activeTab = "migrate";
      d.migrate.field = "apply";
    });
    onMigrateKey(key("left"), store);
    expect(store.getState().migrate.field).toBe("preview");
  });

  test("← on Preview is a no-op (no field to the left on that row)", () => {
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.activeTab = "migrate";
      d.migrate.field = "preview";
    });
    const consumed = onMigrateKey(key("left"), store);
    expect(consumed).toBe(true);
    expect(store.getState().migrate.field).toBe("preview");
  });

  test("→ on Apply is a no-op (no field to the right on that row)", () => {
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.activeTab = "migrate";
      d.migrate.field = "apply";
    });
    const consumed = onMigrateKey(key("right"), store);
    expect(consumed).toBe(true);
    expect(store.getState().migrate.field).toBe("apply");
  });
});

describe("snapshotMigrateSelection — async isolation", () => {
  test("captured snapshot is independent of subsequent state mutations", async () => {
    const { snapshotMigrateSelection } = await import("../tabs/migrate");
    const store = createStore(createInitialState());
    store.dispatch((d) => {
      d.migrate.from = "claude";
      d.migrate.toSet = new Set(["cursor"]);
      d.migrate.typeSet = new Set(["mcp"]);
    });
    const snap = snapshotMigrateSelection(store.getState().migrate);
    // Mid-flight mutation — the user toggles another agent before the
    // operation reads the snapshot.
    store.dispatch((d) => {
      d.migrate.toSet.add("codex");
      d.migrate.typeSet.add("commands");
    });
    // Without the snapshot copy this would observe `codex` and `commands`.
    expect(snap.toSet.has("codex")).toBe(false);
    expect(snap.toSet.has("cursor")).toBe(true);
    expect(snap.typeSet.has("commands")).toBe(false);
    expect(snap.typeSet.has("mcp")).toBe(true);
  });
});
