import type { DaemonStatus } from "../../config/schema";

export const TAB_IDS = ["dashboard", "vault", "agents", "migrate", "activity"] as const;
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

export type OpKind =
  | "push"
  | "pull"
  | "migrate"
  | "migrate-preview"
  | "skill-rm"
  | "vault-load"
  | "agents-load";

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

export interface VaultEntry {
  agent: string;
  path: string;
  absolutePath: string;
  size: number;
  isSkill: boolean;
}

export interface VaultSlice {
  phase: LoadablePhase;
  entries: VaultEntry[];
  cursor: number;
  error: string | null;
}

export interface AgentFile {
  rel: string;
  size: number;
  mtime: number;
}

export interface AgentNode {
  agent: string;
  baseDir: string;
  installed: boolean;
  files: AgentFile[];
}

export interface AgentsSlice {
  phase: LoadablePhase;
  nodes: AgentNode[];
  cursor: number;
  error: string | null;
}

export interface MigrateSlice {
  from: AgentName;
  toSet: Set<AgentName>;
  type: ConfigType;
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
  helpOpen: boolean;
  vault: VaultSlice;
  agents: AgentsSlice;
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
    helpOpen: false,
    vault: { phase: "idle", entries: [], cursor: 0, error: null },
    agents: { phase: "idle", nodes: [], cursor: 0, error: null },
    migrate: {
      from: "claude",
      toSet: new Set<AgentName>(["cursor"]),
      type: "global-rules",
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

export function migrateSignature(m: MigrateSlice): string {
  return `${m.from}→${[...m.toSet].sort().join("+")}@${m.type}`;
}

export function countRunning(state: AppState): number {
  let n = 0;
  for (const id in state.inFlight) {
    if (state.inFlight[id].phase === "running") n++;
  }
  return n;
}
