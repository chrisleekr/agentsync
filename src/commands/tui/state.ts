import type { DaemonStatus } from "../../config/schema";
import type { SyncRow } from "../status";

export const TAB_IDS = ["dashboard", "sync", "migrate", "activity"] as const;
export type TabId = (typeof TAB_IDS)[number];

export const AGENTS = ["claude", "cursor", "codex", "copilot", "vscode"] as const;
export type AgentName = (typeof AGENTS)[number];

export const MIGRATE_TYPES = ["global-rules", "mcp", "commands", "skills", "rules"] as const;
export type ConfigType = (typeof MIGRATE_TYPES)[number];

export type MigrateField = "from" | "to" | "type" | "preview" | "apply";

export interface ActivityEntry {
  ts: Date;
  kind: "push" | "pull" | "skill-rm" | "migrate" | "preview" | "error" | "info";
  status: "ok" | "fail" | "running" | "info";
  message: string;
}

export interface DaemonState {
  online: boolean;
  status: DaemonStatus | null;
  lastError: string | null;
  pidObservedAt: number | null;
}

export type OpKind = "push" | "pull" | "migrate" | "migrate-preview" | "skill-rm" | "sync-load";

export type OpPhase = "running" | "ok" | "error";

export interface OperationStatus {
  id: string;
  kind: OpKind;
  label: string;
  startedAt: number;
  finishedAt: number | null;
  phase: OpPhase;
  error: string | null;
  meta: Record<string, unknown>;
}

export type LoadablePhase = "idle" | "loading" | "ready" | "error";

/** Three-state key prompt for the Sync tab. `idle` = no prompt has been
 *  shown yet on this tab visit; `pending` = modal is up; `skipped` = user
 *  pressed `n`, banner is shown and statuses are `unknown`. */
export type KeyPromptState = "idle" | "pending" | "skipped";

/** Last push/pull result kept visible until the next op so the user can
 *  always see why a previous action did or didn't change the state.
 *  Toasts expire too fast for users to read terminal-error messages. */
export interface LastOpResult {
  kind: "push" | "pull";
  status: "running" | "ok" | "error";
  /** Short summary — first line of the banner. */
  message: string;
  /** Optional per-issue breakdown rendered one-per-line under the message.
   *  Used for secret-detection errors so the user can see exactly which
   *  files need attention without the message getting truncated. */
  details?: string[];
  ts: number;
}

/** Pending skill-remove confirmation. The modal lists exactly which skill
 *  vault entries are about to be removed and how many non-skill selections
 *  are being ignored, so the user can't `x` and lose data without seeing
 *  what's at stake first. */
export interface ConfirmRemove {
  items: { agent: string; name: string; vaultPath: string }[];
  ignoredCount: number;
  /** How many items are currently in `navigableRows` (i.e. visible on the
   *  screen at stage time). The difference between `items.length` and this
   *  reveals stale selections from hidden / collapsed sections that the user
   *  may have forgotten about. */
  visibleCount: number;
}

/** A single file inside an open skill bundle, paired across vault + local
 *  with per-file sync status. Plaintext lives ONLY here for the duration
 *  the drill-in panel is open — closing it drops every body. */
export interface SkillFile {
  /** POSIX-style relative path inside the bundle. */
  relPath: string;
  status: "synced" | "local-changed" | "local-only" | "vault-only";
  /** UTF-8 decoded body when text, or null for vault-only / binary. */
  vaultText: string | null;
  /** UTF-8 decoded body when text, or null for local-only / binary. */
  localText: string | null;
  /** True if either side decoded as non-UTF-8 — diff is suppressed. */
  isBinary: boolean;
}

/** Open skill-bundle drill-in: per-file listing of the skill the user
 *  drilled into. Survives the diff modal so closing diff returns here. */
export interface SkillDrillInState {
  /** The originating skill row's vaultPath — used as the header label. */
  vaultPath: string;
  /** Pretty bundle name (basename without `.tar.age`). */
  bundleName: string;
  files: SkillFile[];
  cursor: number;
  scrollOffset: number;
}

/** Live state of the open diff modal: both plaintexts (for re-pairing
 *  rows on render), the cursor row, which side it's on, and per-side
 *  line selections for clipboard copy. Plaintext lives ONLY here for the
 *  duration the modal is open. */
export interface DiffModalState {
  vaultPath: string;
  vaultPlain: string;
  localPlain: string;
  /** Cursor row in the diff's paired-row array. */
  cursor: number;
  /** Which side the cursor + space-select is currently operating on. */
  side: "vault" | "local";
  /** Selected vault-side line numbers (1-based, source-of-truth indices
   *  in vaultPlain). */
  selectedVault: Set<number>;
  selectedLocal: Set<number>;
  /** Scroll offset into the paired-row array. */
  scrollOffset: number;
}

export interface SyncSlice {
  phase: LoadablePhase;
  rows: SyncRow[];
  cursor: number;
  error: string | null;
  /** Whether `privateKey` is cached on the slice (string itself lives in
   *  `keyCache`; we never expose it via getState beyond the loader). */
  keyLoaded: boolean;
  keyCache: string | null;
  keyPrompt: KeyPromptState;
  /** Open diff modal — null when closed. Plaintext lives only here for the
   *  duration the modal is open; closing the modal drops it. */
  diff: DiffModalState | null;
  /** Open skill drill-in — null when closed. Plaintext for every file in
   *  the bundle lives only here for the duration; closing the panel drops
   *  every body. */
  skillDrillIn: SkillDrillInState | null;
  /** Monotonic counter incremented every time a drill-in open is requested
   *  or cancelled. The async decrypt path captures the value at request
   *  time and refuses to dispatch its result if the counter has moved on,
   *  so rapid double-Enter or Enter-then-Esc cannot leak a stale plaintext
   *  buffer back into state. */
  skillDrillInRequestSeq: number;
  /** Whether the SYNCED section is expanded. Default false — synced rows
   *  collapse into a count line because the user came here to find drift. */
  showSynced: boolean;
  /** Persistent result of the most recent push or pull. Null until first op. */
  lastOp: LastOpResult | null;
  /** First visible line index in the rendered output. Updated explicitly by
   *  PageUp/PageDown/Home/End; cursor up/down lets render auto-follow. */
  scrollOffset: number;
  /** Open confirmation modal for `x` (skill remove). Null when no remove
   *  is pending. y proceeds, n/esc cancels. */
  confirmRemove: ConfirmRemove | null;
}

export interface MigrateSlice {
  from: AgentName;
  toSet: Set<AgentName>;
  /** Sub-cursor inside the `to` field — indexes into AGENTS. Arrows move
   *  this; space toggles `toSet[toCursor]`. Makes multi-select behaviour
   *  predictable (HTML-checkbox semantics, not "toggle last added"). */
  toCursor: number;
  /** Multi-select set of config types to migrate. Replaces the old single
   *  `type` field so the user can migrate e.g. commands + rules in one op. */
  typeSet: Set<ConfigType>;
  /** Sub-cursor inside the `type` field — same role as `toCursor`. */
  typeCursor: number;
  field: MigrateField;
  preview: string;
  previewKey: string | null;
  appliedSignature: string | null;
}

export interface ContextAction {
  key: string;
  label: string;
}

export interface AppState {
  activeTab: TabId;
  daemon: DaemonState;
  activity: ActivityEntry[];
  selection: Set<string>;
  toast: { text: string; level: "info" | "success" | "error"; expiresAt: number } | null;
  /** Most recently pressed action key, flashed briefly in the action bars. */
  keyHint: { key: string; expiresAt: number } | null;
  helpOpen: boolean;
  sync: SyncSlice;
  migrate: MigrateSlice;
  inFlight: Record<string, OperationStatus>;
  opSeq: number;
}

const MAX_ACTIVITY = 200;

export function createInitialState(): AppState {
  return {
    activeTab: "dashboard",
    daemon: {
      online: false,
      status: null,
      lastError: null,
      pidObservedAt: null,
    },
    activity: [],
    selection: new Set<string>(),
    toast: null,
    keyHint: null,
    helpOpen: false,
    sync: {
      phase: "idle",
      rows: [],
      cursor: 0,
      error: null,
      keyLoaded: false,
      keyCache: null,
      keyPrompt: "idle",
      diff: null,
      skillDrillIn: null,
      skillDrillInRequestSeq: 0,
      showSynced: false,
      lastOp: null,
      scrollOffset: 0,
      confirmRemove: null,
    },
    migrate: {
      from: "claude",
      toSet: new Set<AgentName>(["cursor"]),
      toCursor: 0,
      typeSet: new Set<ConfigType>(["global-rules"]),
      typeCursor: 0,
      field: "from",
      preview: "",
      previewKey: null,
      appliedSignature: null,
    },
    inFlight: {},
    opSeq: 0,
  };
}

export function pushActivity(state: AppState, entry: Omit<ActivityEntry, "ts">): void {
  state.activity.unshift({ ...entry, ts: new Date() });
  if (state.activity.length > MAX_ACTIVITY) state.activity.length = MAX_ACTIVITY;
}

export function setToast(
  state: AppState,
  text: string,
  level: "info" | "success" | "error" = "info",
  ttlMs = 3000,
): void {
  state.toast = { text, level, expiresAt: Date.now() + ttlMs };
}

/** Record an action keypress so the bars can flash the pressed key. The TTL
 *  is short so it reads as "just pressed", not a sticky indicator. */
export function setKeyHint(state: AppState, key: string, ttlMs = 450): void {
  state.keyHint = { key, expiresAt: Date.now() + ttlMs };
}

export function migrateSignature(m: MigrateSlice): string {
  const types = [...m.typeSet].sort().join("+");
  return `${m.from}→${[...m.toSet].sort().join("+")}@${types}`;
}

export function countRunning(state: AppState): number {
  let n = 0;
  for (const id in state.inFlight) {
    if (state.inFlight[id].phase === "running") n++;
  }
  return n;
}
