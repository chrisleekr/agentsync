import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import type { MigrateOptions } from "../../../config/schema";
import { performMigrate } from "../../../migrate/migrate";
import type { MigrateResult } from "../../../migrate/types";
import {
  AGENTS,
  type AgentName,
  type AppState,
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

  const fromRow = `${focusMark("from")}  From:  ${AGENTS.map((a) => `${radio(a === m.from)} ${a}`).join("  ")}`;
  const toRow = `${focusMark("to")}  To:    ${AGENTS.map((a) => `${check(m.toSet.has(a))} ${a}`).join("  ")}`;
  const typeRow = `${focusMark("type")}  Type:  ${MIGRATE_TYPES.map((t) => `${radio(t === m.type)} ${t}`).join("  ")}`;

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
    "  Tab / Shift-Tab move between fields. Arrow keys or space change values.",
    "  Enter activates the Preview / Apply button.",
  ].join("\n");

  const formBox = new BoxRenderable(renderer, {
    height: 14,
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

  if (key.name === "left" || key.name === "right") {
    return cycleValue(store, key.name === "right");
  }

  if (key.name === "space" && m.field === "to") {
    return cycleValue(store, true);
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

function cycleValue(store: Store, forward: boolean): boolean {
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
        const sorted = [...d.migrate.toSet].sort();
        const last = sorted[sorted.length - 1] as AgentName | undefined;
        const i = last ? AGENTS.indexOf(last) : -1;
        const next = AGENTS[(i + (forward ? 1 : -1) + AGENTS.length) % AGENTS.length];
        if (d.migrate.toSet.has(next)) d.migrate.toSet.delete(next);
        else d.migrate.toSet.add(next);
        d.migrate.previewKey = null;
      });
      return true;
    }
    case "type": {
      store.dispatch((d) => {
        const i = MIGRATE_TYPES.indexOf(d.migrate.type);
        d.migrate.type =
          MIGRATE_TYPES[(i + (forward ? 1 : -1) + MIGRATE_TYPES.length) % MIGRATE_TYPES.length];
        d.migrate.previewKey = null;
      });
      return true;
    }
    default:
      return false;
  }
}

/**
 * `performMigrate` accepts a single agent or "all", not a comma list, so the
 * multi-select Migrate tab fans out one call per target and merges results.
 * Returns the aggregated MigrateResult (migrated/skipped/errors concatenated).
 */
async function runMigrateForSelection(
  m: AppState["migrate"],
  dryRun: boolean,
): Promise<MigrateResult> {
  const aggregate: MigrateResult = { migrated: [], skipped: [], errors: [], warnings: [] };
  const targets: ("all" | AgentName)[] =
    m.toSet.size === AGENTS.length ? ["all"] : [...m.toSet].sort();
  for (const target of targets) {
    const options: MigrateOptions = {
      from: m.from,
      to: target,
      type: m.type,
      dryRun,
    };
    const r = await performMigrate(options);
    aggregate.migrated.push(...r.migrated);
    aggregate.skipped.push(...r.skipped);
    aggregate.errors.push(...r.errors);
    aggregate.warnings.push(...r.warnings);
  }
  return aggregate;
}

function runPreview(store: Store): void {
  const m = store.getState().migrate;
  if (m.toSet.size === 0) {
    store.dispatch((d) => setToast(d, "Select at least one target agent", "error"));
    return;
  }
  const sig = migrateSignature(m);
  store.runOperation<MigrateResult>(
    "migrate-preview",
    `preview ${sig}`,
    () => runMigrateForSelection(m, true),
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
  store.runOperation<MigrateResult>(
    "migrate",
    `apply ${sig}`,
    () => runMigrateForSelection(m, false),
    {
      meta: { sig },
      activityKind: "migrate",
      onSuccess: (draft, result) => {
        const okMsg = `Applied: ${result.migrated.length} written, ${result.skipped.length} skipped`;
        setToast(draft, okMsg, result.errors.length === 0 ? "success" : "error");
        draft.migrate.appliedSignature = sig;
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
