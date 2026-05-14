import type { AgentSyncConfig } from "../config/schema";
import type { SnapshotArtifact, SnapshotResult } from "./_utils";
import type { ClaudeSnapshotResult } from "./claude";
import { applyClaudeVault, snapshotClaude } from "./claude";
import type { CodexSnapshotResult } from "./codex";
import { applyCodexVault, snapshotCodex } from "./codex";
import type { CopilotSnapshotResult } from "./copilot";
import { applyCopilotVault, snapshotCopilot } from "./copilot";
import type { CursorSnapshotResult } from "./cursor";
import { applyCursorVault, snapshotCursor } from "./cursor";
import type { VsCodeSnapshotResult } from "./vscode";
import { applyVsCodeVault, snapshotVsCode } from "./vscode";

/** Supported agent adapters that can snapshot to and restore from the vault. */
export type AgentName = "cursor" | "claude" | "codex" | "copilot" | "vscode";

// Re-export canonical snapshot types so callers only need to import from registry.
export type { SnapshotArtifact, SnapshotResult };

/**
 * Common contract that every agent adapter must satisfy.
 *
 * `config` carries the validated `agentsync.toml`. Most adapters ignore it;
 * adapters with opt-in behaviour read their own section (e.g. claude reads
 * `config.claudePlugins.syncMarketplace`). Threading the full config through
 * the contract keeps push/pull from special-casing any single agent.
 */
export interface AgentDefinition {
  name: AgentName;
  snapshot: (config: AgentSyncConfig) => Promise<SnapshotResult>;
  /**
   * Decrypt vault artifacts and apply them to the local machine.
   * This is the counterpart to `snapshot()` and drives the pull pipeline.
   */
  apply: (vaultDir: string, key: string, dryRun: boolean, config: AgentSyncConfig) => Promise<void>;
}

/** Ordered registry used by commands to iterate over every supported agent adapter. */
export const Agents: AgentDefinition[] = [
  {
    name: "claude",
    snapshot: snapshotClaude,
    apply: applyClaudeVault,
  },
  {
    name: "cursor",
    snapshot: snapshotCursor,
    apply: applyCursorVault,
  },
  {
    name: "codex",
    snapshot: snapshotCodex,
    apply: applyCodexVault,
  },
  {
    name: "copilot",
    snapshot: snapshotCopilot,
    apply: applyCopilotVault,
  },
  {
    name: "vscode",
    snapshot: snapshotVsCode,
    apply: applyVsCodeVault,
  },
];

// Re-export narrow types for callers that care about the specific shape
export type {
  ClaudeSnapshotResult,
  CodexSnapshotResult,
  CopilotSnapshotResult,
  CursorSnapshotResult,
  VsCodeSnapshotResult,
};
