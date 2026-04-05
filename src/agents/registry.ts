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

/** Common contract that every agent adapter must satisfy. */
export interface AgentDefinition {
  name: AgentName;
  snapshot: () => Promise<SnapshotResult>;
  /**
   * Decrypt vault artifacts and apply them to the local machine.
   * This is the counterpart to `snapshot()` and drives the pull pipeline.
   */
  apply: (vaultDir: string, key: string, dryRun: boolean) => Promise<void>;
}

/** Ordered registry used by commands to iterate over every supported agent adapter. */
export const Agents: AgentDefinition[] = [
  {
    name: "claude",
    snapshot: snapshotClaude as () => Promise<SnapshotResult>,
    apply: applyClaudeVault,
  },
  {
    name: "cursor",
    snapshot: snapshotCursor as () => Promise<SnapshotResult>,
    apply: applyCursorVault,
  },
  {
    name: "codex",
    snapshot: snapshotCodex as () => Promise<SnapshotResult>,
    apply: applyCodexVault,
  },
  {
    name: "copilot",
    snapshot: snapshotCopilot as () => Promise<SnapshotResult>,
    apply: applyCopilotVault,
  },
  {
    name: "vscode",
    snapshot: snapshotVsCode as () => Promise<SnapshotResult>,
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
