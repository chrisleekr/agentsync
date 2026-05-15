import type { CliRenderer, KeyEvent } from "@opentui/core";
import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";
import { TuiIpcClient } from "./lib/ipc-client";
import {
  type AppState,
  type ContextAction,
  countRunning,
  createInitialState,
  setToast,
  TAB_IDS,
  type TabId,
} from "./state";
import { createStore, type Store } from "./store";
import { renderActivity } from "./tabs/activity";
import { ensureAgentsLoaded, onAgentsKey, renderAgents } from "./tabs/agents";
import { renderDashboard } from "./tabs/dashboard";
import { onMigrateKey, renderMigrate } from "./tabs/migrate";
import { ensureVaultLoaded, onVaultKey, renderVault } from "./tabs/vault";

const POLL_INTERVAL_MS = 1500;

const TAB_LABELS: Record<TabId, string> = {
  dashboard: "Dashboard",
  vault: "Vault",
  agents: "Agents",
  migrate: "Migrate",
  activity: "Activity",
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
  ipc: TuiIpcClient;
  rerender: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let toastTimer: ReturnType<typeof setInterval> | null = null;
let dataRefreshTimer: ReturnType<typeof setInterval> | null = null;

export async function runApp(): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write("agentsync TUI requires an interactive terminal.\n");
    return;
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    backgroundColor: PALETTE.bg,
  });

  const store = createStore(createInitialState());
  const ipc = new TuiIpcClient();

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

  const ctx: AppContext = {
    renderer,
    store,
    ipc,
    rerender: () => {
      const state = store.getState();
      renderTitleBar(titleBar, state);
      renderTabBar(tabBar, state);
      renderActiveTab(renderer, contentHost, store, ctx);
      renderActionBar(actionBar, contextActionsForTab(state));
      renderFooter(footer, state);
    },
  };

  store.subscribe(() => ctx.rerender());
  ctx.rerender();

  const pollOnce = async () => {
    const status = await ipc.status().catch(() => null);
    store.dispatch((draft) => {
      if (status) {
        if (draft.daemon.status?.pid !== status.pid) {
          draft.daemon.pidObservedAt = Date.now();
        }
        draft.daemon.online = true;
        draft.daemon.status = status;
        draft.daemon.lastError = status.lastError ?? null;
      } else {
        draft.daemon.online = false;
        draft.daemon.status = null;
        draft.daemon.pidObservedAt = null;
      }
    });
  };
  await pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);

  toastTimer = setInterval(() => {
    const s = store.getState();
    if (s.toast && s.toast.expiresAt < Date.now()) {
      store.dispatch((d) => {
        d.toast = null;
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
    teardown(renderer);
    store.dispose();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

function teardown(renderer: CliRenderer): void {
  if (pollTimer) clearInterval(pollTimer);
  if (toastTimer) clearInterval(toastTimer);
  if (dataRefreshTimer) clearInterval(dataRefreshTimer);
  pollTimer = null;
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

  if (key.name >= "1" && key.name <= "5") {
    const idx = Number(key.name) - 1;
    if (idx >= 0 && idx < TAB_IDS.length) {
      ctx.store.dispatch((d) => {
        d.activeTab = TAB_IDS[idx];
        d.selection.clear();
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
    invokeDaemonOp("push", ctx);
    return;
  }
  if (key.name === "l" && !key.shift) {
    invokeDaemonOp("pull", ctx);
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

  if (ctx.store.getState().helpOpen) {
    ctx.store.dispatch((d) => {
      d.helpOpen = false;
    });
    return;
  }

  delegateTabKey(key, ctx);
}

function invokeDaemonOp(op: "push" | "pull", ctx: AppContext): void {
  if (!ctx.store.getState().daemon.online) {
    ctx.store.dispatch((d) =>
      setToast(d, `Daemon offline — start with "agentsync daemon start"`, "error"),
    );
    return;
  }
  ctx.store.runOperation(
    op,
    `${op} via daemon`,
    async () => {
      const result = op === "push" ? await ctx.ipc.push() : await ctx.ipc.pull();
      if (!result.ok) throw new Error(result.error ?? "unknown");
      return result;
    },
    {
      activityKind: op,
      toastOnStart: { text: `Queued ${op}…`, level: "info" },
      successToast: `${op} queued`,
      errorToastPrefix: op,
    },
  );
}

function delegateTabKey(key: KeyEvent, ctx: AppContext): void {
  const tab = ctx.store.getState().activeTab;
  switch (tab) {
    case "vault":
      onVaultKey(key, ctx.store);
      break;
    case "agents":
      onAgentsKey(key, ctx.store);
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
  host.content = ` agentsync · v0.1.6 · ${time}`;
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
    const dirty = id === "vault" && state.selection.size > 0;
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
  const dot = state.daemon.online ? "●" : "○";
  const daemonLabel = state.daemon.online ? "live" : "offline";
  const running = countRunning(state);
  const opLabel = running > 0 ? `  ${running} op(s)` : "";
  const toast = state.toast ? `  ⟶ ${state.toast.text}` : "";
  host.content = ` p push  l pull  r refresh  ? help  q quit            daemon ${dot} ${daemonLabel}${opLabel}${toast}`;
}

function renderActionBar(host: TextRenderable, actions: ContextAction[]): void {
  if (actions.length === 0) {
    host.content = "";
    return;
  }
  const parts = actions.map((a) => `${a.key} ${a.label}`);
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
    renderHelp(renderer, host);
  } else {
    switch (state.activeTab) {
      case "dashboard":
        renderDashboard(renderer, host, state);
        break;
      case "vault":
        ensureVaultLoaded(store);
        renderVault(renderer, host, state);
        break;
      case "agents":
        ensureAgentsLoaded(store);
        renderAgents(renderer, host, state);
        break;
      case "migrate":
        renderMigrate(renderer, host, state);
        break;
      case "activity":
        renderActivity(renderer, host, state);
        break;
    }
  }
}

function renderHelp(renderer: CliRenderer, host: BoxRenderable): void {
  const help = [
    "",
    "  Global keys",
    "    1 – 5         Jump to tab",
    "    Tab / Sh+Tab  Cycle tabs",
    "    p             Push vault",
    "    l             Pull vault",
    "    r             Refresh current tab",
    "    ?             Toggle this overlay",
    "    q / Ctrl-C    Quit",
    "",
    "  Dashboard",
    "    i             Init wizard hint",
    "    k             Key rotate hint",
    "",
    "  Vault",
    "    ↑ / ↓         Move cursor",
    "    space         Toggle selection (skills only)",
    "    x             Bulk remove selected skills",
    "",
    "  Agents",
    "    ↑ / ↓         Move cursor",
    "    d             Diff focused file vs vault (planned)",
    "",
    "  Migrate",
    "    Tab           Cycle From / To / Type / Preview / Apply",
    "    ← / →         Cycle value of focused field",
    "    Shift-P       Run preview",
    "    Shift-A       Apply (after a matching preview)",
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
    case "vault": {
      const base = [
        { key: "↑↓", label: "move" },
        { key: "space", label: "select" },
        { key: "/", label: "filter" },
      ];
      if (state.selection.size > 0) base.push({ key: "x", label: "remove" });
      return base;
    }
    case "agents":
      return [
        { key: "↑↓", label: "move" },
        { key: "enter", label: "preview" },
        { key: "d", label: "diff vs vault" },
      ];
    case "migrate":
      return [
        { key: "tab", label: "next field" },
        { key: "P", label: "preview" },
        { key: "A", label: "apply" },
      ];
    case "activity":
      return [{ key: "c", label: "clear" }];
  }
}
