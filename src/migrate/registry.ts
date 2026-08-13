/**
 * src/migrate/registry.ts
 *
 * Maps (from, to, configType) triples to translator functions.
 * Each translator is a pure function registered declaratively — adding new
 * agents requires only new register() calls, not changes to existing translators.
 */

import type { MigrationAgentName } from "./agent-names";
import type { ConfigType, Translator } from "./types";

type RegistryKey = `${MigrationAgentName}\u2192${MigrationAgentName}:${ConfigType}`;

const registry = new Map<RegistryKey, Translator>();

/**
 * Register a translator for a specific (from, to, type) triple.
 * @param from - Source agent name.
 * @param to - Target agent name.
 * @param type - Configuration type to translate.
 * @param fn - Pure function that performs the translation.
 */
export function register(
  from: MigrationAgentName,
  to: MigrationAgentName,
  type: ConfigType,
  fn: Translator,
): void {
  registry.set(`${from}\u2192${to}:${type}`, fn);
}

/**
 * Look up a registered translator for the given migration pair.
 * @returns The translator function, or null if no translator is registered.
 */
export function getTranslator(
  from: MigrationAgentName,
  to: MigrationAgentName,
  type: ConfigType,
): Translator | null {
  return registry.get(`${from}\u2192${to}:${type}`) ?? null;
}

/**
 * List all registered translation pairs, optionally filtered by config type.
 * @param type - If provided, only return pairs matching this config type.
 * @returns Array of registered migration pairs.
 */
export function getSupportedPairs(
  type?: ConfigType,
): Array<{ from: MigrationAgentName; to: MigrationAgentName; type: ConfigType }> {
  return [...registry.keys()]
    .filter((k) => !type || k.endsWith(`:${type}`))
    .map((k) => {
      const [pair, t] = k.split(":");
      const [from, to] = pair.split("\u2192") as [MigrationAgentName, MigrationAgentName];
      return { from, to, type: t as ConfigType };
    });
}

/** Clear all registrations. Intended for testing only. */
export function __clearRegistryForTesting(): void {
  registry.clear();
}

// ── Translator registrations per config type support matrix ──────────────────

import { translateAgent } from "./translators/agents";
import { translateCommand } from "./translators/commands";
import { translateGlobalRules } from "./translators/global-rules";
import { translateMcp } from "./translators/mcp";
import { translateRule } from "./translators/rules";
import { translateSkill } from "./translators/skills";

// Global rules: VS Code excluded.
register("claude", "cursor", "global-rules", translateGlobalRules.claudeToCursor);
register("cursor", "claude", "global-rules", translateGlobalRules.cursorToClaude);
register("claude", "codex", "global-rules", translateGlobalRules.claudeToCodex);
register("codex", "claude", "global-rules", translateGlobalRules.codexToClaude);
register("claude", "copilot", "global-rules", translateGlobalRules.claudeToCopilot);
register("copilot", "claude", "global-rules", translateGlobalRules.copilotToClaude);
register("cursor", "codex", "global-rules", translateGlobalRules.cursorToCodex);
register("codex", "cursor", "global-rules", translateGlobalRules.codexToCursor);
register("cursor", "copilot", "global-rules", translateGlobalRules.cursorToCopilot);
register("copilot", "cursor", "global-rules", translateGlobalRules.copilotToCursor);
register("codex", "copilot", "global-rules", translateGlobalRules.codexToCopilot);
register("copilot", "codex", "global-rules", translateGlobalRules.copilotToCodex);
register("claude", "opencode", "global-rules", translateGlobalRules.claudeToOpenCode);
register("cursor", "opencode", "global-rules", translateGlobalRules.cursorToOpenCode);
register("codex", "opencode", "global-rules", translateGlobalRules.codexToOpenCode);
register("copilot", "opencode", "global-rules", translateGlobalRules.copilotToOpenCode);
register("opencode", "claude", "global-rules", translateGlobalRules.openCodeToClaude);
register("opencode", "cursor", "global-rules", translateGlobalRules.openCodeToCursor);
register("opencode", "codex", "global-rules", translateGlobalRules.openCodeToCodex);
register("opencode", "copilot", "global-rules", translateGlobalRules.openCodeToCopilot);

// MCP: all six migration endpoints.
register("claude", "cursor", "mcp", translateMcp.claudeToCursor);
register("claude", "vscode", "mcp", translateMcp.claudeToVsCode);
register("claude", "codex", "mcp", translateMcp.claudeToCodex);
register("claude", "copilot", "mcp", translateMcp.claudeToCopilot);
register("cursor", "claude", "mcp", translateMcp.cursorToClaude);
register("cursor", "vscode", "mcp", translateMcp.cursorToVsCode);
register("cursor", "codex", "mcp", translateMcp.cursorToCodex);
register("cursor", "copilot", "mcp", translateMcp.cursorToCopilot);
register("vscode", "claude", "mcp", translateMcp.vsCodeToClaude);
register("vscode", "cursor", "mcp", translateMcp.vsCodeToCursor);
register("vscode", "codex", "mcp", translateMcp.vsCodeToCodex);
register("vscode", "copilot", "mcp", translateMcp.vsCodeToCopilot);
register("codex", "claude", "mcp", translateMcp.codexToClaude);
register("codex", "cursor", "mcp", translateMcp.codexToCursor);
register("codex", "vscode", "mcp", translateMcp.codexToVsCode);
register("codex", "copilot", "mcp", translateMcp.codexToCopilot);
register("copilot", "claude", "mcp", translateMcp.copilotToClaude);
register("copilot", "cursor", "mcp", translateMcp.copilotToCursor);
register("copilot", "vscode", "mcp", translateMcp.copilotToVsCode);
register("copilot", "codex", "mcp", translateMcp.copilotToCodex);
register("claude", "opencode", "mcp", translateMcp.claudeToOpenCode);
register("cursor", "opencode", "mcp", translateMcp.cursorToOpenCode);
register("codex", "opencode", "mcp", translateMcp.codexToOpenCode);
register("copilot", "opencode", "mcp", translateMcp.copilotToOpenCode);
register("vscode", "opencode", "mcp", translateMcp.vsCodeToOpenCode);
register("opencode", "claude", "mcp", translateMcp.openCodeToClaude);
register("opencode", "cursor", "mcp", translateMcp.openCodeToCursor);
register("opencode", "codex", "mcp", translateMcp.openCodeToCodex);
register("opencode", "copilot", "mcp", translateMcp.openCodeToCopilot);
register("opencode", "vscode", "mcp", translateMcp.openCodeToVsCode);

// Commands: VS Code excluded.
register("claude", "cursor", "commands", translateCommand.claudeToCursor);
register("cursor", "claude", "commands", translateCommand.cursorToClaude);
register("claude", "codex", "commands", translateCommand.claudeToCodex);
register("cursor", "codex", "commands", translateCommand.cursorToCodex);
register("codex", "claude", "commands", translateCommand.codexToClaude);
register("codex", "cursor", "commands", translateCommand.codexToCursor);
register("claude", "copilot", "commands", translateCommand.claudeToCopilot);
register("cursor", "copilot", "commands", translateCommand.cursorToCopilot);
register("codex", "copilot", "commands", translateCommand.codexToCopilot);
register("copilot", "claude", "commands", translateCommand.copilotToClaude);
register("copilot", "cursor", "commands", translateCommand.copilotToCursor);
register("copilot", "codex", "commands", translateCommand.copilotToCodex);
register("claude", "opencode", "commands", translateCommand.claudeToOpenCode);
register("cursor", "opencode", "commands", translateCommand.cursorToOpenCode);
register("copilot", "opencode", "commands", translateCommand.copilotToOpenCode);
register("opencode", "claude", "commands", translateCommand.openCodeToClaude);
register("opencode", "cursor", "commands", translateCommand.openCodeToCursor);
register("opencode", "codex", "commands", translateCommand.openCodeToCodex);
register("opencode", "copilot", "commands", translateCommand.openCodeToCopilot);

// Skills: VS Code excluded.
register("claude", "cursor", "skills", translateSkill.claudeToCursor);
register("claude", "codex", "skills", translateSkill.claudeToCodex);
register("claude", "copilot", "skills", translateSkill.claudeToCopilot);
register("cursor", "claude", "skills", translateSkill.cursorToClaude);
register("cursor", "codex", "skills", translateSkill.cursorToCodex);
register("cursor", "copilot", "skills", translateSkill.cursorToCopilot);
register("codex", "claude", "skills", translateSkill.codexToClaude);
register("codex", "cursor", "skills", translateSkill.codexToCursor);
register("codex", "copilot", "skills", translateSkill.codexToCopilot);
register("copilot", "claude", "skills", translateSkill.copilotToClaude);
register("copilot", "cursor", "skills", translateSkill.copilotToCursor);
register("copilot", "codex", "skills", translateSkill.copilotToCodex);
register("claude", "opencode", "skills", translateSkill.claudeToOpenCode);
register("cursor", "opencode", "skills", translateSkill.cursorToOpenCode);
register("codex", "opencode", "skills", translateSkill.codexToOpenCode);
register("copilot", "opencode", "skills", translateSkill.copilotToOpenCode);
register("opencode", "claude", "skills", translateSkill.openCodeToClaude);
register("opencode", "cursor", "skills", translateSkill.openCodeToCursor);
register("opencode", "codex", "skills", translateSkill.openCodeToCodex);
register("opencode", "copilot", "skills", translateSkill.openCodeToCopilot);

// Rules (3-way passthrough: Claude, Cursor, Codex — Copilot/VS Code workspace-only)
register("claude", "cursor", "rules", translateRule.claudeToCursor);
register("claude", "codex", "rules", translateRule.claudeToCodex);
register("cursor", "claude", "rules", translateRule.cursorToClaude);
register("cursor", "codex", "rules", translateRule.cursorToCodex);
register("codex", "claude", "rules", translateRule.codexToClaude);
register("codex", "cursor", "rules", translateRule.codexToCursor);

// Agents: Copilot represents the shared Copilot/VS Code physical store.
register("claude", "cursor", "agents", translateAgent.claudeToCursor);
register("claude", "codex", "agents", translateAgent.claudeToCodex);
register("claude", "copilot", "agents", translateAgent.claudeToCopilot);
register("cursor", "claude", "agents", translateAgent.cursorToClaude);
register("cursor", "codex", "agents", translateAgent.cursorToCodex);
register("cursor", "copilot", "agents", translateAgent.cursorToCopilot);
register("codex", "claude", "agents", translateAgent.codexToClaude);
register("codex", "cursor", "agents", translateAgent.codexToCursor);
register("codex", "copilot", "agents", translateAgent.codexToCopilot);
register("copilot", "claude", "agents", translateAgent.copilotToClaude);
register("copilot", "cursor", "agents", translateAgent.copilotToCursor);
register("copilot", "codex", "agents", translateAgent.copilotToCodex);
register("claude", "opencode", "agents", translateAgent.claudeToOpenCode);
register("cursor", "opencode", "agents", translateAgent.cursorToOpenCode);
register("codex", "opencode", "agents", translateAgent.codexToOpenCode);
register("copilot", "opencode", "agents", translateAgent.copilotToOpenCode);
register("opencode", "claude", "agents", translateAgent.openCodeToClaude);
register("opencode", "cursor", "agents", translateAgent.openCodeToCursor);
register("opencode", "codex", "agents", translateAgent.openCodeToCodex);
register("opencode", "copilot", "agents", translateAgent.openCodeToCopilot);
