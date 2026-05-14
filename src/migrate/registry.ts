/**
 * src/migrate/registry.ts
 *
 * Maps (from, to, configType) triples to translator functions.
 * Each translator is a pure function registered declaratively — adding new
 * agents requires only new register() calls, not changes to existing translators.
 */

import type { AgentName } from "../agents/registry";
import type { ConfigType, Translator } from "./types";

type RegistryKey = `${AgentName}\u2192${AgentName}:${ConfigType}`;

const registry = new Map<RegistryKey, Translator>();

/**
 * Register a translator for a specific (from, to, type) triple.
 * @param from - Source agent name.
 * @param to - Target agent name.
 * @param type - Configuration type to translate.
 * @param fn - Pure function that performs the translation.
 */
export function register(from: AgentName, to: AgentName, type: ConfigType, fn: Translator): void {
  registry.set(`${from}\u2192${to}:${type}`, fn);
}

/**
 * Look up a registered translator for the given migration pair.
 * @returns The translator function, or null if no translator is registered.
 */
export function getTranslator(from: AgentName, to: AgentName, type: ConfigType): Translator | null {
  return registry.get(`${from}\u2192${to}:${type}`) ?? null;
}

/**
 * List all registered translation pairs, optionally filtered by config type.
 * @param type - If provided, only return pairs matching this config type.
 * @returns Array of registered migration pairs.
 */
export function getSupportedPairs(
  type?: ConfigType,
): Array<{ from: AgentName; to: AgentName; type: ConfigType }> {
  return [...registry.keys()]
    .filter((k) => !type || k.endsWith(`:${type}`))
    .map((k) => {
      const [pair, t] = k.split(":");
      const [from, to] = pair.split("\u2192") as [AgentName, AgentName];
      return { from, to, type: t as ConfigType };
    });
}

/** Clear all registrations. Intended for testing only. */
export function __clearRegistryForTesting(): void {
  registry.clear();
}

// ── Translator registrations per config type support matrix ──────────────────

import { translateCommand } from "./translators/commands";
import { translateGlobalRules } from "./translators/global-rules";
import { translateMcp } from "./translators/mcp";
import { translateRule } from "./translators/rules";
import { translateSkill } from "./translators/skills";

// Global Rules (4 agents: Claude, Cursor, Codex, Copilot — VS Code excluded)
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

// MCP (5 agents: Claude, Cursor, Codex, VS Code, Copilot CLI)
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

// Commands (4 agents: Claude, Cursor, Codex, Copilot — VS Code excluded)
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

// Skills (4 skill-bearing agents: Claude, Cursor, Codex, Copilot CLI — VS Code excluded)
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

// Rules (3-way passthrough: Claude, Cursor, Codex — Copilot/VS Code workspace-only)
register("claude", "cursor", "rules", translateRule.claudeToCursor);
register("claude", "codex", "rules", translateRule.claudeToCodex);
register("cursor", "claude", "rules", translateRule.cursorToClaude);
register("cursor", "codex", "rules", translateRule.cursorToCodex);
register("codex", "claude", "rules", translateRule.codexToClaude);
register("codex", "cursor", "rules", translateRule.codexToCursor);
