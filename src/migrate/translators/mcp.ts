/**
 * src/migrate/translators/mcp.ts
 *
 * Pairwise translators for MCP server configurations.
 *
 * The MCP ecosystem is no longer stdio-only: VS Code, the MCP spec, and the
 * authorization spec now describe both stdio and Streamable HTTP transports
 * with auth/discovery metadata. AgentSync therefore parses each source
 * format into a transport-aware intermediate model (`McpModel`) before
 * serialising to the target shape. Where a target cannot represent a
 * transport (e.g. Claude/Cursor JSON is stdio-only today), the translator
 * emits an explicit warning naming the dropped server rather than silently
 * losing the field.
 *
 * VS Code reads top-level `servers` + `inputs` per its current docs.
 * Claude/Cursor read top-level `mcpServers` (stdio-only).
 * Codex reads TOML `[mcp.servers.*]` tables; non-stdio metadata is preserved
 * as structured TOML so HTTP/SSE configs survive a round-trip.
 *
 * Secret detection is handled by the orchestrator, NOT the translators.
 * Translators are pure format converters.
 */

import * as TOML from "@iarna/toml";
import { z } from "zod";
import type { Translator } from "../types";

// ── Intermediate model (transport-aware) ─────────────────────────────────────

export type McpTransport = "stdio" | "http" | "sse";

interface McpServerCommon {
  name: string;
  /** Shared optional metadata that several transports/agents may preserve. */
  envFile?: string;
  sandboxEnabled?: boolean;
  sandbox?: unknown;
  dev?: unknown;
  /** Unknown-but-known fields preserved verbatim for round-tripping. */
  extras?: Record<string, unknown>;
}

export interface McpStdioServer extends McpServerCommon {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpRemoteServer extends McpServerCommon {
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  /** Transport-level auth (OAuth-style discovery, bearer token shape, etc.). */
  auth?: unknown;
}

export type McpServer = McpStdioServer | McpRemoteServer;

/**
 * VS Code-style top-level `inputs` placeholders. Other agents do not consume
 * these today; they are preserved when the target is VS Code and dropped
 * (with a warning) otherwise.
 */
export interface McpInput {
  id: string;
  type?: string;
  description?: string;
  password?: boolean;
  /** Any additional VS Code-specific keys we preserve verbatim. */
  extras?: Record<string, unknown>;
}

interface McpModel {
  servers: McpServer[];
  inputs: McpInput[];
}

// ── Zod helpers (single-server validation) ───────────────────────────────────

const ZRecordString = z.record(z.string(), z.string());

const ZStdioServer = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: ZRecordString.optional(),
  envFile: z.string().optional(),
  sandbox: z.unknown().optional(),
  sandboxEnabled: z.boolean().optional(),
  dev: z.unknown().optional(),
});

const ZHttpServer = z.object({
  type: z.union([z.literal("http"), z.literal("sse")]),
  url: z.string().min(1),
  headers: ZRecordString.optional(),
  auth: z.unknown().optional(),
  envFile: z.string().optional(),
  sandbox: z.unknown().optional(),
  sandboxEnabled: z.boolean().optional(),
  dev: z.unknown().optional(),
});

// Reserved keys that we map into the typed McpServer fields. Anything else
// goes into `extras` so we can round-trip it.
const STDIO_KNOWN_KEYS = new Set([
  "type",
  "command",
  "args",
  "env",
  "envFile",
  "sandbox",
  "sandboxEnabled",
  "dev",
]);

const HTTP_KNOWN_KEYS = new Set([
  "type",
  "url",
  "headers",
  "auth",
  "envFile",
  "sandbox",
  "sandboxEnabled",
  "dev",
]);

function pickExtras(
  raw: Record<string, unknown>,
  known: Set<string>,
): Record<string, unknown> | undefined {
  const extras: Record<string, unknown> = {};
  let any = false;
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) {
      extras[k] = v;
      any = true;
    }
  }
  return any ? extras : undefined;
}

function parseSingleServer(name: string, raw: unknown): McpServer | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const declared = obj.type;
  const isHttpish = declared === "http" || declared === "sse";

  if (isHttpish) {
    const parsed = ZHttpServer.safeParse(obj);
    if (!parsed.success) return null;
    const server: McpRemoteServer = {
      name,
      transport: parsed.data.type,
      url: parsed.data.url,
      headers: parsed.data.headers,
      auth: parsed.data.auth,
      envFile: parsed.data.envFile,
      sandbox: parsed.data.sandbox,
      sandboxEnabled: parsed.data.sandboxEnabled,
      dev: parsed.data.dev,
      extras: pickExtras(obj, HTTP_KNOWN_KEYS),
    };
    return server;
  }

  const parsed = ZStdioServer.safeParse(obj);
  if (!parsed.success) return null;
  const server: McpStdioServer = {
    name,
    transport: "stdio",
    command: parsed.data.command,
    args: parsed.data.args,
    env: parsed.data.env,
    envFile: parsed.data.envFile,
    sandbox: parsed.data.sandbox,
    sandboxEnabled: parsed.data.sandboxEnabled,
    dev: parsed.data.dev,
    extras: pickExtras(obj, STDIO_KNOWN_KEYS),
  };
  return server;
}

function parseInputs(raw: unknown): McpInput[] {
  if (!Array.isArray(raw)) return [];
  const out: McpInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id.length === 0) continue;
    const knownInputKeys = new Set(["id", "type", "description", "password"]);
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!knownInputKeys.has(k)) extras[k] = v;
    }
    out.push({
      id: obj.id,
      type: typeof obj.type === "string" ? obj.type : undefined,
      description: typeof obj.description === "string" ? obj.description : undefined,
      password: typeof obj.password === "boolean" ? obj.password : undefined,
      extras: Object.keys(extras).length > 0 ? extras : undefined,
    });
  }
  return out;
}

// ── Source parsers ───────────────────────────────────────────────────────────

/**
 * Parse VS Code's documented `mcp.json` shape: top-level `servers` + optional
 * `inputs`. Falls back to the legacy `{ mcpServers: ... }` JSON shape so
 * vault-round-trip fixtures continue to load.
 */
function parseVsCodeMcp(raw: string): McpModel {
  const root = JSON.parse(raw) as Record<string, unknown>;
  const out: McpModel = { servers: [], inputs: [] };

  if (root.servers && typeof root.servers === "object") {
    for (const [name, cfg] of Object.entries(root.servers as Record<string, unknown>)) {
      const server = parseSingleServer(name, cfg);
      if (server) out.servers.push(server);
    }
    out.inputs = parseInputs(root.inputs);
    return out;
  }

  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, cfg] of Object.entries(root.mcpServers as Record<string, unknown>)) {
      const server = parseSingleServer(name, cfg);
      if (server) out.servers.push(server);
    }
  }
  return out;
}

/** Parse Claude/Cursor `mcp.json`: top-level `mcpServers`. */
function parseMcpServersJson(raw: string): McpModel {
  const root = JSON.parse(raw) as Record<string, unknown>;
  const out: McpModel = { servers: [], inputs: [] };
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, cfg] of Object.entries(root.mcpServers as Record<string, unknown>)) {
      const server = parseSingleServer(name, cfg);
      if (server) out.servers.push(server);
    }
  }
  return out;
}

/**
 * Parse Codex `config.toml` MCP tables. Tables under `[mcp.servers.<name>]`
 * may carry stdio-only fields (the historical shape) or transport-aware
 * fields (`type`, `url`, `headers`, `auth`) populated by AgentSync writes.
 */
function parseCodexMcp(raw: string): McpModel {
  const root = JSON.parse(JSON.stringify(TOML.parse(raw))) as Record<string, unknown>;
  const out: McpModel = { servers: [], inputs: [] };
  const mcp = (root.mcp ?? {}) as Record<string, unknown>;
  const servers = (mcp.servers ?? {}) as Record<string, unknown>;
  for (const [name, cfg] of Object.entries(servers)) {
    const server = parseSingleServer(name, cfg);
    if (server) out.servers.push(server);
  }
  return out;
}

// ── Target serialisers ───────────────────────────────────────────────────────

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Serialise the model to VS Code's `mcp.json` shape: top-level `servers`
 * + `inputs`. Each server is written with the transport-specific fields it
 * carries; unknown-but-preserved keys are merged back from `extras`.
 */
function serializeVsCodeMcp(model: McpModel): string {
  const servers: Record<string, unknown> = {};
  for (const s of model.servers) {
    let entry: Record<string, unknown>;
    if (s.transport === "stdio") {
      entry = {
        type: "stdio",
        command: s.command,
        args: s.args,
        env: s.env,
        envFile: s.envFile,
        sandbox: s.sandbox,
        sandboxEnabled: s.sandboxEnabled,
        dev: s.dev,
      };
    } else {
      entry = {
        type: s.transport,
        url: s.url,
        headers: s.headers,
        auth: s.auth,
        envFile: s.envFile,
        sandbox: s.sandbox,
        sandboxEnabled: s.sandboxEnabled,
        dev: s.dev,
      };
    }
    entry = stripUndefined(entry);
    if (s.extras) {
      for (const [k, v] of Object.entries(s.extras)) {
        if (!(k in entry)) entry[k] = v;
      }
    }
    servers[s.name] = entry;
  }
  const root: Record<string, unknown> = { servers };
  if (model.inputs.length > 0) {
    root.inputs = model.inputs.map((i) =>
      stripUndefined({
        id: i.id,
        type: i.type,
        description: i.description,
        password: i.password,
        ...(i.extras ?? {}),
      }),
    );
  }
  return `${JSON.stringify(root, null, 2)}\n`;
}

/**
 * Serialise to Claude/Cursor `mcp.json` shape. These clients only support
 * stdio today, so any HTTP/SSE server is dropped and named in a warning.
 * Stdio-only metadata that the schema does not represent (envFile, sandbox,
 * sandboxEnabled, dev, preserved extras) is also named per-server so the
 * operator hears about it instead of silently losing it on round-trip.
 */
function serializeMcpServersJson(model: McpModel): { content: string; warnings: string[] } {
  const mcpServers: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const s of model.servers) {
    if (s.transport !== "stdio") {
      warnings.push(
        `Dropped server "${s.name}": transport "${s.transport}" is not representable in the target's stdio-only mcpServers schema (url/headers/auth dropped).`,
      );
      continue;
    }
    const dropped: string[] = [];
    if (s.envFile !== undefined) dropped.push("envFile");
    if (s.sandbox !== undefined) dropped.push("sandbox");
    if (s.sandboxEnabled !== undefined) dropped.push("sandboxEnabled");
    if (s.dev !== undefined) dropped.push("dev");
    if (s.extras && Object.keys(s.extras).length > 0) dropped.push(...Object.keys(s.extras));
    if (dropped.length > 0) {
      warnings.push(
        `Server "${s.name}": dropped fields not supported by mcpServers schema: ${dropped.join(", ")}.`,
      );
    }
    mcpServers[s.name] = stripUndefined({
      command: s.command,
      args: s.args,
      env: s.env,
    });
  }
  if (model.inputs.length > 0) {
    warnings.push(
      `Dropped ${model.inputs.length} top-level "inputs" placeholder(s): not supported by the target's mcpServers schema.`,
    );
  }
  return { content: `${JSON.stringify({ mcpServers }, null, 2)}\n`, warnings };
}

/**
 * Serialise to Codex TOML. Codex supports the legacy stdio shape directly;
 * non-stdio metadata is written under the same `[mcp.servers.<name>]`
 * tables as structured TOML so a future Codex with Streamable HTTP support
 * can pick it up. Cross-server merge with any existing config is performed
 * by the orchestrator (`applyMigrated`), so this function always starts from
 * an empty TOML root.
 *
 * Unknown extras are spread inline at the same level as the typed fields
 * (mirroring the VS Code serializer). Stuffing them into a nested `extras`
 * subtable would re-capture the literal key "extras" on the next parse via
 * `pickExtras`, nesting one level deeper on every round-trip.
 */
function serializeCodexMcp(model: McpModel): string {
  const base: TOML.JsonMap = {};
  const mcp: TOML.JsonMap = {};
  const serverMap: TOML.JsonMap = {};
  for (const s of model.servers) {
    const entry: TOML.JsonMap = {};
    if (s.transport === "stdio") {
      entry.command = s.command;
      entry.args = (s.args ?? []) as TOML.AnyJson;
      entry.env = (s.env ?? {}) as TOML.AnyJson;
    } else {
      entry.type = s.transport;
      entry.url = s.url;
      if (s.headers) entry.headers = s.headers as TOML.AnyJson;
      if (s.auth !== undefined && s.auth !== null) entry.auth = s.auth as TOML.AnyJson;
    }
    if (s.envFile !== undefined) entry.envFile = s.envFile;
    if (s.sandboxEnabled !== undefined) entry.sandboxEnabled = s.sandboxEnabled;
    if (s.sandbox !== undefined && s.sandbox !== null) entry.sandbox = s.sandbox as TOML.AnyJson;
    if (s.dev !== undefined && s.dev !== null) entry.dev = s.dev as TOML.AnyJson;
    if (s.extras) {
      for (const [k, v] of Object.entries(s.extras)) {
        if (!(k in entry) && v !== undefined && v !== null) entry[k] = v as TOML.AnyJson;
      }
    }
    serverMap[s.name] = entry;
  }
  mcp.servers = serverMap;
  base.mcp = mcp;
  return TOML.stringify(base);
}

// ── Translators (registry-shaped wrappers) ───────────────────────────────────

type ParseFn = (raw: string) => McpModel;

function mcpToVsCode(parse: ParseFn): Translator {
  return (raw) => {
    try {
      const model = parse(raw);
      if (model.servers.length === 0 && model.inputs.length === 0) return null;
      return { content: serializeVsCodeMcp(model), targetName: "mcp.json" };
    } catch {
      return null;
    }
  };
}

function mcpToMcpServers(parse: ParseFn): Translator {
  return (raw) => {
    try {
      const model = parse(raw);
      if (model.servers.length === 0 && model.inputs.length === 0) return null;
      const { content, warnings } = serializeMcpServersJson(model);
      const wouldWriteAnyServer = model.servers.some((s) => s.transport === "stdio");
      if (!wouldWriteAnyServer) {
        // Surface warnings about dropped non-stdio servers / inputs without
        // creating a brand-new file containing only `{"mcpServers":{}}`.
        if (warnings.length === 0) return null;
        return { content, targetName: "mcp.json", warnings, skipWrite: true };
      }
      return { content, targetName: "mcp.json", warnings };
    } catch {
      return null;
    }
  };
}

function mcpToCodex(parse: ParseFn): Translator {
  return (raw) => {
    try {
      const model = parse(raw);
      if (model.servers.length === 0 && model.inputs.length === 0) return null;
      const warnings: string[] = [];
      if (model.inputs.length > 0) {
        warnings.push(
          `Dropped ${model.inputs.length} top-level "inputs" placeholder(s): Codex MCP TOML has no equivalent.`,
        );
      }
      const content = serializeCodexMcp(model);
      // Inputs-only sources would write an empty `[mcp]\nservers = { }` stub;
      // surface the warning instead and let the orchestrator skip the write.
      if (model.servers.length === 0) {
        return { content, targetName: "config.toml", warnings, skipWrite: true };
      }
      return {
        content,
        targetName: "config.toml",
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch {
      return null;
    }
  };
}

/**
 * All MCP translators indexed by direction for registry registration.
 *
 * Each function picks the source parser based on the *source* agent (VS Code
 * uses its top-level `servers`/`inputs` parser; Claude/Cursor use the
 * legacy `mcpServers` parser; Codex parses TOML) and the target serialiser
 * based on the *target* agent's documented schema.
 */
export const translateMcp = {
  // Claude as source ----------------------------------------------------------
  claudeToCursor: mcpToMcpServers(parseMcpServersJson),
  claudeToVsCode: mcpToVsCode(parseMcpServersJson),
  claudeToCodex: mcpToCodex(parseMcpServersJson),
  claudeToCopilot: mcpToMcpServers(parseMcpServersJson),
  // Cursor as source ----------------------------------------------------------
  cursorToClaude: mcpToMcpServers(parseMcpServersJson),
  cursorToVsCode: mcpToVsCode(parseMcpServersJson),
  cursorToCodex: mcpToCodex(parseMcpServersJson),
  cursorToCopilot: mcpToMcpServers(parseMcpServersJson),
  // VS Code as source ---------------------------------------------------------
  vsCodeToClaude: mcpToMcpServers(parseVsCodeMcp),
  vsCodeToCursor: mcpToMcpServers(parseVsCodeMcp),
  vsCodeToCodex: mcpToCodex(parseVsCodeMcp),
  vsCodeToCopilot: mcpToMcpServers(parseVsCodeMcp),
  // Codex as source -----------------------------------------------------------
  codexToClaude: mcpToMcpServers(parseCodexMcp),
  codexToCursor: mcpToMcpServers(parseCodexMcp),
  codexToVsCode: mcpToVsCode(parseCodexMcp),
  codexToCopilot: mcpToMcpServers(parseCodexMcp),
  // Copilot as source ---------------------------------------------------------
  copilotToClaude: mcpToMcpServers(parseMcpServersJson),
  copilotToCursor: mcpToMcpServers(parseMcpServersJson),
  copilotToVsCode: mcpToVsCode(parseMcpServersJson),
  copilotToCodex: mcpToCodex(parseMcpServersJson),
};
