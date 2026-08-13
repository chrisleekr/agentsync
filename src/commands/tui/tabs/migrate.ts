import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { performMigrateTargets } from "../../../migrate/migrate";
import type { MigrateResult } from "../../../migrate/types";
import {
  AGENTS,
  type AgentName,
  type AppState,
  type ConfigType,
  MIGRATE_TYPES,
  type MigrateField,
  migrateSignature,
  setToast,
} from "../state";
import type { Store } from "../store";

const FIELDS: MigrateField[] = ["from", "to", "type", "preview", "apply"];

export function renderMigrate(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
  const m = state.migrate;
  const wrapper = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    backgroundColor: "#11151a",
  });
  host.add(wrapper);

  const focusMark = (f: MigrateField) => (m.field === f ? "▶" : " ");
  const radio = (sel: boolean) => (sel ? "(●)" : "( )");
  const check = (sel: boolean) => (sel ? "[x]" : "[ ]");
  // For multi-select fields the sub-cursor is highlighted with a chevron
  // so the user can see which option arrow keys + space will affect.
  const subMark = (active: boolean, focused: boolean) =>
    active && focused ? "›" : active ? " " : " ";

  const fromRow = `${focusMark("from")}  From:  ${AGENTS.map((a) => `${subMark(m.field === "from", a === m.from)}${radio(a === m.from)} ${a}`).join("  ")}`;
  const toRow = `${focusMark("to")}  To:    ${AGENTS.map((a, i) => `${subMark(m.field === "to", i === m.toCursor)}${check(m.toSet.has(a))} ${a}`).join("  ")}`;
  const typeRow = `${focusMark("type")}  Type:  ${MIGRATE_TYPES.map((t, i) => `${subMark(m.field === "type", i === m.typeCursor)}${check(m.typeSet.has(t))} ${t}`).join("  ")}`;

  const sig = migrateSignature(m);
  const previewRunning = anyOp(state, "migrate-preview", "running");
  const applyRunning = anyOp(state, "migrate", "running");
  const previewIsValid = m.previewKey === sig && !previewRunning;

  const previewLabel = previewRunning
    ? "[ Preview… ]"
    : previewIsValid
      ? "[ Preview ✓ ]"
      : "[ Preview ]";
  const applyLabel = applyRunning
    ? "[ Apply… ]"
    : previewIsValid
      ? "[ Apply ]"
      : "[ Apply (preview first) ]";

  const formText = [
    "",
    fromRow,
    "",
    toRow,
    "",
    typeRow,
    "",
    `${focusMark("preview")}  ${previewLabel}        ${focusMark("apply")}  ${applyLabel}`,
    "",
    "  Tab / ↑↓ move between fields. ←/→ move sub-cursor on To & Type,",
    "  and switch between Preview / Apply. Space toggles the focused option.",
    "  Enter activates Preview / Apply.",
  ].join("\n");

  const formBox = new BoxRenderable(renderer, {
    height: 15,
    width: "100%",
    border: true,
    borderColor: "#3b4252",
    borderStyle: "single",
    title: " Migrate ",
    backgroundColor: "#11151a",
  });
  formBox.add(
    new TextRenderable(renderer, {
      content: formText,
      fg: "#d8dee9",
      bg: "#11151a",
    }),
  );
  wrapper.add(formBox);

  const previewBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: "#3b4252",
    borderStyle: "single",
    title: " Preview ",
    backgroundColor: "#11151a",
  });
  previewBox.add(
    new TextRenderable(renderer, {
      content: m.preview || "  (no preview yet — press P or Tab to the Preview button and Enter)",
      fg: previewIsValid ? "#a3be8c" : "#6c7886",
      bg: "#11151a",
    }),
  );
  wrapper.add(previewBox);
}

export function onMigrateKey(key: KeyEvent, store: Store): boolean {
  const state = store.getState();
  const m = state.migrate;

  if (key.name === "tab") {
    store.dispatch((d) => {
      const i = FIELDS.indexOf(d.migrate.field);
      d.migrate.field = FIELDS[(i + (key.shift ? -1 : 1) + FIELDS.length) % FIELDS.length];
    });
    return true;
  }

  // Arrow up/down move between fields exactly like tab/shift-tab. Most users
  // reach for ↑/↓ first in a form; not binding them was a discoverability
  // bug — Tab still works for power users.
  if (key.name === "down") {
    store.dispatch((d) => {
      const i = FIELDS.indexOf(d.migrate.field);
      d.migrate.field = FIELDS[(i + 1) % FIELDS.length];
    });
    return true;
  }
  if (key.name === "up") {
    store.dispatch((d) => {
      const i = FIELDS.indexOf(d.migrate.field);
      d.migrate.field = FIELDS[(i - 1 + FIELDS.length) % FIELDS.length];
    });
    return true;
  }

  if (key.name === "left" || key.name === "right") {
    return moveSubCursorOrCycle(store, key.name === "right");
  }

  if (key.name === "space" && (m.field === "to" || m.field === "type")) {
    return toggleAtSubCursor(store);
  }

  if (key.name === "return") {
    if (m.field === "preview") {
      runPreview(store);
      return true;
    }
    if (m.field === "apply") {
      runApply(store);
      return true;
    }
  }

  if (key.shift && key.name === "p") {
    runPreview(store);
    return true;
  }
  if (key.shift && key.name === "a") {
    runApply(store);
    return true;
  }
  return false;
}

/**
 * On single-select fields (`from`), arrow keys cycle the value directly.
 * On multi-select fields (`to`, `type`) they move the sub-cursor inside
 * the field — space toggles the option at the cursor. This separation is
 * what HTML form controls do and is what the user expects.
 *
 * Preview and Apply share a visual row, so ←/→ also walks between them.
 * That preserves the spatial layout: pressing right from Preview lands
 * on Apply, which is literally the next button to its right.
 */
function moveSubCursorOrCycle(store: Store, forward: boolean): boolean {
  const m = store.getState().migrate;
  switch (m.field) {
    case "from": {
      store.dispatch((d) => {
        const i = AGENTS.indexOf(d.migrate.from);
        d.migrate.from = AGENTS[(i + (forward ? 1 : -1) + AGENTS.length) % AGENTS.length];
        d.migrate.previewKey = null;
      });
      return true;
    }
    case "to": {
      store.dispatch((d) => {
        d.migrate.toCursor =
          (d.migrate.toCursor + (forward ? 1 : -1) + AGENTS.length) % AGENTS.length;
      });
      return true;
    }
    case "type": {
      store.dispatch((d) => {
        d.migrate.typeCursor =
          (d.migrate.typeCursor + (forward ? 1 : -1) + MIGRATE_TYPES.length) % MIGRATE_TYPES.length;
      });
      return true;
    }
    case "preview": {
      if (forward) {
        store.dispatch((d) => {
          d.migrate.field = "apply";
        });
      }
      return true;
    }
    case "apply": {
      if (!forward) {
        store.dispatch((d) => {
          d.migrate.field = "preview";
        });
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Toggle the option at the sub-cursor for the active multi-select field.
 * Clears the preview cache because changing the set invalidates any prior
 * preview keyed by `migrateSignature`.
 */
function toggleAtSubCursor(store: Store): boolean {
  const m = store.getState().migrate;
  if (m.field === "to") {
    const target = AGENTS[m.toCursor];
    if (!target) return true;
    store.dispatch((d) => {
      if (d.migrate.toSet.has(target)) d.migrate.toSet.delete(target);
      else d.migrate.toSet.add(target);
      d.migrate.previewKey = null;
    });
    return true;
  }
  if (m.field === "type") {
    const target = MIGRATE_TYPES[m.typeCursor];
    if (!target) return true;
    store.dispatch((d) => {
      if (d.migrate.typeSet.has(target)) d.migrate.typeSet.delete(target);
      else d.migrate.typeSet.add(target);
      d.migrate.previewKey = null;
    });
    return true;
  }
  return false;
}

interface MigrateSelectionSnapshot {
  from: AgentName;
  toSet: Set<AgentName>;
  typeSet: Set<ConfigType>;
}

export function snapshotMigrateSelection(m: AppState["migrate"]): MigrateSelectionSnapshot {
  return {
    from: m.from,
    toSet: new Set(m.toSet),
    typeSet: new Set(m.typeSet),
  };
}

async function runMigrateForSelection(
  m: MigrateSelectionSnapshot,
  dryRun: boolean,
): Promise<MigrateResult> {
  return performMigrateTargets({
    from: m.from,
    targets: [...m.toSet].sort(),
    types: [...m.typeSet].sort(),
    dryRun,
  });
}

function runPreview(store: Store): void {
  const m = store.getState().migrate;
  if (m.toSet.size === 0) {
    store.dispatch((d) => setToast(d, "Select at least one target agent", "error"));
    return;
  }
  if (m.typeSet.size === 0) {
    store.dispatch((d) => setToast(d, "Select at least one config type", "error"));
    return;
  }
  const sig = migrateSignature(m);
  // Snapshot the selection now, before runOperation may yield. The store
  // does not deep-freeze state, so a live reference into `m` would let
  // a mid-flight toSet/typeSet edit by the user change what the operation
  // actually migrates. The signature `sig` already pins the user's
  // request; the snapshot pins the data the operation reads.
  const snap = snapshotMigrateSelection(m);
  store.runOperation<MigrateResult>(
    "migrate-preview",
    `preview ${sig}`,
    () => runMigrateForSelection(snap, true),
    {
      meta: { sig },
      activityKind: "preview",
      onSuccess: (draft, result) => {
        const lines: string[] = [];
        for (const x of result.migrated) lines.push(`  + ${x.targetPath}`);
        for (const s of result.skipped) lines.push(`  ~ skipped (${s.reason})`);
        for (const e of result.errors) lines.push(`  ! ${e}`);
        if (lines.length === 0) lines.push("  Nothing to migrate.");
        draft.migrate.preview = lines.join("\n");
        draft.migrate.previewKey = sig;
        setToast(draft, "Preview ready", "success");
      },
      onError: (draft, err) => {
        draft.migrate.preview = `  Error: ${err.message}`;
        draft.migrate.previewKey = null;
      },
      errorToastPrefix: "Preview",
    },
  );
}

function runApply(store: Store): void {
  const m = store.getState().migrate;
  const sig = migrateSignature(m);
  if (m.previewKey !== sig) {
    store.dispatch((d) => setToast(d, "Preview the current form before applying", "error"));
    return;
  }
  if (m.appliedSignature === sig) {
    store.dispatch((d) => setToast(d, "Already applied. Change form to migrate again.", "info"));
    return;
  }
  const snap = snapshotMigrateSelection(m);
  store.runOperation<MigrateResult>(
    "migrate",
    `apply ${sig}`,
    () => runMigrateForSelection(snap, false),
    {
      meta: { sig },
      activityKind: "migrate",
      onSuccess: (draft, result) => {
        const okMsg = `Applied: ${result.migrated.length} written, ${result.skipped.length} skipped`;
        const fullSuccess = result.errors.length === 0;
        setToast(draft, okMsg, fullSuccess ? "success" : "error");
        // Only mark the signature as applied when every (target × type)
        // pair succeeded. A partial failure must remain retryable without
        // forcing the user to change the form first.
        if (fullSuccess) draft.migrate.appliedSignature = sig;
      },
      errorToastPrefix: "Apply",
    },
  );
}

function anyOp(state: AppState, kind: string, phase: string): boolean {
  for (const id in state.inFlight) {
    const op = state.inFlight[id];
    if (op.kind === kind && op.phase === phase) return true;
  }
  return false;
}
