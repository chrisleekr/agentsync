import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";
import { version as pkgVersion } from "../../../package.json";
import { getUpdateStatus } from "../../core/version-check";
import { performUpgrade, upgradeInstructions } from "../upgrade";
import {
  type AppState,
  type ContextAction,
  countRunning,
  createInitialState,
  setKeyHint,
  setToast,
  TAB_IDS,
  type TabId,
} from "./state";
import { createStore, type Store } from "./store";
import { renderActivity } from "./tabs/activity";
import { ensureConfigLoaded, onConfigKey, renderConfig } from "./tabs/config";
import { renderDashboard } from "./tabs/dashboard";
import { ensureMachinesLoaded, onMachinesKey, renderMachines } from "./tabs/machines";
import { onMigrateKey, renderMigrate } from "./tabs/migrate";
import { ensureSyncLoaded, onSyncKey, renderSync, runSyncOp } from "./tabs/sync";

const TAB_LABELS: Record<TabId, string> = {
  dashboard: "Dashboard",
  sync: "Sync",
  machines: "Machines",
  migrate: "Migrate",
  activity: "Activity",
  config: "Config",
};

const PALETTE = {
  bg: "#0b0d10",
  panelBg: "#11151a",
  border: "#3b4252",
  borderFocus: "#88c0d0",
  text: "#d8dee9",
  textDim: "#6c7886",
  accent: "#88c0d0",
  good: "#a3be8c",
  warn: "#ebcb8b",
  bad: "#bf616a",
  tabActiveBg: "#2e3440",
  tabActiveText: "#eceff4",
} as const;

interface AppContext {
  renderer: CliRenderer;
  store: Store;
  rerender: () => void;
}

let toastTimer: ReturnType<typeof setInterval> | null = null;
let dataRefreshTimer: ReturnType<typeof setInterval> | null = null;

export async function runApp(): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write("agentsync TUI requires an interactive terminal.\n");
    return;
  }

  const renderer = await createCliRenderer({
    // false: route Ctrl+C through the manual SIGINT handler so `quitResolver`
    // fires, the `finally` block runs `teardown(renderer)` + `store.dispose()`,
    // and pending eviction timers are cancelled. With `true` here, OpenTUI's
    // own SIGINT handler can call `renderer.destroy()` and `process.exit()`
    // before the finally block, leaking the store's pendingTimers set.
    exitOnCtrlC: false,
    targetFps: 30,
    backgroundColor: PALETTE.bg,
  });

  const store = createStore(createInitialState());

  // Non-blocking update check: dispatches into state when it resolves, never
  // gates the first render. A failed check (offline, rate limit) leaves the
  // update slice unset, so no banner appears.
  void getUpdateStatus()
    .then((status) => {
      store.dispatch((d) => {
        d.update = {
          latest: status.latest,
          available: status.updateAvailable,
          method: status.method,
        };
      });
    })
    .catch(() => {});

  const root = new BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: PALETTE.bg,
  });
  renderer.root.add(root);

  const titleBar = makeTitleBar(renderer);
  const tabBar = makeTabBar(renderer);
  const contentHost = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: PALETTE.panelBg,
    width: "100%",
  });
  const actionBar = new TextRenderable(renderer, {
    height: 1,
    width: "100%",
    fg: PALETTE.textDim,
    bg: PALETTE.bg,
    content: "",
  });
  const footer = makeFooter(renderer);

  root.add(titleBar);
  root.add(tabBar);
  root.add(contentHost);
  root.add(actionBar);
  root.add(footer);

  let alive = true;
  const ctx: AppContext = {
    renderer,
    store,
    rerender: () => {
      const state = store.getState();
      renderTitleBar(titleBar, state);
      renderTabBar(tabBar, state);
      renderActiveTab(renderer, contentHost, store, ctx);
      renderActionBar(actionBar, contextActionsForTab(state), activeKeyHint(state));
      renderFooter(footer, state);
    },
  };

  // Coalesce renders onto a microtask. renderActiveTab calls ensureSyncLoaded,
  // which dispatches; a synchronous subscriber would re-enter rendering mid
  // render and stack a second panel into the same host. Deferring means a
  // dispatch-during-render schedules the next render instead of nesting.
  let renderScheduled = false;
  const scheduleRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    queueMicrotask(() => {
      renderScheduled = false;
      if (alive) ctx.rerender();
    });
  };
  store.subscribe(scheduleRender);
  ctx.rerender();

  toastTimer = setInterval(() => {
    const s = store.getState();
    const now = Date.now();
    const toastExpired = s.toast !== null && s.toast.expiresAt < now;
    const hintExpired = s.keyHint !== null && s.keyHint.expiresAt < now;
    if (toastExpired || hintExpired) {
      store.dispatch((d) => {
        if (toastExpired) d.toast = null;
        if (hintExpired) d.keyHint = null;
      });
    }
  }, 500);

  dataRefreshTimer = setInterval(() => ctx.rerender(), 30_000);

  let quitResolver: () => void = () => {};
  const quitPromise = new Promise<void>((res) => {
    quitResolver = res;
  });

  const onKey = (key: KeyEvent) => handleKey(key, ctx, quitResolver);
  renderer.keyInput.on("keypress", onKey);

  const onSignal = () => quitResolver();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  renderer.start();

  try {
    await quitPromise;
  } finally {
    alive = false;
    teardown(renderer);
    store.dispose();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

function teardown(renderer: CliRenderer): void {
  if (toastTimer) clearInterval(toastTimer);
  if (dataRefreshTimer) clearInterval(dataRefreshTimer);
  toastTimer = null;
  dataRefreshTimer = null;
  try {
    renderer.destroy();
  } catch {
    // best-effort
  }
}

function handleKey(key: KeyEvent, ctx: AppContext, quit: () => void): void {
  if (key.name === "q" || (key.ctrl && key.name === "c")) {
    quit();
    return;
  }

  // Help overlay swallows everything until it's dismissed. Without this
  // gate, pressing `p` (push) while the help text is on screen would fire
  // the global shortcut behind the modal — the user sees a help overlay
  // and accidentally pushes the vault.
  if (ctx.store.getState().helpOpen) {
    if (key.name === "?" || (key.shift && key.name === "/") || key.name === "escape") {
      ctx.store.dispatch((d) => {
        d.helpOpen = false;
      });
    }
    return;
  }

  // The Config tab's "switch secretScan → off?" confirm is a blocking modal,
  // like the help overlay: route every key to the tab so a global `p` (push),
  // number, or tab key cannot fire behind it. The tab handler answers y/n/esc
  // and swallows the rest.
  if (
    ctx.store.getState().activeTab === "config" &&
    ctx.store.getState().config.pendingSecretScan !== null
  ) {
    delegateTabKey(key, ctx);
    return;
  }

  // Show the action before running it: flash the pressed key in the bars and
  // surface its label, so a keypress is visibly acknowledged even when the
  // handler that follows does slow work.
  const action = actionLabelFor(key, ctx.store.getState());
  if (action) {
    ctx.store.dispatch((d) => {
      setKeyHint(d, action.key);
      setToast(d, action.label, "info", 1500);
    });
  }

  if (key.name >= "1" && key.name <= "9") {
    const idx = Number(key.name) - 1;
    if (idx >= 0 && idx < TAB_IDS.length) {
      ctx.store.dispatch((d) => {
        d.activeTab = TAB_IDS[idx];
      });
      return;
    }
  }
  if (key.name === "tab") {
    ctx.store.dispatch((d) => {
      const cur = TAB_IDS.indexOf(d.activeTab);
      d.activeTab = TAB_IDS[(cur + (key.shift ? -1 : 1) + TAB_IDS.length) % TAB_IDS.length];
    });
    return;
  }

  if (key.name === "p" && !key.shift) {
    // While a Sync modal is open (diff, skill drill-in, confirm-remove, or the
    // key prompt), `p` belongs to that modal — let the tab handle it instead of
    // firing a global push that would publish the current selection by accident.
    const state = ctx.store.getState();
    if (
      state.activeTab === "sync" &&
      (state.sync.diff ||
        state.sync.skillDrillIn ||
        state.sync.confirmRemove ||
        state.sync.keyPrompt === "pending")
    ) {
      delegateTabKey(key, ctx);
      return;
    }
    invokeSyncOp(ctx);
    return;
  }
  if (key.name === "u" && !key.shift) {
    invokeUpgrade(ctx);
    return;
  }

  if (key.name === "r" && !key.shift) {
    ctx.rerender();
    return;
  }

  if (key.name === "?" || (key.shift && key.name === "/")) {
    ctx.store.dispatch((d) => {
      d.helpOpen = !d.helpOpen;
    });
    return;
  }

  delegateTabKey(key, ctx);
}

function invokeSyncOp(ctx: AppContext): void {
  // Delegate to the Sync tab's runSyncOp so every push populates
  // `sync.lastOp` — the persistent banner the user reads to see what
  // happened. Toasts alone are too short-lived for terminal errors.
  runSyncOp(ctx.store);
}

/** Guards a second `u` press from launching a concurrent `bun install -g`
 *  while one is already running — two installs racing on the global
 *  node_modules can leave a half-written package. */
let upgradeInFlight = false;

/**
 * Handle the `u` key. Only a global npm install can be replaced from inside
 * the TUI; every other install method gets the manual instructions in a
 * longer-lived toast so the user has time to read the link.
 */
function invokeUpgrade(ctx: AppContext): void {
  const { update } = ctx.store.getState();
  if (!update.available || update.latest === null) {
    ctx.store.dispatch((d) => setToast(d, "You are on the latest version.", "info"));
    return;
  }
  if (update.method !== "npm-global") {
    // Bind `latest` outside the dispatch closure: TypeScript drops the
    // non-null narrowing of `update.latest` once it crosses into a callback.
    const latest = update.latest;
    ctx.store.dispatch((d) =>
      setToast(d, upgradeInstructions(update.method, latest), "info", 8000),
    );
    return;
  }
  if (upgradeInFlight) {
    ctx.store.dispatch((d) => setToast(d, "Upgrade already in progress.", "info"));
    return;
  }
  // Build the status from the slice the banner already showed — re-fetching
  // here could install a version different from the one in the toast.
  const latest = update.latest;
  upgradeInFlight = true;
  ctx.store.runOperation(
    "upgrade",
    `Upgrade to v${latest}`,
    async () => {
      try {
        return await performUpgrade({
          current: pkgVersion,
          latest,
          updateAvailable: true,
          method: "npm-global",
        });
      } finally {
        upgradeInFlight = false;
      }
    },
    {
      activityKind: "info",
      toastOnStart: { text: `Upgrading to v${latest}…` },
      onSuccess: (d, result) => setToast(d, result.message, "success", 8000),
      errorToastPrefix: "Upgrade",
    },
  );
}

function delegateTabKey(key: KeyEvent, ctx: AppContext): void {
  const tab = ctx.store.getState().activeTab;
  switch (tab) {
    case "sync":
      onSyncKey(key, ctx.store);
      break;
    case "machines":
      onMachinesKey(key, ctx.store);
      break;
    case "config":
      onConfigKey(key, ctx.store);
      break;
    case "migrate":
      onMigrateKey(key, ctx.store);
      break;
    case "activity":
      if (key.name === "c") {
        ctx.store.dispatch((d) => {
          d.activity = [];
        });
      }
      break;
    case "dashboard":
      if (key.name === "i") {
        ctx.store.dispatch((d) =>
          setToast(d, "Init wizard: run `agentsync init --remote <url>` from a shell", "info"),
        );
      } else if (key.name === "k") {
        ctx.store.dispatch((d) =>
          setToast(d, "Key rotate: run `agentsync key rotate` from a shell", "info"),
        );
      }
      break;
  }
}

function makeTitleBar(renderer: CliRenderer): TextRenderable {
  return new TextRenderable(renderer, {
    height: 1,
    width: "100%",
    fg: PALETTE.text,
    bg: PALETTE.bg,
    content: "",
  });
}
function renderTitleBar(host: TextRenderable, _state: AppState): void {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  host.content = ` agentsync · v${pkgVersion} · ${time}`;
}

function makeTabBar(renderer: CliRenderer): TextRenderable {
  return new TextRenderable(renderer, {
    height: 1,
    width: "100%",
    fg: PALETTE.text,
    bg: PALETTE.bg,
    content: "",
  });
}
function renderTabBar(host: TextRenderable, state: AppState): void {
  const parts: string[] = [];
  TAB_IDS.forEach((id, i) => {
    const num = i + 1;
    const label = TAB_LABELS[id];
    const active = id === state.activeTab;
    const dirty = id === "sync" && state.selection.size > 0;
    const text = `[${num}] ${label}${dirty ? "*" : ""}`;
    parts.push(active ? `▌${text}▐` : ` ${text} `);
  });
  host.content = ` ${parts.join("  ")}`;
}

function makeFooter(renderer: CliRenderer): TextRenderable {
  return new TextRenderable(renderer, {
    height: 1,
    width: "100%",
    fg: PALETTE.textDim,
    bg: PALETTE.bg,
    content: "",
  });
}
function renderFooter(host: TextRenderable, state: AppState): void {
  const running = countRunning(state);
  const opLabel = running > 0 ? `  ${running} op(s)` : "";
  const toast = state.toast ? `  ⟶ ${state.toast.text}` : "";
  // The just-pressed global key renders as [k] instead of  k . Both markers
  // are 3 wide so the bar does not shift when a key flashes.
  const hintKey = activeKeyHint(state);
  const globalKeys: [string, string][] = [
    ["p", "push"],
    ["r", "refresh"],
    ["?", "help"],
    ["q", "quit"],
  ];
  // Surface the update key only when there is something to install, so the
  // bar does not advertise an action that would just say "already latest".
  if (state.update.available) globalKeys.splice(2, 0, ["u", "update"]);
  const actions = globalKeys
    .map(([k, label]) => `${hintKey === k ? `[${k}]` : ` ${k} `}${label}`)
    .join(" ");
  host.content = `${actions}${opLabel}${toast}`;
}

/** The action-bar key being flashed right now, or null once the flash TTL
 *  has elapsed. Expiry is checked at render time so a stale hint never shows. */
function activeKeyHint(state: AppState): string | null {
  if (state.keyHint && state.keyHint.expiresAt > Date.now()) {
    return state.keyHint.key;
  }
  return null;
}

/**
 * Map a keypress to the action it triggers, for the pre-action flash + toast.
 * Pure navigation (arrows, space, enter, esc) returns null so the bars do not
 * flash on every cursor move. Returns the bar key it maps to and a label.
 */
function actionLabelFor(key: KeyEvent, state: AppState): { key: string; label: string } | null {
  if (state.helpOpen) return null;
  const name = key.name;
  if (name >= "1" && name <= "9") {
    const idx = Number(name) - 1;
    if (idx < TAB_IDS.length) return { key: name, label: TAB_LABELS[TAB_IDS[idx]] };
  }
  if (name === "tab") return { key: "tab", label: key.shift ? "prev tab" : "next tab" };
  if (name === "p" && !key.shift) return { key: "p", label: "push" };
  if (name === "u" && !key.shift && state.update.available) return { key: "u", label: "update" };
  if (name === "r" && !key.shift) return { key: "r", label: "refresh" };
  if (name === "?" || (key.shift && name === "/")) return { key: "?", label: "help" };
  switch (state.activeTab) {
    case "dashboard":
      if (name === "i") return { key: "i", label: "init" };
      if (name === "k") return { key: "k", label: "key rotate" };
      break;
    case "sync":
      // A Sync sub-mode (diff, skill drill-in, confirm-remove, key prompt)
      // owns the keymap and swallows k/x, so do not flash an action the
      // sub-mode will never run.
      if (
        state.sync.diff ||
        state.sync.skillDrillIn ||
        state.sync.confirmRemove ||
        state.sync.keyPrompt === "pending"
      ) {
        break;
      }
      if (name === "x" && state.selection.size > 0) return { key: "x", label: "remove" };
      if (name === "k") return { key: "k", label: "load key" };
      break;
    case "migrate":
      if (key.shift && name === "p") return { key: "P", label: "preview" };
      if (key.shift && name === "a") return { key: "A", label: "apply" };
      break;
    case "activity":
      if (name === "c") return { key: "c", label: "clear" };
      break;
    case "config":
      if (name === "space") return { key: "space", label: "toggle" };
      if (name === "left" || name === "right") return { key: "← →", label: "change" };
      break;
  }
  return null;
}

function renderActionBar(
  host: TextRenderable,
  actions: ContextAction[],
  hintKey: string | null,
): void {
  if (actions.length === 0) {
    host.content = "";
    return;
  }
  const parts = actions.map((a) => `${hintKey === a.key ? `[${a.key}]` : a.key} ${a.label}`);
  host.content = `  ${parts.join("   ")}`;
}

function renderActiveTab(
  renderer: CliRenderer,
  host: BoxRenderable,
  store: Store,
  ctx: AppContext,
): void {
  void ctx;
  for (const child of [...host.getChildren()]) {
    host.remove(child.id);
  }
  const state = store.getState();
  if (state.helpOpen) {
    renderHelp(renderer, host, state);
  } else {
    switch (state.activeTab) {
      case "dashboard":
        renderDashboard(renderer, host, state);
        break;
      case "sync":
        ensureSyncLoaded(store);
        renderSync(renderer, host, state);
        break;
      case "machines":
        ensureMachinesLoaded(store);
        renderMachines(renderer, host, state);
        break;
      case "migrate":
        renderMigrate(renderer, host, state);
        break;
      case "activity":
        renderActivity(renderer, host, state);
        break;
      case "config":
        ensureConfigLoaded(store);
        renderConfig(renderer, host, state);
        break;
    }
  }
}

function renderHelp(renderer: CliRenderer, host: BoxRenderable, state: AppState): void {
  const help = [
    "",
    "  Global keys",
    "    1 – 6         Jump to tab",
    "    Tab / Sh+Tab  Cycle tabs",
    "    p             Push vault (direct)",
    "    r             Refresh current tab",
    // Listed only when armed, to match the footer and action bar.
    ...(state.update.available ? ["    u             Install an available update"] : []),
    "    ?             Toggle this overlay",
    "    q / Ctrl-C    Quit",
    "",
    "  Dashboard",
    "    i             Init wizard hint",
    "    k             Key rotate hint",
    "",
    "  Sync — file list",
    "    ↑ / ↓         Move cursor (auto-scrolls)",
    "    PgUp / PgDn   Jump cursor by a page",
    "    Home / End    Jump to first / last row",
    "    enter / d     Open diff (skill rows: drill into bundle)",
    "    space         Toggle selection (push respects selection as allowlist)",
    "    a             Select all rows in cursor's section (toggle)",
    "    A             Select all visible rows (toggle)",
    "    esc           Clear selection",
    "    c             Copy selected paths (or cursor path) to clipboard",
    "    x             Remove selected vault artifacts — opens y/n confirm modal",
    "    s             Toggle synced section (collapsed by default)",
    "    k             Load private key for accurate status",
    "",
    "  Machines",
    "    ↑ / ↓         Move cursor through machine namespaces",
    "    enter         Copy the selected machine's config to this machine",
    "",
    "  Sync — skill drill-in",
    "    ↑ / ↓         Move cursor through files in bundle",
    "    enter / d     Open diff for focused file",
    "    esc / q       Close drill-in",
    "",
    "  Sync — diff modal",
    "    ↑ / ↓         Move cursor through diff rows",
    "    PgUp / PgDn   Jump by a page",
    "    Home / End    Jump to first / last row",
    "    ← / h         Switch cursor to vault side",
    "    → / l         Switch cursor to local side",
    "    space         Toggle line selection on current side",
    "    a             Select all lines on current side (toggle)",
    "    c             Copy selected lines (or full diff if none selected)",
    "    esc / q       Close diff modal",
    "",
    "  Migrate",
    "    Tab / Sh+Tab  Cycle From / To / Type / Preview / Apply",
    "    ↑ / ↓         Same as Tab / Shift-Tab",
    "    ← / →         From: cycle value · To/Type: move sub-cursor",
    "                  Preview ↔ Apply (same visual row)",
    "    space         Toggle option at sub-cursor (To / Type)",
    "    enter         Activate Preview / Apply",
    "    Shift-P       Run preview",
    "    Shift-A       Apply (after a matching preview)",
    "",
    "  Config",
    "    ↑ / ↓         Move between settings",
    "    space         Toggle a boolean setting",
    "    ← / →         Cycle an enum / adjust a number",
    "                  (changes reconcile + push to the vault)",
    "",
    "  Activity",
    "    c             Clear log",
    "",
    "  Press any key to dismiss.",
  ].join("\n");
  const box = new BoxRenderable(renderer, {
    flexGrow: 1,
    width: "100%",
    border: true,
    borderColor: PALETTE.accent,
    borderStyle: "double",
    title: " agentsync — keymap ",
    backgroundColor: PALETTE.panelBg,
  });
  box.add(new TextRenderable(renderer, { content: help, fg: PALETTE.text, bg: PALETTE.panelBg }));
  host.add(box);
}

function contextActionsForTab(state: AppState): ContextAction[] {
  switch (state.activeTab) {
    case "dashboard":
      return [
        { key: "i", label: "init" },
        { key: "k", label: "key rotate" },
      ];
    case "sync": {
      const base: ContextAction[] = [
        { key: "↑↓", label: "move" },
        { key: "enter", label: "diff" },
        { key: "space", label: "select" },
      ];
      if (state.selection.size > 0) base.push({ key: "x", label: "remove" });
      if (!state.sync.keyLoaded) base.push({ key: "k", label: "load key" });
      return base;
    }
    case "machines": {
      const base: ContextAction[] = [{ key: "↑↓", label: "move" }];
      if (state.machines.phase === "ready" && state.machines.list.length > 0) {
        base.push({ key: "enter", label: "copy here" });
      }
      return base;
    }
    case "migrate":
      return [
        { key: "tab", label: "next field" },
        { key: "P", label: "preview" },
        { key: "A", label: "apply" },
      ];
    case "activity":
      return [{ key: "c", label: "clear" }];
    case "config":
      return [
        { key: "↑↓", label: "move" },
        { key: "space", label: "toggle" },
        { key: "← →", label: "change" },
      ];
  }
}
