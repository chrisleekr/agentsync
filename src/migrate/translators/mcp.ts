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
import { z } from "zod";
import type { Translator } from "../types";

interface McpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
});

const JsonMcpSchema = z.object({
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
});

const TomlMcpSchema = z.object({
  mcp: z
    .object({
      servers: z.record(z.string(), McpServerSchema).default({}),
    })
    .default({ servers: {} }),
});

// ── JSON parsing (Claude, Cursor, VS Code) ───────────────────────────────────

function parseJsonMcp(raw: string): McpServer[] {
  const parsed = JsonMcpSchema.parse(JSON.parse(raw));
  return Object.entries(parsed.mcpServers).map(([name, cfg]) => ({
    name,
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
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
  // Round-trip through JSON to convert TOML's special array/integer types to plain JS objects
  const parsed = TomlMcpSchema.parse(JSON.parse(JSON.stringify(TOML.parse(raw))));
  return Object.entries(parsed.mcp.servers).map(([name, cfg]) => ({
    name,
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
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
