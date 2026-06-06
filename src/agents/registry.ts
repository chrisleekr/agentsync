import type { AgentSyncConfig } from "../config/schema";
import type { ApplyPlan } from "./_apply";
import type { SnapshotArtifact, SnapshotResult } from "./_utils";
import type { ClaudeSnapshotResult } from "./claude";
import { applyClaudeVault, buildClaudePlan, snapshotClaude } from "./claude";
import type { CodexSnapshotResult } from "./codex";
import { applyCodexVault, buildCodexPlan, snapshotCodex } from "./codex";
import type { CopilotSnapshotResult } from "./copilot";
import { applyCopilotVault, buildCopilotPlan, snapshotCopilot } from "./copilot";
import type { CursorSnapshotResult } from "./cursor";
import { applyCursorVault, buildCursorPlan, snapshotCursor } from "./cursor";
import type { VsCodeSnapshotResult } from "./vscode";
import { applyVsCodeVault, buildVsCodePlan, snapshotVsCode } from "./vscode";

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
  /**
   * Build this agent's declarative {@link ApplyPlan} without running it. The
   * `copy` command uses it with `applySingleArtifact` to apply one artifact
   * from another machine's namespace, reusing the same handlers as `apply`.
   */
  buildPlan: (config: AgentSyncConfig) => ApplyPlan;
}

/** Ordered registry used by commands to iterate over every supported agent adapter. */
export const Agents: AgentDefinition[] = [
  {
    name: "claude",
    snapshot: snapshotClaude,
    apply: applyClaudeVault,
    buildPlan: buildClaudePlan,
  },
  {
    name: "cursor",
    snapshot: snapshotCursor,
    apply: applyCursorVault,
    buildPlan: buildCursorPlan,
  },
  {
    name: "codex",
    snapshot: snapshotCodex,
    apply: applyCodexVault,
    buildPlan: buildCodexPlan,
  },
  {
    name: "copilot",
    snapshot: snapshotCopilot,
    apply: applyCopilotVault,
    buildPlan: buildCopilotPlan,
  },
  {
    name: "vscode",
    snapshot: snapshotVsCode,
    apply: applyVsCodeVault,
    buildPlan: buildVsCodePlan,
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
