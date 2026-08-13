/** Pairwise MCP translators using only fields verified for each target schema. */

import * as TOML from "@iarna/toml";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import type { Translator } from "../types";

export type McpTransport = "stdio" | "http" | "sse";

interface McpServerCommon {
  name: string;
  enabled?: boolean;
  /** OpenCode request timeout in milliseconds. */
  timeout?: number;
  envFile?: string;
  sandboxEnabled?: boolean;
  sandbox?: unknown;
  dev?: unknown;
  extras?: Record<string, unknown>;
}

export interface McpStdioServer extends McpServerCommon {
  transport: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpRemoteServer extends McpServerCommon {
  transport: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  envHeaders?: Record<string, string>;
  bearerTokenEnvVar?: string;
  oauth?: unknown;
  oauthScopesConfigured?: boolean;
  environmentId?: string;
}

export type McpServer = McpStdioServer | McpRemoteServer;

export interface McpInput {
  id: string;
  type?: string;
  description?: string;
  password?: boolean;
  extras?: Record<string, unknown>;
}

interface McpModel {
  servers: McpServer[];
  inputs: McpInput[];
  warnings: string[];
  source: "generic" | "vscode" | "codex" | "copilot" | "opencode";
}

class McpValidationError extends Error {}

const ZRecordString = z.record(z.string(), z.string());
const ZStdioServer = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: ZRecordString.optional(),
  cwd: z.string().optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().nonnegative().optional(),
  envFile: z.string().optional(),
  sandbox: z.unknown().optional(),
  sandboxEnabled: z.boolean().optional(),
  dev: z.unknown().optional(),
});
const ZHttpServer = z.object({
  type: z.union([z.literal("http"), z.literal("sse")]),
  url: z.string().min(1),
  headers: ZRecordString.optional(),
  oauth: z.unknown().optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().nonnegative().optional(),
  envFile: z.string().optional(),
  sandbox: z.unknown().optional(),
  sandboxEnabled: z.boolean().optional(),
  dev: z.unknown().optional(),
});

const STDIO_KEYS = new Set([
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "enabled",
  "timeout",
  "envFile",
  "sandbox",
  "sandboxEnabled",
  "dev",
]);
const REMOTE_KEYS = new Set([
  "type",
  "url",
  "headers",
  "oauth",
  "enabled",
  "timeout",
  "envFile",
  "sandbox",
  "sandboxEnabled",
  "dev",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function pickExtras(
  raw: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key)));
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function parseSingleServer(name: string, raw: unknown): McpServer | null {
  if (!isRecord(raw)) return null;
  if (raw.type === "http" || raw.type === "sse") {
    const parsed = ZHttpServer.safeParse(raw);
    if (!parsed.success) return null;
    return {
      name,
      transport: parsed.data.type,
      url: parsed.data.url,
      headers: parsed.data.headers,
      oauth: parsed.data.oauth,
      enabled: parsed.data.enabled,
      timeout: parsed.data.timeout,
      envFile: parsed.data.envFile,
      sandbox: parsed.data.sandbox,
      sandboxEnabled: parsed.data.sandboxEnabled,
      dev: parsed.data.dev,
      extras: pickExtras(raw, REMOTE_KEYS),
    };
  }
  const parsed = ZStdioServer.safeParse(raw);
  if (!parsed.success) return null;
  return {
    name,
    transport: "stdio",
    command: parsed.data.command,
    args: parsed.data.args,
    env: parsed.data.env,
    cwd: parsed.data.cwd,
    enabled: parsed.data.enabled,
    timeout: parsed.data.timeout,
    envFile: parsed.data.envFile,
    sandbox: parsed.data.sandbox,
    sandboxEnabled: parsed.data.sandboxEnabled,
    dev: parsed.data.dev,
    extras: pickExtras(raw, STDIO_KEYS),
  };
}

function parseInputs(raw: unknown): McpInput[] {
  if (!Array.isArray(raw)) return [];
  const inputs: McpInput[] = [];
  for (const value of raw) {
    if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) continue;
    const extras = pickExtras(value, new Set(["id", "type", "description", "password"]));
    inputs.push({
      id: value.id,
      type: typeof value.type === "string" ? value.type : undefined,
      description: typeof value.description === "string" ? value.description : undefined,
      password: typeof value.password === "boolean" ? value.password : undefined,
      extras,
    });
  }
  return inputs;
}

function emptyModel(source: McpModel["source"]): McpModel {
  return { servers: [], inputs: [], warnings: [], source };
}

function parseVsCodeOAuth(name: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.clientId !== "string" || value.clientId.length === 0) {
    throw new McpValidationError(
      `Server "${name}": VS Code oauth must be an object with a non-empty clientId`,
    );
  }
  if (value.enterpriseManaged !== undefined && typeof value.enterpriseManaged !== "boolean") {
    throw new McpValidationError(
      `Server "${name}": VS Code oauth.enterpriseManaged must be a boolean`,
    );
  }
  const unsupported = Object.keys(value).filter(
    (key) => key !== "clientId" && key !== "enterpriseManaged",
  );
  if (unsupported.length > 0) {
    throw new McpValidationError(
      `Server "${name}": VS Code oauth contains unsupported field(s): ${unsupported.join(", ")}`,
    );
  }
  return stripUndefined({
    clientId: value.clientId,
    enterpriseManaged: value.enterpriseManaged,
  });
}

function parseVsCodeEnvironment(
  name: string,
  value: unknown,
  warnings: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new McpValidationError(`Server "${name}": VS Code env must be an object`);
  }
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      environment[key] = entry;
      continue;
    }
    if (typeof entry === "number" && Number.isFinite(entry)) {
      environment[key] = String(entry);
      warnings.push(`Server "${name}": converted numeric VS Code env.${key} to a string.`);
      continue;
    }
    throw new McpValidationError(
      `Server "${name}": VS Code env.${key} cannot be represented as a target environment string`,
    );
  }
  return environment;
}

function parseVsCodeMcp(raw: string): McpModel {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new McpValidationError("VS Code MCP document must contain a valid JSONC object");
  }
  const root = parsed;
  const model = emptyModel("vscode");
  if (root.servers !== undefined && !isRecord(root.servers)) {
    throw new McpValidationError("VS Code servers must be an object");
  }
  if (isRecord(root.servers)) {
    if (root.sandbox !== undefined) {
      model.warnings.push(
        'Dropped VS Code top-level "sandbox" policy: the target has no verified equivalent.',
      );
    }
    for (const [name, rawServer] of Object.entries(root.servers)) {
      const normalized =
        isRecord(rawServer) && rawServer.env !== undefined
          ? { ...rawServer, env: parseVsCodeEnvironment(name, rawServer.env, model.warnings) }
          : rawServer;
      const server = parseSingleServer(name, normalized);
      if (!server) {
        throw new McpValidationError(`Server "${name}": VS Code MCP entry is invalid`);
      }
      if (server.transport !== "stdio" && isRecord(rawServer)) {
        server.oauth = parseVsCodeOAuth(name, rawServer.oauth);
      }
      model.servers.push(server);
    }
    model.inputs = parseInputs(root.inputs);
    return model;
  }
  if (isRecord(root.mcpServers)) {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      const server = parseSingleServer(name, value);
      if (!server) {
        throw new McpValidationError(`Server "${name}": legacy VS Code MCP entry is invalid`);
      }
      model.servers.push(server);
    }
  } else if (root.mcpServers !== undefined) {
    throw new McpValidationError("Legacy VS Code mcpServers must be an object");
  }
  return model;
}

function parseMcpServersJson(raw: string): McpModel {
  const root = JSON.parse(raw) as Record<string, unknown>;
  const model = emptyModel("generic");
  if (root.mcpServers === undefined) return model;
  if (!isRecord(root.mcpServers)) {
    throw new McpValidationError("mcpServers must be an object");
  }
  for (const [name, value] of Object.entries(root.mcpServers)) {
    const server = parseSingleServer(name, value);
    if (!server) throw new McpValidationError(`Server "${name}": MCP entry is invalid`);
    model.servers.push(server);
  }
  return model;
}

function parseCopilotOpenCodeMcp(raw: string): McpModel {
  const root = JSON.parse(raw) as Record<string, unknown>;
  const model = emptyModel("copilot");
  if (root.mcpServers === undefined) return model;
  if (!isRecord(root.mcpServers)) {
    throw new McpValidationError("Copilot mcpServers must be an object");
  }
  for (const [name, value] of Object.entries(root.mcpServers)) {
    if (!isRecord(value)) {
      throw new McpValidationError(`Server "${name}": Copilot MCP entry is invalid`);
    }
    if (!Array.isArray(value.tools) || value.tools.length !== 1 || value.tools[0] !== "*") {
      throw new McpValidationError(
        `Server "${name}": Copilot tools must be exactly ["*"] for OpenCode migration`,
      );
    }
    const { tools: _tools, ...withoutTools } = value;
    const normalizedType =
      withoutTools.type === "local"
        ? "stdio"
        : withoutTools.type === "streamable-http"
          ? "http"
          : withoutTools.type;
    const normalized = { ...withoutTools, type: normalizedType };
    const server = parseSingleServer(name, normalized);
    if (!server) {
      throw new McpValidationError(`Server "${name}": Copilot MCP entry is invalid`);
    }
    model.servers.push(server);
  }
  return model;
}

const CODEX_STDIO_KEYS = new Set(["command", "args", "env", "cwd", "enabled", "tool_timeout_sec"]);
const CODEX_REMOTE_KEYS = new Set([
  "url",
  "http_headers",
  "env_http_headers",
  "bearer_token_env_var",
  "oauth",
  "scopes",
  "auth",
  "environment_id",
  "enabled",
  "tool_timeout_sec",
]);

function codexTimeoutMilliseconds(
  name: string,
  value: unknown,
  warnings: string[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && value > 0 && Number.isSafeInteger(value * 1000)) {
    return value * 1000;
  }
  warnings.push(
    `Server "${name}": Codex tool_timeout_sec is not a positive value exactly representable as OpenCode milliseconds; timeout was dropped.`,
  );
  return undefined;
}

function parseCodexOAuth(
  name: string,
  value: unknown,
  scopes: unknown,
): Record<string, unknown> | undefined {
  if (scopes !== undefined) {
    if (
      !Array.isArray(scopes) ||
      scopes.some((scope) => typeof scope !== "string" || !scope || /\s/.test(scope))
    ) {
      throw new McpValidationError(
        `Server "${name}": Codex scopes must be non-empty strings without whitespace`,
      );
    }
  }
  if (value !== undefined) {
    if (!isRecord(value)) {
      throw new McpValidationError(`Server "${name}": Codex oauth must be a table`);
    }
    const unknown = Object.keys(value).filter((key) => key !== "client_id");
    if (unknown.length > 0) {
      throw new McpValidationError(
        `Server "${name}": Codex oauth contains unsupported field(s): ${unknown.join(", ")}`,
      );
    }
    if (value.client_id !== undefined && typeof value.client_id !== "string") {
      throw new McpValidationError(`Server "${name}": Codex oauth.client_id must be a string`);
    }
  }
  const oauth = stripUndefined({
    clientId: isRecord(value) ? value.client_id : undefined,
    scope: Array.isArray(scopes) && scopes.length > 0 ? scopes.join(" ") : undefined,
  });
  return Object.keys(oauth).length > 0 ? oauth : undefined;
}

function parseCodexMcp(raw: string): McpModel {
  const root = JSON.parse(JSON.stringify(TOML.parse(raw))) as Record<string, unknown>;
  const model = emptyModel("codex");
  if (!isRecord(root.mcp_servers)) return model;
  for (const [name, value] of Object.entries(root.mcp_servers)) {
    if (!isRecord(value)) {
      throw new McpValidationError(`Server "${name}": Codex MCP entry must be a table`);
    }
    const timeout = codexTimeoutMilliseconds(name, value.tool_timeout_sec, model.warnings);
    if (typeof value.command === "string" && value.command.length > 0) {
      if (
        value.args !== undefined &&
        (!Array.isArray(value.args) || value.args.some((v) => typeof v !== "string"))
      ) {
        throw new McpValidationError(`Server "${name}": Codex args must be an array of strings`);
      }
      if (value.env !== undefined && !isStringRecord(value.env)) {
        throw new McpValidationError(`Server "${name}": Codex env must contain string values`);
      }
      if (value.cwd !== undefined && typeof value.cwd !== "string") {
        throw new McpValidationError(`Server "${name}": Codex cwd must be a string`);
      }
      if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
        throw new McpValidationError(`Server "${name}": Codex enabled must be a boolean`);
      }
      model.servers.push({
        name,
        transport: "stdio",
        command: value.command,
        args: value.args as string[] | undefined,
        env: value.env as Record<string, string> | undefined,
        cwd: value.cwd as string | undefined,
        enabled: value.enabled as boolean | undefined,
        timeout,
        extras: pickExtras(value, CODEX_STDIO_KEYS),
      });
      continue;
    }
    if (typeof value.url === "string" && value.url.length > 0) {
      if (value.http_headers !== undefined && !isStringRecord(value.http_headers)) {
        throw new McpValidationError(
          `Server "${name}": Codex http_headers must contain string values`,
        );
      }
      if (value.env_http_headers !== undefined && !isStringRecord(value.env_http_headers)) {
        throw new McpValidationError(
          `Server "${name}": Codex env_http_headers must contain string values`,
        );
      }
      if (
        value.bearer_token_env_var !== undefined &&
        (typeof value.bearer_token_env_var !== "string" || !value.bearer_token_env_var)
      ) {
        throw new McpValidationError(
          `Server "${name}": Codex bearer_token_env_var must be a non-empty string`,
        );
      }
      if (value.auth !== undefined && value.auth !== "oauth" && value.auth !== "chatgpt") {
        throw new McpValidationError(`Server "${name}": Codex auth must be "oauth" or "chatgpt"`);
      }
      if (value.environment_id !== undefined && typeof value.environment_id !== "string") {
        throw new McpValidationError(`Server "${name}": Codex environment_id must be a string`);
      }
      if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
        throw new McpValidationError(`Server "${name}": Codex enabled must be a boolean`);
      }
      const extras = pickExtras(value, CODEX_REMOTE_KEYS) ?? {};
      if (value.auth === "chatgpt") extras.auth = value.auth;
      model.servers.push({
        name,
        transport: "http",
        url: value.url,
        headers: value.http_headers as Record<string, string> | undefined,
        envHeaders: value.env_http_headers as Record<string, string> | undefined,
        bearerTokenEnvVar: value.bearer_token_env_var as string | undefined,
        oauth: parseCodexOAuth(name, value.oauth, value.scopes),
        oauthScopesConfigured: value.scopes !== undefined,
        environmentId: value.environment_id as string | undefined,
        enabled: value.enabled as boolean | undefined,
        timeout,
        extras: Object.keys(extras).length > 0 ? extras : undefined,
      });
      continue;
    }
    throw new McpValidationError(
      `Server "${name}": Codex MCP entry requires either command or url`,
    );
  }
  return model;
}

const OPEN_CODE_OAUTH_KEYS = new Set([
  "clientId",
  "clientSecret",
  "scope",
  "callbackPort",
  "redirectUri",
]);

function validateOpenCodeTimeout(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new McpValidationError(`Server "${name}": OpenCode timeout must be a positive integer`);
  }
  return value;
}

function validateOpenCodeOAuth(
  name: string,
  value: unknown,
): false | Record<string, unknown> | undefined {
  if (value === undefined || value === false) return value;
  if (!isRecord(value)) {
    throw new McpValidationError(`Server "${name}": OpenCode oauth must be false or an object`);
  }
  const unknown = Object.keys(value).filter((key) => !OPEN_CODE_OAUTH_KEYS.has(key));
  if (unknown.length > 0) {
    throw new McpValidationError(
      `Server "${name}": OpenCode oauth contains unsupported field(s): ${unknown.join(", ")}`,
    );
  }
  for (const key of ["clientId", "clientSecret", "scope", "redirectUri"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new McpValidationError(`Server "${name}": OpenCode oauth.${key} must be a string`);
    }
  }
  if (
    value.callbackPort !== undefined &&
    (typeof value.callbackPort !== "number" ||
      !Number.isInteger(value.callbackPort) ||
      value.callbackPort < 1 ||
      value.callbackPort > 65535)
  ) {
    throw new McpValidationError(
      `Server "${name}": OpenCode oauth.callbackPort must be an integer from 1 to 65535`,
    );
  }
  return value;
}

function parseOpenCodeMcp(raw: string): McpModel {
  const root = JSON.parse(raw) as Record<string, unknown>;
  const model = emptyModel("opencode");
  if (root.mcp === undefined) return model;
  if (!isRecord(root.mcp)) {
    throw new McpValidationError("OpenCode mcp must be an object");
  }
  for (const [name, value] of Object.entries(root.mcp)) {
    if (!isRecord(value)) {
      throw new McpValidationError(`Server "${name}": OpenCode MCP entry must be an object`);
    }
    if (value.type === undefined && typeof value.enabled === "boolean") {
      throw new McpValidationError(
        `Server "${name}": enabled-only OpenCode MCP entry has no standalone transport definition`,
      );
    }
    const timeout = validateOpenCodeTimeout(name, value.timeout);
    if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
      throw new McpValidationError(`Server "${name}": OpenCode enabled must be a boolean`);
    }
    if (value.type === "local") {
      if (
        !Array.isArray(value.command) ||
        value.command.length === 0 ||
        typeof value.command[0] !== "string" ||
        value.command[0].length === 0 ||
        value.command.slice(1).some((part) => typeof part !== "string")
      ) {
        throw new McpValidationError(
          `Server "${name}": OpenCode local command requires a non-empty executable followed by string arguments`,
        );
      }
      if (value.environment !== undefined && !isStringRecord(value.environment)) {
        throw new McpValidationError(
          `Server "${name}": OpenCode environment must contain string values`,
        );
      }
      if (value.cwd !== undefined && typeof value.cwd !== "string") {
        throw new McpValidationError(`Server "${name}": OpenCode cwd must be a string`);
      }
      const [command, ...args] = value.command as string[];
      model.servers.push({
        name,
        transport: "stdio",
        command: command as string,
        ...(args.length > 0 ? { args } : {}),
        env: value.environment as Record<string, string> | undefined,
        cwd: value.cwd as string | undefined,
        enabled: value.enabled as boolean | undefined,
        timeout,
        extras: pickExtras(
          value,
          new Set(["type", "command", "environment", "cwd", "enabled", "timeout"]),
        ),
      });
      continue;
    }
    if (value.type === "remote") {
      if (typeof value.url !== "string" || value.url.length === 0) {
        throw new McpValidationError(
          `Server "${name}": OpenCode remote url must be a non-empty string`,
        );
      }
      if (value.headers !== undefined && !isStringRecord(value.headers)) {
        throw new McpValidationError(
          `Server "${name}": OpenCode headers must contain string values`,
        );
      }
      model.servers.push({
        name,
        transport: "http",
        url: value.url,
        headers: value.headers as Record<string, string> | undefined,
        oauth: validateOpenCodeOAuth(name, value.oauth),
        enabled: value.enabled as boolean | undefined,
        timeout,
        extras: pickExtras(
          value,
          new Set(["type", "url", "headers", "oauth", "enabled", "timeout"]),
        ),
      });
      continue;
    }
    throw new McpValidationError(`Server "${name}": OpenCode type must be "local" or "remote"`);
  }
  return model;
}

export function validateOpenCodeMcpLayer(value: unknown): void {
  if (!isRecord(value)) throw new McpValidationError("OpenCode mcp must be an object");
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry) && Object.keys(entry).length === 1 && typeof entry.enabled === "boolean") {
      continue;
    }
    parseOpenCodeMcp(JSON.stringify({ mcp: { [name]: entry } }));
  }
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function commonLosses(server: McpServer): string[] {
  const losses: string[] = [];
  if (server.envFile !== undefined) losses.push("envFile");
  if (server.sandbox !== undefined) losses.push("sandbox");
  if (server.sandboxEnabled !== undefined) losses.push("sandboxEnabled");
  if (server.dev !== undefined) losses.push("dev");
  if (server.extras) losses.push(...Object.keys(server.extras));
  return losses;
}

const OPEN_CODE_REFERENCE = /\{(?:env:[^}]+|file:[^}]+)\}/;
const OPEN_CODE_ENV_REFERENCE = /\{env:([^}]+)\}/g;
const OPEN_CODE_FILE_REFERENCE = /\{file:[^}]+\}/;
const VS_CODE_VARIABLE = /\$\{[^}]+\}/;
const VS_CODE_VARIABLES = /\$\{([^}]+)\}/g;
const COPILOT_ENV_REFERENCE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\})/;
const COPILOT_DEFAULT_ENV_REFERENCE = /\$\{[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}/;
const COPILOT_BRACED_ENV_REFERENCES = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const COPILOT_SIMPLE_ENV_REFERENCES = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function containsOpenCodeReference(value: unknown): boolean {
  if (typeof value === "string") return OPEN_CODE_REFERENCE.test(value);
  if (Array.isArray(value)) return value.some(containsOpenCodeReference);
  return (
    isRecord(value) &&
    Object.entries(value).some(
      ([key, child]) => containsOpenCodeReference(key) || containsOpenCodeReference(child),
    )
  );
}

function assertEnvironmentVariableName(serverName: string, value: string): void {
  if (!ENVIRONMENT_VARIABLE_NAME.test(value)) {
    throw new McpValidationError(
      `Server "${serverName}": environment reference name cannot be represented safely`,
    );
  }
}

function projectVsCodeValueToOpenCode<T>(value: T, serverName: string, field: string): T {
  if (typeof value === "string") {
    const withoutVsCodeVariables = value.replace(VS_CODE_VARIABLES, "");
    if (containsOpenCodeReference(withoutVsCodeVariables)) {
      throw new McpValidationError(
        `Server "${serverName}": ${field} contains OpenCode configuration-reference syntax that is inert in VS Code`,
      );
    }
    return value.replace(
      VS_CODE_VARIABLES,
      (_match, expression: string, offset: number): string => {
        if (offset > 0 && value[offset - 1] === "$") {
          throw new McpValidationError(
            `Server "${serverName}": ${field} contains an escaped VS Code variable with no verified OpenCode equivalent`,
          );
        }
        const environment = /^env:(.+)$/.exec(expression);
        if (!environment) {
          throw new McpValidationError(
            `Server "${serverName}": ${field} contains a VS Code variable with no verified OpenCode equivalent`,
          );
        }
        const name = environment[1] as string;
        assertEnvironmentVariableName(serverName, name);
        return `{env:${name}}`;
      },
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectVsCodeValueToOpenCode(item, serverName, field)) as T;
  }
  if (!isRecord(value)) return value;
  if (
    Object.keys(value).some((key) => VS_CODE_VARIABLE.test(key) || containsOpenCodeReference(key))
  ) {
    throw new McpValidationError(
      `Server "${serverName}": ${field} contains configuration-reference syntax in an object key with no verified OpenCode equivalent`,
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      projectVsCodeValueToOpenCode(child, serverName, field),
    ]),
  ) as T;
}

function projectVsCodeServerToOpenCode(server: McpServer): McpServer {
  if (VS_CODE_VARIABLE.test(server.name) || containsOpenCodeReference(server.name)) {
    throw new McpValidationError(
      "A VS Code MCP server name contains variable syntax with no verified OpenCode equivalent",
    );
  }
  if (server.transport === "stdio") {
    return {
      ...server,
      command: projectVsCodeValueToOpenCode(server.command, server.name, "command"),
      args: projectVsCodeValueToOpenCode(server.args, server.name, "args"),
      cwd: projectVsCodeValueToOpenCode(server.cwd, server.name, "cwd"),
      env: projectVsCodeValueToOpenCode(server.env, server.name, "env"),
    };
  }
  return {
    ...server,
    url: projectVsCodeValueToOpenCode(server.url, server.name, "url"),
    headers: projectVsCodeValueToOpenCode(server.headers, server.name, "headers"),
    oauth: projectVsCodeValueToOpenCode(server.oauth, server.name, "oauth"),
  };
}

function projectCopilotHeaderValueToOpenCode(
  value: string,
  serverName: string,
  headerName: string,
): string {
  if (containsOpenCodeReference(value)) {
    throw new McpValidationError(
      `Server "${serverName}": header "${headerName}" contains OpenCode configuration-reference syntax that is inert in Copilot`,
    );
  }
  if (COPILOT_DEFAULT_ENV_REFERENCE.test(value)) {
    throw new McpValidationError(
      `Server "${serverName}": header "${headerName}" uses a Copilot environment default with no verified OpenCode equivalent`,
    );
  }
  return value
    .replace(COPILOT_BRACED_ENV_REFERENCES, (_match, name: string) => `{env:${name}}`)
    .replace(COPILOT_SIMPLE_ENV_REFERENCES, (_match, name: string) => `{env:${name}}`);
}

function projectCopilotServerToOpenCode(server: McpServer): McpServer {
  if (server.transport === "stdio") return server;
  if (server.oauth !== undefined) {
    throw new McpValidationError(
      `Server "${server.name}": nested oauth is not part of the verified Copilot MCP schema`,
    );
  }

  const extras = { ...(server.extras ?? {}) };
  const oauthClientId = extras.oauthClientId;
  if (
    oauthClientId !== undefined &&
    (typeof oauthClientId !== "string" || oauthClientId.length === 0)
  ) {
    throw new McpValidationError(
      `Server "${server.name}": Copilot oauthClientId must be a non-empty string`,
    );
  }
  if (extras.oauthPublicClient !== undefined && extras.oauthPublicClient !== true) {
    throw new McpValidationError(
      `Server "${server.name}": Copilot oauthPublicClient requires confidential-client credentials that cannot be migrated`,
    );
  }
  if (extras.oauthGrantType !== undefined && extras.oauthGrantType !== "authorization_code") {
    throw new McpValidationError(
      `Server "${server.name}": Copilot oauthGrantType has no verified OpenCode equivalent`,
    );
  }
  if (extras.oidc !== undefined && extras.oidc !== false) {
    throw new McpValidationError(
      `Server "${server.name}": Copilot oidc has no verified OpenCode equivalent`,
    );
  }
  delete extras.oauthClientId;
  delete extras.oauthPublicClient;
  delete extras.oauthGrantType;
  delete extras.oidc;

  if (
    Object.keys(server.headers ?? {}).some(
      (key) => COPILOT_ENV_REFERENCE.test(key) || containsOpenCodeReference(key),
    )
  ) {
    throw new McpValidationError(
      `Server "${server.name}": a header name contains configuration-reference syntax with no verified OpenCode equivalent`,
    );
  }
  return {
    ...server,
    headers:
      server.headers === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(server.headers).map(([name, value]) => [
              name,
              projectCopilotHeaderValueToOpenCode(value, server.name, name),
            ]),
          ),
    oauth: oauthClientId === undefined ? undefined : { clientId: oauthClientId },
    extras: Object.keys(extras).length > 0 ? extras : undefined,
  };
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing) delete headers[existing];
  headers[name] = value;
}

function projectDynamicHeaders(
  server: McpRemoteServer,
  target: "opencode" | "vscode",
): Record<string, string> | undefined {
  const headers = { ...(server.headers ?? {}) };
  const reference = (name: string): string => {
    assertEnvironmentVariableName(server.name, name);
    return target === "opencode" ? `{env:${name}}` : `\${env:${name}}`;
  };
  for (const [name, environmentName] of Object.entries(server.envHeaders ?? {})) {
    setHeader(headers, name, reference(environmentName));
  }
  if (server.bearerTokenEnvVar) {
    setHeader(headers, "Authorization", `Bearer ${reference(server.bearerTokenEnvVar)}`);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function mapOpenCodeReferencesToVsCode(value: unknown): unknown {
  if (typeof value === "string") {
    if (OPEN_CODE_FILE_REFERENCE.test(value)) {
      throw new McpValidationError(
        "OpenCode file-reference syntax has no verified VS Code MCP equivalent",
      );
    }
    return value.replace(OPEN_CODE_ENV_REFERENCE, (_match, name: string) => {
      assertEnvironmentVariableName("OpenCode MCP", name);
      return `\${env:${name}}`;
    });
  }
  if (Array.isArray(value)) return value.map(mapOpenCodeReferencesToVsCode);
  if (!isRecord(value)) return value;
  if (Object.keys(value).some(containsOpenCodeReference)) {
    throw new McpValidationError(
      "OpenCode configuration-reference syntax in an object key has no verified VS Code MCP equivalent",
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, mapOpenCodeReferencesToVsCode(child)]),
  );
}

function projectVsCodeOAuth(
  server: McpRemoteServer,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (server.oauth === undefined) return undefined;
  if (server.oauth === false) {
    throw new McpValidationError(
      `Server "${server.name}" disables OAuth, but VS Code MCP has no verified no-OAuth equivalent`,
    );
  }
  if (!isRecord(server.oauth)) {
    warnings.push(`Server "${server.name}": dropped incompatible oauth configuration.`);
    return undefined;
  }
  const oauth: Record<string, unknown> = {};
  if (typeof server.oauth.clientId === "string" && server.oauth.clientId.length > 0) {
    oauth.clientId = server.oauth.clientId;
  }
  if (typeof server.oauth.enterpriseManaged === "boolean") {
    oauth.enterpriseManaged = server.oauth.enterpriseManaged;
  }
  const dropped = Object.keys(server.oauth).filter(
    (key) => key !== "clientId" && key !== "enterpriseManaged",
  );
  if (dropped.length > 0) {
    warnings.push(
      `Server "${server.name}": dropped OAuth field(s) not supported by VS Code: ${dropped.join(", ")}.`,
    );
  }
  if (typeof oauth.clientId !== "string") {
    if (Object.keys(server.oauth).length > 0) {
      warnings.push(
        `Server "${server.name}": dropped OAuth configuration because VS Code requires clientId.`,
      );
    }
    return undefined;
  }
  return oauth;
}

function assertVsCodeMcpAuthority(model: McpModel, server: McpServer): void {
  if (model.source !== "codex") return;
  if (server.transport === "stdio") {
    throw new McpValidationError(
      `Server "${server.name}": Codex stdio environment isolation has no verified VS Code equivalent`,
    );
  }
  if (server.environmentId !== undefined && server.environmentId !== "local") {
    throw new McpValidationError(
      `Server "${server.name}": Codex environment_id has no verified VS Code equivalent`,
    );
  }
  const authority = Object.keys(server.extras ?? {}).filter((field) =>
    UNMAPPED_MCP_AUTHORITY.has(field),
  );
  if (server.oauthScopesConfigured) authority.push("scopes");
  if (authority.length > 0) {
    throw new McpValidationError(
      `Server "${server.name}": MCP authority field(s) have no verified VS Code equivalent: ${authority.join(", ")}`,
    );
  }
}

function serializeVsCodeMcp(model: McpModel): { content: string; warnings: string[] } {
  const servers: Record<string, unknown> = {};
  const warnings = [...model.warnings];
  for (const server of model.servers) {
    assertVsCodeMcpAuthority(model, server);
    if (model.source === "opencode" && containsOpenCodeReference(server.name)) {
      throw new McpValidationError(
        "An OpenCode MCP server name contains configuration-reference syntax with no verified VS Code equivalent",
      );
    }
    if (server.enabled === false) {
      throw new McpValidationError(
        `Server "${server.name}" is disabled, but VS Code MCP has no verified disabled equivalent`,
      );
    }
    const dropped = [
      ...(server.sandbox !== undefined ? ["sandbox"] : []),
      ...Object.keys(server.extras ?? {}),
    ];
    if (server.transport !== "stdio" && server.environmentId !== undefined) {
      dropped.push("environment_id");
    }
    if (server.enabled !== undefined) dropped.push("enabled");
    if (server.timeout !== undefined) dropped.push("timeout");
    if (dropped.length > 0) {
      warnings.push(
        `Server "${server.name}": dropped fields not supported by VS Code MCP: ${dropped.join(", ")}.`,
      );
    }
    if (server.transport === "stdio") {
      const entry = stripUndefined({
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        envFile: server.envFile,
        sandboxEnabled: server.sandboxEnabled,
        dev: server.dev,
      });
      servers[server.name] =
        model.source === "opencode" ? mapOpenCodeReferencesToVsCode(entry) : entry;
    } else {
      const entry = stripUndefined({
        type: server.transport,
        url: server.url,
        headers: projectDynamicHeaders(server, "vscode"),
        oauth: projectVsCodeOAuth(server, warnings),
        dev: server.dev,
      });
      servers[server.name] =
        model.source === "opencode" ? mapOpenCodeReferencesToVsCode(entry) : entry;
    }
  }
  const root: Record<string, unknown> = { servers };
  if (model.inputs.length > 0) {
    root.inputs = model.inputs.map((input) =>
      stripUndefined({
        id: input.id,
        type: input.type,
        description: input.description,
        password: input.password,
        ...(input.extras ?? {}),
      }),
    );
  }
  return { content: `${JSON.stringify(root, null, 2)}\n`, warnings };
}

function serializeMcpServersJson(model: McpModel): { content: string; warnings: string[] } {
  const mcpServers: Record<string, unknown> = {};
  const warnings = [...model.warnings];
  for (const server of model.servers) {
    if (server.transport !== "stdio") {
      warnings.push(
        `Dropped server "${server.name}": transport "${server.transport}" is not representable in the target's stdio-only mcpServers schema (url/headers/oauth dropped).`,
      );
      continue;
    }
    if (server.enabled === false) {
      throw new McpValidationError(
        `Server "${server.name}" is disabled, but the target mcpServers schema has no verified disabled equivalent`,
      );
    }
    if (
      model.source === "opencode" &&
      containsOpenCodeReference([server.name, server.command, server.args, server.cwd, server.env])
    ) {
      throw new McpValidationError(
        `Server "${server.name}": OpenCode configuration-reference syntax has no verified target equivalent`,
      );
    }
    const dropped = commonLosses(server);
    if (server.cwd !== undefined) dropped.push("cwd");
    if (server.enabled !== undefined) dropped.push("enabled");
    if (server.timeout !== undefined) dropped.push("timeout");
    if (dropped.length > 0) {
      warnings.push(
        `Server "${server.name}": dropped fields not supported by mcpServers schema: ${dropped.join(", ")}.`,
      );
    }
    mcpServers[server.name] = stripUndefined({
      command: server.command,
      args: server.args,
      env: server.env,
    });
  }
  if (model.inputs.length > 0) {
    warnings.push(
      `Dropped ${model.inputs.length} top-level "inputs" placeholder(s): not supported by the target's mcpServers schema.`,
    );
  }
  return { content: `${JSON.stringify({ mcpServers }, null, 2)}\n`, warnings };
}

function projectOpenCodeHeaderValueToCopilot(
  value: string,
  serverName: string,
  headerName: string,
): string {
  if (COPILOT_ENV_REFERENCE.test(value)) {
    throw new McpValidationError(
      `Server "${serverName}": header "${headerName}" contains Copilot environment syntax that is literal in OpenCode`,
    );
  }
  if (OPEN_CODE_FILE_REFERENCE.test(value)) {
    throw new McpValidationError(
      `Server "${serverName}": header "${headerName}" uses an OpenCode file reference with no verified Copilot equivalent`,
    );
  }
  return value.replace(OPEN_CODE_ENV_REFERENCE, (_match, name: string) => {
    assertEnvironmentVariableName(serverName, name);
    return `\${${name}}`;
  });
}

function projectOpenCodeHeadersToCopilot(
  server: McpRemoteServer,
): Record<string, string> | undefined {
  if (
    Object.keys(server.headers ?? {}).some(
      (name) => containsOpenCodeReference(name) || COPILOT_ENV_REFERENCE.test(name),
    )
  ) {
    throw new McpValidationError(
      `Server "${server.name}": a header name contains configuration-reference syntax with no verified Copilot equivalent`,
    );
  }
  if (!server.headers) return undefined;
  return Object.fromEntries(
    Object.entries(server.headers).map(([name, value]) => [
      name,
      projectOpenCodeHeaderValueToCopilot(value, server.name, name),
    ]),
  );
}

function projectOpenCodeOAuthToCopilot(server: McpRemoteServer): Record<string, unknown> {
  if (server.oauth === undefined) return {};
  if (server.oauth === false) {
    throw new McpValidationError(
      `Server "${server.name}" disables OAuth, but Copilot MCP has no verified no-OAuth equivalent`,
    );
  }
  if (!isRecord(server.oauth)) {
    throw new McpValidationError(`Server "${server.name}": OAuth cannot be represented by Copilot`);
  }
  const unsupported = Object.keys(server.oauth).filter((key) => key !== "clientId");
  if (unsupported.length > 0) {
    throw new McpValidationError(
      `Server "${server.name}": OpenCode OAuth field(s) have no verified Copilot equivalent: ${unsupported.join(", ")}`,
    );
  }
  if (server.oauth.clientId === undefined) return {};
  if (
    typeof server.oauth.clientId !== "string" ||
    server.oauth.clientId.length === 0 ||
    containsOpenCodeReference(server.oauth.clientId)
  ) {
    throw new McpValidationError(
      `Server "${server.name}": OpenCode OAuth clientId cannot be represented by Copilot`,
    );
  }
  return { oauthClientId: server.oauth.clientId };
}

function serializeOpenCodeCopilotMcp(model: McpModel): {
  content: string;
  warnings: string[];
} {
  const mcpServers: Record<string, unknown> = {};
  const warnings = [...model.warnings];
  for (const server of model.servers) {
    if (server.enabled === false) {
      throw new McpValidationError(
        `Server "${server.name}" is disabled, but Copilot MCP has no verified disabled equivalent`,
      );
    }
    if (server.transport === "stdio") {
      throw new McpValidationError(
        `Server "${server.name}": OpenCode stdio environment inheritance has no verified Copilot equivalent`,
      );
    }
    if (containsOpenCodeReference([server.name, server.url])) {
      throw new McpValidationError(
        `Server "${server.name}": remote fields contain OpenCode configuration-reference syntax with no verified Copilot equivalent`,
      );
    }

    const dropped = commonLosses(server);
    if (server.enabled !== undefined) dropped.push("enabled");
    if (dropped.length > 0) {
      warnings.push(
        `Server "${server.name}": dropped fields not supported by Copilot MCP: ${dropped.join(", ")}.`,
      );
    }
    warnings.push(
      `Server "${server.name}": OpenCode's remote HTTP-to-SSE fallback is represented as Copilot transport "http".`,
    );
    mcpServers[server.name] = stripUndefined({
      type: "http",
      url: server.url,
      headers: projectOpenCodeHeadersToCopilot(server),
      tools: ["*"],
      timeout: server.timeout,
      ...projectOpenCodeOAuthToCopilot(server),
    });
  }
  if (model.inputs.length > 0) {
    warnings.push(
      `Dropped ${model.inputs.length} top-level "inputs" placeholder(s): Copilot MCP has no equivalent.`,
    );
  }
  return { content: `${JSON.stringify({ mcpServers }, null, 2)}\n`, warnings };
}

function codexTimeoutSeconds(server: McpServer, warnings: string[]): number | undefined {
  if (server.timeout === undefined) return undefined;
  const seconds = server.timeout / 1000;
  if (
    Number.isSafeInteger(server.timeout) &&
    server.timeout > 0 &&
    Number.isFinite(seconds) &&
    seconds * 1000 === server.timeout
  ) {
    return seconds;
  }
  warnings.push(
    `Server "${server.name}": OpenCode timeout cannot be converted exactly to Codex tool_timeout_sec; timeout was dropped.`,
  );
  return undefined;
}

const EXACT_OPEN_CODE_ENV_REFERENCE = /^\{env:([^}]+)\}$/;
const OPEN_CODE_BEARER_ENV_REFERENCE = /^Bearer[ \t]+\{env:([^}]+)\}$/i;
const EXACT_VS_CODE_ENV_REFERENCE = /^\$\{env:([^}]+)\}$/;
const VS_CODE_BEARER_ENV_REFERENCE = /^Bearer[ \t]+\$\{env:([^}]+)\}$/i;

interface CodexHeaders {
  static?: Record<string, string>;
  environment?: Record<string, string>;
  bearerTokenEnvVar?: string;
}

function projectCodexHeaders(
  server: McpRemoteServer,
  source: McpModel["source"],
  warnings: string[],
): CodexHeaders {
  if (source !== "opencode" && source !== "vscode") {
    return {
      static: server.headers,
      environment: server.envHeaders,
      bearerTokenEnvVar: server.bearerTokenEnvVar,
    };
  }

  const staticHeaders: Record<string, string> = {};
  const environmentHeaders: Record<string, string> = {};
  let bearerTokenEnvVar: string | undefined;
  let converted = false;

  for (const [name, value] of Object.entries(server.headers ?? {})) {
    const nameHasReference =
      source === "opencode" ? containsOpenCodeReference(name) : VS_CODE_VARIABLE.test(name);
    if (nameHasReference) {
      throw new McpValidationError(
        `Server "${server.name}": a header name contains ${source === "opencode" ? "OpenCode configuration-reference" : "VS Code variable"} syntax with no Codex equivalent`,
      );
    }
    const bearer =
      name.toLowerCase() === "authorization"
        ? source === "opencode"
          ? OPEN_CODE_BEARER_ENV_REFERENCE.exec(value)
          : VS_CODE_BEARER_ENV_REFERENCE.exec(value)
        : null;
    if (bearer) {
      assertEnvironmentVariableName(server.name, bearer[1] as string);
      bearerTokenEnvVar = bearer[1];
      converted = true;
      continue;
    }

    const environment =
      source === "opencode"
        ? EXACT_OPEN_CODE_ENV_REFERENCE.exec(value)
        : EXACT_VS_CODE_ENV_REFERENCE.exec(value);
    if (environment) {
      assertEnvironmentVariableName(server.name, environment[1] as string);
      environmentHeaders[name] = environment[1] as string;
      converted = true;
      continue;
    }

    const valueHasReference =
      source === "opencode" ? containsOpenCodeReference(value) : VS_CODE_VARIABLE.test(value);
    if (valueHasReference) {
      throw new McpValidationError(
        `Server "${server.name}": header "${name}" contains ${source === "opencode" ? "OpenCode configuration-reference" : "VS Code variable"} syntax with no exact Codex equivalent`,
      );
    }
    staticHeaders[name] = value;
  }

  if (converted) {
    warnings.push(
      `Server "${server.name}": converted ${source === "opencode" ? "OpenCode" : "VS Code"} environment-backed HTTP headers to Codex environment fields; missing or empty variables can have different runtime behavior.`,
    );
  }
  return {
    static: Object.keys(staticHeaders).length > 0 ? staticHeaders : undefined,
    environment: Object.keys(environmentHeaders).length > 0 ? environmentHeaders : undefined,
    bearerTokenEnvVar,
  };
}

function projectCodexOAuth(
  server: McpRemoteServer,
  source: McpModel["source"],
  warnings: string[],
): { oauth?: TOML.JsonMap; scopes?: string[] } {
  if (server.oauth === undefined) return {};
  if (server.oauth === false) {
    throw new McpValidationError(
      `Server "${server.name}" disables OAuth, but Codex MCP has no verified no-OAuth equivalent`,
    );
  }
  if (source === "generic") {
    warnings.push(`Server "${server.name}": dropped unverified OAuth configuration for Codex.`);
    return {};
  }
  if (!isRecord(server.oauth)) {
    throw new McpValidationError(`Server "${server.name}": OAuth cannot be represented by Codex`);
  }
  if (server.oauth.enterpriseManaged === true) {
    throw new McpValidationError(
      `Server "${server.name}": VS Code enterprise-managed OAuth has no verified Codex equivalent`,
    );
  }
  if (
    containsOpenCodeReference(server.oauth.clientId) ||
    containsOpenCodeReference(server.oauth.scope)
  ) {
    throw new McpValidationError(
      `Server "${server.name}": OAuth contains OpenCode configuration-reference syntax with no verified Codex equivalent`,
    );
  }

  const oauth: TOML.JsonMap = {};
  if (typeof server.oauth.clientId === "string") oauth.client_id = server.oauth.clientId;
  const scopes =
    typeof server.oauth.scope === "string"
      ? server.oauth.scope.split(/\s+/).filter((scope) => scope.length > 0)
      : undefined;
  if (server.oauth.scope !== undefined && scopes?.length === 0) {
    warnings.push(`Server "${server.name}": dropped empty OAuth scope for Codex.`);
  }
  const dropped = Object.keys(server.oauth).filter((key) => key !== "clientId" && key !== "scope");
  if (dropped.length > 0) {
    warnings.push(
      `Server "${server.name}": dropped OAuth field(s) not supported by Codex: ${dropped.join(", ")}.`,
    );
  }
  return {
    ...(Object.keys(oauth).length > 0 ? { oauth } : {}),
    ...(scopes && scopes.length > 0 ? { scopes } : {}),
  };
}

function serializeCodexMcp(model: McpModel): { content: string; warnings: string[] } {
  const servers: TOML.JsonMap = {};
  const warnings = [...model.warnings];
  for (const server of model.servers) {
    if (server.sandboxEnabled === true) {
      throw new McpValidationError(
        `Server "${server.name}" requires a sandbox, but Codex MCP has no verified sandbox equivalent`,
      );
    }
    if (model.source === "opencode" && containsOpenCodeReference(server.name)) {
      throw new McpValidationError(
        "An OpenCode MCP server name contains configuration-reference syntax with no verified Codex equivalent",
      );
    }
    const entry: TOML.JsonMap = {};
    const dropped = commonLosses(server);
    if (server.transport === "stdio") {
      if (
        model.source === "opencode" &&
        containsOpenCodeReference([server.command, server.args, server.cwd, server.env])
      ) {
        throw new McpValidationError(
          `Server "${server.name}": local fields contain OpenCode configuration-reference syntax with no verified Codex equivalent`,
        );
      }
      entry.command = server.command;
      if (server.args !== undefined) entry.args = server.args;
      if (server.env !== undefined) entry.env = server.env;
      if (server.cwd !== undefined) entry.cwd = server.cwd;
    } else {
      if (model.source === "opencode" && containsOpenCodeReference(server.url)) {
        throw new McpValidationError(
          `Server "${server.name}": remote fields contain OpenCode configuration-reference syntax with no verified Codex equivalent`,
        );
      }
      entry.url = server.url;
      const headers = projectCodexHeaders(server, model.source, warnings);
      if (headers.static !== undefined) entry.http_headers = headers.static;
      if (headers.environment !== undefined) entry.env_http_headers = headers.environment;
      if (headers.bearerTokenEnvVar !== undefined) {
        entry.bearer_token_env_var = headers.bearerTokenEnvVar;
      }
      const oauth = projectCodexOAuth(server, model.source, warnings);
      if (oauth.oauth !== undefined) entry.oauth = oauth.oauth;
      if (oauth.scopes !== undefined) entry.scopes = oauth.scopes;
      if (server.transport === "sse") dropped.push("transport=sse");
    }
    if (server.enabled !== undefined) entry.enabled = server.enabled;
    const timeoutSeconds = codexTimeoutSeconds(server, warnings);
    if (timeoutSeconds !== undefined) entry.tool_timeout_sec = timeoutSeconds;
    if (dropped.length > 0) {
      warnings.push(
        `Server "${server.name}": dropped fields not supported by Codex MCP: ${dropped.join(", ")}.`,
      );
    }
    servers[server.name] = entry;
  }
  if (model.inputs.length > 0) {
    warnings.push(
      `Dropped ${model.inputs.length} top-level "inputs" placeholder(s): Codex MCP TOML has no equivalent.`,
    );
  }
  return { content: TOML.stringify({ mcp_servers: servers }), warnings };
}

function projectOpenCodeOAuth(
  server: McpRemoteServer,
  warnings: string[],
): false | Record<string, unknown> | undefined {
  if (server.oauth === undefined || server.oauth === false) return server.oauth;
  if (!isRecord(server.oauth)) {
    throw new McpValidationError(
      `Server "${server.name}": OAuth cannot be represented by OpenCode`,
    );
  }
  if (server.oauth.enterpriseManaged === true) {
    throw new McpValidationError(
      `Server "${server.name}": VS Code enterprise-managed OAuth has no verified OpenCode equivalent`,
    );
  }
  const oauth: Record<string, unknown> = {};
  for (const key of OPEN_CODE_OAUTH_KEYS) {
    if (server.oauth[key] !== undefined) oauth[key] = server.oauth[key];
  }
  validateOpenCodeOAuth(server.name, oauth);
  const dropped = Object.keys(server.oauth).filter((key) => !OPEN_CODE_OAUTH_KEYS.has(key));
  if (dropped.length > 0) {
    warnings.push(
      `Server "${server.name}": dropped OAuth field(s) not supported by OpenCode: ${dropped.join(", ")}.`,
    );
  }
  return Object.keys(oauth).length > 0 ? oauth : undefined;
}

const UNMAPPED_MCP_AUTHORITY = new Set([
  "enabled_tools",
  "disabled_tools",
  "default_tools_approval_mode",
  "tools",
  "omit_tools_from",
  "auth",
  "oauth_resource",
  "oauthClientId",
  "oauthPublicClient",
  "oauthGrantType",
  "oidc",
]);

function assertOpenCodeMcpAuthority(server: McpServer): void {
  if (
    server.transport !== "stdio" &&
    server.environmentId !== undefined &&
    server.environmentId !== "local"
  ) {
    throw new McpValidationError(
      `Server "${server.name}": Codex environment_id has no verified OpenCode equivalent`,
    );
  }
  const authority = Object.keys(server.extras ?? {}).filter((field) =>
    UNMAPPED_MCP_AUTHORITY.has(field),
  );
  if (
    server.transport !== "stdio" &&
    server.oauthScopesConfigured &&
    (!isRecord(server.oauth) || server.oauth.scope === undefined)
  ) {
    authority.push("scopes");
  }
  if (authority.length > 0) {
    throw new McpValidationError(
      `Server "${server.name}": MCP authority field(s) have no verified OpenCode equivalent: ${authority.join(", ")}`,
    );
  }
}

function serializeOpenCodeMcp(model: McpModel): { content: string; warnings: string[] } {
  const mcp: Record<string, unknown> = {};
  const warnings = [...model.warnings];
  for (const sourceServer of model.servers) {
    const server =
      model.source === "vscode"
        ? projectVsCodeServerToOpenCode(sourceServer)
        : model.source === "copilot"
          ? projectCopilotServerToOpenCode(sourceServer)
          : sourceServer;
    assertOpenCodeMcpAuthority(server);
    validateOpenCodeTimeout(server.name, server.timeout);
    if (model.source === "copilot" && server.transport === "stdio") {
      throw new McpValidationError(
        `Server "${server.name}": Copilot stdio environment isolation has no verified OpenCode equivalent`,
      );
    }
    if (server.sandboxEnabled === true) {
      throw new McpValidationError(
        `Server "${server.name}" requires a sandbox, but OpenCode MCP has no verified sandbox equivalent`,
      );
    }
    const projected =
      server.transport === "stdio"
        ? [server.name, server.command, server.args, server.cwd, server.env]
        : [
            server.name,
            server.url,
            server.headers,
            server.envHeaders,
            server.bearerTokenEnvVar,
            server.oauth,
          ];
    const unverifiedReferences =
      model.source === "copilot" && server.transport !== "stdio"
        ? [server.name, server.url, server.oauth]
        : projected;
    if (model.source !== "vscode" && containsOpenCodeReference(unverifiedReferences)) {
      throw new McpValidationError(
        "An MCP server contains OpenCode configuration-reference syntax with no verified source equivalent",
      );
    }
    const dropped = commonLosses(server);
    if (server.transport === "sse") dropped.push("transport=sse");
    if (dropped.length > 0) {
      warnings.push(
        `Server "${server.name}": dropped fields not supported by OpenCode MCP: ${dropped.join(", ")}.`,
      );
    }
    if (server.transport === "stdio") {
      mcp[server.name] = stripUndefined({
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        cwd: server.cwd,
        environment: server.env,
        enabled: server.enabled,
        timeout: server.timeout,
      });
    } else {
      if (server.envHeaders || server.bearerTokenEnvVar) {
        warnings.push(
          `Server "${server.name}": converted Codex environment-backed HTTP headers to OpenCode references; missing or empty variables become empty header values instead of being omitted or rejected.`,
        );
      }
      mcp[server.name] = stripUndefined({
        type: "remote",
        url: server.url,
        headers: projectDynamicHeaders(server, "opencode"),
        oauth: projectOpenCodeOAuth(server, warnings),
        enabled: server.enabled,
        timeout: server.timeout,
      });
    }
  }
  if (model.inputs.length > 0) {
    warnings.push(
      `Dropped ${model.inputs.length} top-level "inputs" placeholder(s): OpenCode MCP has no equivalent.`,
    );
  }
  return { content: `${JSON.stringify({ mcp }, null, 2)}\n`, warnings };
}

function serializeCodexOpenCodeMcp(model: McpModel): { content: string; warnings: string[] } {
  for (const server of model.servers) assertOpenCodeMcpAuthority(server);
  const stdio = model.servers.find((server) => server.transport === "stdio");
  if (stdio) {
    throw new McpValidationError(
      `Server "${stdio.name}": Codex stdio environment isolation has no verified OpenCode equivalent`,
    );
  }
  return serializeOpenCodeMcp(model);
}

type ParseFn = (raw: string) => McpModel;
type SerializeFn = (model: McpModel) => { content: string; warnings: string[] };

function withParseDiagnostics(parse: ParseFn, format: "JSON" | "TOML"): ParseFn {
  return (raw) => {
    try {
      return parse(raw);
    } catch (error) {
      const isParserError =
        error instanceof SyntaxError || (error instanceof Error && error.name === "TomlError");
      if (isParserError) {
        throw new McpValidationError(`MCP source document must contain valid ${format}`);
      }
      throw error;
    }
  };
}

function errorResult(error: unknown, targetName: string): ReturnType<Translator> {
  if (!(error instanceof McpValidationError)) return null;
  return { content: "", targetName, errors: [error.message], skipWrite: true };
}

function translateTo(
  parse: ParseFn,
  serialize: SerializeFn,
  targetName: string,
  wouldWrite: (model: McpModel) => boolean = (model) => model.servers.length > 0,
): Translator {
  return (raw) => {
    try {
      const model = parse(raw);
      if (model.servers.length === 0 && model.inputs.length === 0) return null;
      const { content, warnings } = serialize(model);
      return {
        content,
        targetName,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(!wouldWrite(model) ? { skipWrite: true } : {}),
      };
    } catch (error) {
      return errorResult(error, targetName);
    }
  };
}

const toVsCode = (parse: ParseFn) => translateTo(parse, serializeVsCodeMcp, "mcp.json");
const toMcpServers = (parse: ParseFn) =>
  translateTo(parse, serializeMcpServersJson, "mcp.json", (model) =>
    model.servers.some((server) => server.transport === "stdio"),
  );
const toCodex = (parse: ParseFn) => translateTo(parse, serializeCodexMcp, "config.toml");
const toOpenCode = (parse: ParseFn) => translateTo(parse, serializeOpenCodeMcp, "opencode.json");

const parseMcpServersJsonWithDiagnostics = withParseDiagnostics(parseMcpServersJson, "JSON");
const parseCopilotOpenCodeMcpWithDiagnostics = withParseDiagnostics(
  parseCopilotOpenCodeMcp,
  "JSON",
);
const parseCodexMcpWithDiagnostics = withParseDiagnostics(parseCodexMcp, "TOML");
const parseOpenCodeMcpWithDiagnostics = withParseDiagnostics(parseOpenCodeMcp, "JSON");

export const translateMcp = {
  claudeToCursor: toMcpServers(parseMcpServersJson),
  claudeToVsCode: toVsCode(parseMcpServersJson),
  claudeToCodex: toCodex(parseMcpServersJson),
  claudeToCopilot: toMcpServers(parseMcpServersJson),
  cursorToClaude: toMcpServers(parseMcpServersJson),
  cursorToVsCode: toVsCode(parseMcpServersJson),
  cursorToCodex: toCodex(parseMcpServersJson),
  cursorToCopilot: toMcpServers(parseMcpServersJson),
  vsCodeToClaude: toMcpServers(parseVsCodeMcp),
  vsCodeToCursor: toMcpServers(parseVsCodeMcp),
  vsCodeToCodex: toCodex(parseVsCodeMcp),
  vsCodeToCopilot: toMcpServers(parseVsCodeMcp),
  codexToClaude: toMcpServers(parseCodexMcp),
  codexToCursor: toMcpServers(parseCodexMcp),
  codexToVsCode: toVsCode(parseCodexMcp),
  codexToCopilot: toMcpServers(parseCodexMcp),
  copilotToClaude: toMcpServers(parseMcpServersJson),
  copilotToCursor: toMcpServers(parseMcpServersJson),
  copilotToVsCode: toVsCode(parseMcpServersJson),
  copilotToCodex: toCodex(parseMcpServersJson),
  claudeToOpenCode: toOpenCode(parseMcpServersJsonWithDiagnostics),
  cursorToOpenCode: toOpenCode(parseMcpServersJsonWithDiagnostics),
  codexToOpenCode: translateTo(
    parseCodexMcpWithDiagnostics,
    serializeCodexOpenCodeMcp,
    "opencode.json",
  ),
  copilotToOpenCode: toOpenCode(parseCopilotOpenCodeMcpWithDiagnostics),
  vsCodeToOpenCode: toOpenCode(parseVsCodeMcp),
  openCodeToClaude: toMcpServers(parseOpenCodeMcpWithDiagnostics),
  openCodeToCursor: toMcpServers(parseOpenCodeMcpWithDiagnostics),
  openCodeToCodex: toCodex(parseOpenCodeMcpWithDiagnostics),
  openCodeToCopilot: translateTo(
    parseOpenCodeMcpWithDiagnostics,
    serializeOpenCodeCopilotMcp,
    "mcp.json",
  ),
  openCodeToVsCode: toVsCode(parseOpenCodeMcpWithDiagnostics),
};
