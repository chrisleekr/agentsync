/**
 * src/migrate/translators/mcp.ts
 *
 * Pairwise translators for MCP server configurations.
 * Claude/Cursor/VS Code use JSON { mcpServers: { name: { command, args, env } } }.
 * Codex uses TOML [mcp.servers.name] with the same logical fields.
 * The McpServer[] intermediate representation bridges the two formats.
 *
 * Secret detection is handled by the orchestrator, NOT the translators.
 * Translators are pure format converters.
 */

import * as TOML from "@iarna/toml";
import type { Translator } from "../types";

interface McpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// ── JSON parsing (Claude, Cursor, VS Code) ───────────────────────────────────

function parseJsonMcp(raw: string): McpServer[] {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const servers = (parsed.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(servers).map(([name, cfg]) => ({
    name,
    command: cfg.command as string,
    args: (cfg.args as string[] | undefined) ?? [],
    env: (cfg.env as Record<string, string> | undefined) ?? {},
  }));
}

function serializeJsonMcp(servers: McpServer[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = { command: s.command, args: s.args, env: s.env };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

// ── TOML parsing (Codex) ─────────────────────────────────────────────────────

function parseTomlMcp(raw: string): McpServer[] {
  const parsed = TOML.parse(raw) as Record<string, unknown>;
  const mcp = (parsed.mcp ?? {}) as Record<string, unknown>;
  const servers = (mcp.servers ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(servers).map(([name, cfg]) => ({
    name,
    command: cfg.command as string,
    args: (cfg.args as string[] | undefined) ?? [],
    env: (cfg.env as Record<string, string> | undefined) ?? {},
  }));
}

function serializeTomlMcp(servers: McpServer[], existingToml?: string): string {
  let base: TOML.JsonMap = {};
  if (existingToml) {
    try {
      base = TOML.parse(existingToml);
    } catch {
      /* ignore corrupt TOML — start fresh */
    }
  }
  const mcp = (base.mcp ?? {}) as TOML.JsonMap;
  const serverMap: TOML.JsonMap = {};
  for (const s of servers) {
    serverMap[s.name] = {
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
    };
  }
  mcp.servers = serverMap;
  base.mcp = mcp;
  return TOML.stringify(base);
}

// ── Translator functions ─────────────────────────────────────────────────────

const jsonToJson: Translator = (raw) => {
  try {
    const servers = parseJsonMcp(raw);
    if (servers.length === 0) return null;
    return { content: serializeJsonMcp(servers), targetName: "mcp.json" };
  } catch {
    return null;
  }
};

const jsonToToml: Translator = (raw) => {
  try {
    const servers = parseJsonMcp(raw);
    if (servers.length === 0) return null;
    return { content: serializeTomlMcp(servers), targetName: "config.toml" };
  } catch {
    return null;
  }
};

const tomlToJson: Translator = (raw) => {
  try {
    const servers = parseTomlMcp(raw);
    if (servers.length === 0) return null;
    return { content: serializeJsonMcp(servers), targetName: "mcp.json" };
  } catch {
    return null;
  }
};

/**
 * All MCP translators indexed by direction for registry registration.
 * Each function parses source MCP config (JSON or TOML), extracts McpServer[] intermediate
 * representation, and serialises to the target format.
 */
export const translateMcp = {
  claudeToCursor: jsonToJson,
  claudeToVsCode: jsonToJson,
  cursorToClaude: jsonToJson,
  cursorToVsCode: jsonToJson,
  vsCodeToClaude: jsonToJson,
  vsCodeToCursor: jsonToJson,
  claudeToCodex: jsonToToml,
  cursorToCodex: jsonToToml,
  vsCodeToCodex: jsonToToml,
  codexToClaude: tomlToJson,
  codexToCursor: tomlToJson,
  codexToVsCode: tomlToJson,
};
