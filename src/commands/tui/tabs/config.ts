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
const SETTABLE_PREFIXES = ["agents.", "claudePlugins.", "security."];
const SECRET_SCAN_OPTIONS = ["standard", "strict", "redact", "off"] as const;

/** One-line consequence of each secretScan mode, shown in the explainer panel. */
export function secretScanExplainer(value: unknown): string {
  switch (String(value)) {
    case "standard":
      return "Built-in credential patterns. A literal key or token blocks the push — you remove it and retry. Nothing secret-shaped enters the vault.";
    case "strict":
      return "standard + JWT detection. Higher false-positive rate; blocks the push on any match.";
    case "redact":
      return "API keys in JSON/TOML config are replaced with a $AGENTSYNC_REDACTED_ placeholder and pushed. copy keeps each machine's own real value; a fresh machine shows the placeholder to fill in. Secrets in prose still block.";
    case "off":
      return "No redaction — API keys are encrypted and pushed as-is. Protection is encryption ALONE: every recipient and any lost device key can read them.";
    default:
      return "";
  }
}
/** Classify a config key/value into an editable row kind. */
function classify(key: string, value: unknown): ConfigRow {
  if (key === "security.secretScan") {
    return { key, value, kind: "enum", options: SECRET_SCAN_OPTIONS };
  }
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

  // The → off confirmation modal is blocking: it consumes every key until the
  // user answers y (apply) or n/esc (cancel).
  if (c.pendingSecretScan !== null) {
    if (key.name === "y") {
      const target = c.pendingSecretScan;
      store.dispatch((d) => {
        d.config.pendingSecretScan = null;
      });
      setConfig(store, "security.secretScan", target);
    } else if (key.name === "n" || key.name === "escape") {
      store.dispatch((d) => {
        d.config.pendingSecretScan = null;
      });
    }
    return true;
  }

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
    if (next !== undefined && next !== row.value) {
      // The → off transition pushes live secrets into the vault, so it gates
      // behind a y/n confirm. Every other value applies immediately.
      if (row.key === "security.secretScan" && next === "off") {
        store.dispatch((d) => {
          d.config.pendingSecretScan = next;
        });
      } else {
        setConfig(store, row.key, next);
      }
    }
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

  const cursorRow = c.phase === "ready" ? c.rows[c.cursor] : undefined;

  // Context panel: the dangerous → off confirm, or a "what this means" line for
  // the secretScan mode under the cursor. Nothing for ordinary rows.
  if (c.pendingSecretScan !== null) {
    const confirm = new BoxRenderable(renderer, {
      width: "100%",
      border: true,
      borderColor: "#bf616a",
      borderStyle: "single",
      title: " Switch secretScan → off? ",
      backgroundColor: "#11151a",
    });
    confirm.add(
      new TextRenderable(renderer, {
        content: `\n  ${secretScanExplainer("off")}\n  Age keys & PEM private keys are still refused.\n\n  [y] confirm    [n] cancel`,
        fg: "#e5c07b",
        bg: "#11151a",
      }),
    );
    wrapper.add(confirm);
  } else if (cursorRow?.key === "security.secretScan") {
    const explain = new BoxRenderable(renderer, {
      width: "100%",
      border: true,
      borderColor: "#3b4252",
      borderStyle: "single",
      title: " What this means ",
      backgroundColor: "#11151a",
    });
    explain.add(
      new TextRenderable(renderer, {
        content: `\n  ${secretScanExplainer(cursorRow.value)}`,
        fg: "#a9b3c0",
        bg: "#11151a",
      }),
    );
    wrapper.add(explain);
  }

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

  const hint = c.pendingSecretScan
    ? "  press y to confirm switching to off, or n to cancel"
    : c.lastResult
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
