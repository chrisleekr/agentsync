import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { peekVaultVersion, resolveConfigPath } from "../../../config/loader";
import { performConfigList, performConfigSet } from "../../config";
import { performKeyList } from "../../key";
import { resolveRuntimeContext } from "../../shared";
import { type AppState, type ConfigRow, setToast } from "../state";
import type { Store } from "../store";

// Sections the Config tab lets you edit. Mirrors SETTABLE_PREFIXES in
// commands/config.ts; remote/version/recipients are not editable here.
const SETTABLE_PREFIXES = ["agents.", "sync.", "claudePlugins.", "security."];
const SECRET_SCAN_OPTIONS = ["standard", "strict", "off"] as const;
const DEBOUNCE_STEP = 50;
const DEBOUNCE_MIN = 50;
const DEBOUNCE_MAX = 10_000;

/** Classify a config key/value into an editable row kind. */
function classify(key: string, value: unknown): ConfigRow {
  if (key === "security.secretScan") {
    return { key, value, kind: "enum", options: SECRET_SCAN_OPTIONS };
  }
  if (key === "sync.debounceMs") return { key, value, kind: "number" };
  if (key === "security.allowSecretValues") return { key, value, kind: "readonly" };
  if (typeof value === "boolean") return { key, value, kind: "boolean" };
  return { key, value, kind: "readonly" };
}

/**
 * Load the settable config rows and the recipient list once per tab visit.
 * Reuses `performConfigList`/`performKeyList` so the TUI never forks the config
 * logic. `peekVaultVersion` runs FIRST and throws on anything other than a v2
 * vault: `loadVaultConfigOrExit` (called by the perform* functions) calls
 * `process.exit` on an absent/v1/unsupported vault, which would kill the whole
 * TUI. Throwing a catchable error here keeps the tab in `phase: "error"`, which
 * also means the edit handlers never run (no rows, not ready) so `setConfig`
 * cannot reach `process.exit` either.
 */
export function ensureConfigLoaded(store: Store): void {
  if (store.getState().config.phase !== "idle") return;
  store.dispatch((d) => {
    d.config.phase = "loading";
    d.config.error = null;
  });
  store.runOperation(
    "config-load",
    "load config",
    async () => {
      const runtime = await resolveRuntimeContext();
      const probe = await peekVaultVersion(resolveConfigPath(runtime.vaultDir));
      if (probe.kind !== "v2") {
        throw new Error(
          probe.kind === "absent"
            ? "Vault not initialized — run `agentsync init`."
            : probe.kind === "v1"
              ? "Vault uses the old layout — run `agentsync vault upgrade`."
              : `Vault format v${probe.version} is newer than this agentsync — run \`agentsync upgrade\`.`,
        );
      }
      const [entries, recipients] = await Promise.all([performConfigList(), performKeyList()]);
      return { entries, recipients };
    },
    {
      onSuccess: (d, { entries, recipients }) => {
        d.config.rows = entries
          .filter((e) => SETTABLE_PREFIXES.some((p) => e.key.startsWith(p)))
          .map((e) => classify(e.key, e.value));
        d.config.recipients = recipients;
        d.config.cursor = Math.min(d.config.cursor, Math.max(0, d.config.rows.length - 1));
        d.config.phase = "ready";
      },
      onError: (d, err) => {
        d.config.phase = "error";
        d.config.error = err.message;
      },
    },
  );
}

/** Push one config change through the shared `performConfigSet` core. */
function setConfig(store: Store, key: string, rawValue: string): void {
  // performConfigSet reconciles + commits + pushes the shared git working tree,
  // which is not concurrency-safe. Refuse a second edit while one is in flight
  // rather than race two git operations on the same repo.
  const busy = Object.values(store.getState().inFlight).some(
    (op) => op.kind === "config-set" && op.phase === "running",
  );
  if (busy) {
    store.dispatch((d) =>
      setToast(d, "A config change is already in flight — wait for it to finish.", "info"),
    );
    return;
  }
  store.runOperation(
    "config-set",
    `set ${key}`,
    async () => {
      const result = await performConfigSet(key, rawValue);
      if (result.status !== "success") {
        const why =
          result.status === "invalid-value" ? result.error : `config set ${key}: ${result.status}`;
        throw new Error(why);
      }
      return result.newValue;
    },
    {
      onSuccess: (d, newValue) => {
        const row = d.config.rows.find((r) => r.key === key);
        if (row) row.value = newValue;
        d.config.lastResult = { ok: true, message: `${key} = ${formatValue(newValue)}` };
      },
      onError: (d, err) => {
        d.config.lastResult = { ok: false, message: err.message };
        setToast(d, `config set failed: ${err.message}`, "error");
      },
      errorToastPrefix: "config",
    },
  );
}

/** Handle Config-tab keys. Returns true when the key was consumed. */
export function onConfigKey(key: KeyEvent, store: Store): boolean {
  const c = store.getState().config;
  if (c.phase !== "ready" || c.rows.length === 0) return false;

  if (key.name === "down") {
    store.dispatch((d) => {
      d.config.cursor = Math.min(d.config.cursor + 1, d.config.rows.length - 1);
    });
    return true;
  }
  if (key.name === "up") {
    store.dispatch((d) => {
      d.config.cursor = Math.max(d.config.cursor - 1, 0);
    });
    return true;
  }

  const row = c.rows[c.cursor];
  if (!row) return false;

  if (key.name === "space" && row.kind === "boolean") {
    setConfig(store, row.key, String(!(row.value === true)));
    return true;
  }
  if ((key.name === "left" || key.name === "right") && row.kind === "enum" && row.options) {
    const dir = key.name === "right" ? 1 : -1;
    // When the current value isn't a known option, seed from the end the
    // direction moves toward so the first press lands on a sensible option.
    const found = row.options.indexOf(String(row.value));
    const idx = found === -1 ? (dir === 1 ? -1 : 0) : found;
    const next = row.options[(idx + dir + row.options.length) % row.options.length];
    if (next !== undefined && next !== row.value) setConfig(store, row.key, next);
    return true;
  }
  if ((key.name === "left" || key.name === "right") && row.kind === "number") {
    const dir = key.name === "right" ? DEBOUNCE_STEP : -DEBOUNCE_STEP;
    const current = typeof row.value === "number" ? row.value : DEBOUNCE_MIN;
    const next = Math.min(DEBOUNCE_MAX, Math.max(DEBOUNCE_MIN, current + dir));
    if (next !== current) setConfig(store, row.key, String(next));
    return true;
  }
  return false;
}

/** Render a config value for display. */
function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Hint describing how the row under the cursor is edited. */
function editHintFor(row: ConfigRow | undefined): string {
  if (!row) return "";
  switch (row.kind) {
    case "boolean":
      return "space: toggle";
    case "enum":
      return "← →: cycle";
    case "number":
      return "← →: adjust";
    default:
      return "read-only (edit via CLI)";
  }
}

export function renderConfig(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
  const c = state.config;
  const wrapper = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    backgroundColor: "#11151a",
    border: false,
  });
  host.add(wrapper);

  let body: string;
  if (c.phase === "loading" || c.phase === "idle") {
    body = "\n  Loading config…";
  } else if (c.phase === "error") {
    body = `\n  Could not load config: ${c.error ?? "unknown error"}\n  (Run \`agentsync init\` first if this machine has no vault.)`;
  } else if (c.rows.length === 0) {
    body = "\n  No editable settings found.";
  } else {
    const width = Math.max(...c.rows.map((r) => r.key.length));
    body = [
      "",
      ...c.rows.map((r, i) => {
        const marker = i === c.cursor ? "›" : " ";
        const ro = r.kind === "readonly" ? "  (read-only)" : "";
        return `  ${marker} ${r.key.padEnd(width)}  =  ${formatValue(r.value)}${ro}`;
      }),
      "",
    ].join("\n");
  }

  const listBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: "#3b4252",
    borderStyle: "single",
    title: " Config (writes go to the vault, shared across machines) ",
    backgroundColor: "#11151a",
  });
  listBox.add(new TextRenderable(renderer, { content: body, fg: "#d8dee9", bg: "#11151a" }));
  wrapper.add(listBox);

  // Recipients — who can decrypt the vault (read-only; `key list`).
  const recipientsBody =
    c.recipients.length > 0
      ? c.recipients
          .map((r) => `  ${r.isSelf ? "*" : " "} ${r.name}  ${r.recipient.slice(0, 20)}…`)
          .join("\n")
      : "  (none)";
  const recipientsBox = new BoxRenderable(renderer, {
    height: Math.min(8, c.recipients.length + 2),
    width: "100%",
    border: true,
    borderColor: "#3b4252",
    borderStyle: "single",
    title: " Recipients — who can decrypt ('*' = this machine) ",
    backgroundColor: "#11151a",
  });
  recipientsBox.add(
    new TextRenderable(renderer, { content: recipientsBody, fg: "#a9b3c0", bg: "#11151a" }),
  );
  wrapper.add(recipientsBox);

  const cursorRow = c.phase === "ready" ? c.rows[c.cursor] : undefined;
  const hint = c.lastResult
    ? `  last: ${c.lastResult.ok ? "✓" : "✗"} ${c.lastResult.message}`
    : `  ↑↓ move • ${editHintFor(cursorRow)} • changes reconcile + push to the vault`;
  wrapper.add(
    new TextRenderable(renderer, {
      height: 2,
      width: "100%",
      fg: "#6c7886",
      bg: "#11151a",
      content: `\n${hint}`,
    }),
  );
}
