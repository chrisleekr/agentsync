/** Agent endpoints supported by local cross-agent migration. */
export const MIGRATION_AGENTS = [
  "claude",
  "cursor",
  "codex",
  "copilot",
  "vscode",
  "opencode",
] as const;

export type MigrationAgentName = (typeof MIGRATION_AGENTS)[number];
