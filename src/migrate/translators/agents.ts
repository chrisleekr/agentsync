import { basename } from "node:path";
import * as TOML from "@iarna/toml";
import type { Translator } from "../types";

export type PhysicalAgentFormat = "claude" | "cursor" | "codex" | "copilot" | "opencode";
export type SharedAgentTarget = "github-copilot" | "vscode";
type MarkdownAgentFormat = Exclude<PhysicalAgentFormat, "codex">;

interface ParsedAgent {
  identity: string;
  logicalIdentity: string;
  description: string;
  instructions: string;
  fields: Record<string, unknown>;
}

interface ParseResult {
  agent: ParsedAgent | null;
  errors: string[];
}

const CLAUDE_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "permissionMode",
  "mcpServers",
  "hooks",
  "maxTurns",
  "skills",
  "initialPrompt",
  "memory",
  "effort",
  "background",
  "isolation",
  "color",
]);
const CLAUDE_AUTHORITY_FIELDS = [
  "disallowedTools",
  "permissionMode",
  "mcpServers",
  "hooks",
  "skills",
  "memory",
  "isolation",
] as const;
const CLAUDE_LOSS_FIELDS = ["model", "initialPrompt", "effort", "background", "color"] as const;

const CURSOR_FIELDS = new Set(["name", "description", "model", "readonly", "is_background"]);
const CURSOR_LOSS_FIELDS = ["model", "is_background"] as const;

const CODEX_FIELDS = new Set([
  "name",
  "description",
  "developer_instructions",
  "model",
  "model_reasoning_effort",
  "sandbox_mode",
]);
const CODEX_LOSS_FIELDS = ["model", "model_reasoning_effort"] as const;

const SHARED_FIELDS = new Set([
  "name",
  "description",
  "target",
  "tools",
  "model",
  "disable-model-invocation",
  "user-invocable",
  "infer",
  "mcp-servers",
  "metadata",
  "argument-hint",
  "handoffs",
  "hooks",
  "agents",
]);
const SHARED_AUTHORITY_FIELDS = ["mcp-servers", "hooks", "agents"] as const;
const SHARED_LOSS_FIELDS = ["model", "metadata", "argument-hint", "handoffs"] as const;

const OPENCODE_FIELDS = new Set([
  "description",
  "mode",
  "model",
  "variant",
  "temperature",
  "top_p",
  "tools",
  "permission",
  "hidden",
  "disable",
  "color",
  "steps",
  "maxSteps",
]);
const OPENCODE_LOSS_FIELDS = [
  "model",
  "variant",
  "temperature",
  "top_p",
  "hidden",
  "color",
] as const;

function markdownAgentVendor(format: MarkdownAgentFormat): string {
  if (format === "copilot") return "shared Copilot/VS Code";
  if (format === "opencode") return "OpenCode";
  return format;
}

function markdownAgentFields(format: MarkdownAgentFormat): Set<string> {
  if (format === "claude") return CLAUDE_FIELDS;
  if (format === "cursor") return CURSOR_FIELDS;
  if (format === "opencode") return OPENCODE_FIELDS;
  return SHARED_FIELDS;
}

function targetVendor(format: PhysicalAgentFormat): string {
  if (format === "codex") return "Codex";
  if (format === "opencode") return "OpenCode";
  return "Shared Copilot/VS Code";
}

function rejected(sourceName: string, errors: string[]) {
  return {
    content: "",
    targetName: sourceName,
    errors,
    skipWrite: true,
  };
}

function splitFrontmatter(
  content: string,
): { fields: Record<string, unknown>; body: string } | { error: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { error: "Invalid YAML frontmatter: opening or closing marker is missing" };
  try {
    const parsed = Bun.YAML.parse(match[1] ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Invalid YAML frontmatter: expected a mapping" };
    }
    return {
      fields: parsed as Record<string, unknown>,
      body: content.slice(match[0].length).trim(),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `Invalid YAML frontmatter: ${detail}` };
  }
}

function serializeMarkdown(fields: Record<string, unknown>, body: string): string {
  const yaml = Bun.YAML.stringify(fields, null, 2).trimEnd();
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

function requiredString(
  fields: Record<string, unknown>,
  key: string,
  vendor: string,
  errors: string[],
): string {
  const value = fields[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${vendor} agent requires a non-empty '${key}' field`);
    return "";
  }
  return value.trim();
}

function unknownFieldErrors(
  fields: Record<string, unknown>,
  known: Set<string>,
  vendor: string,
): string[] {
  return Object.keys(fields)
    .filter((field) => !known.has(field))
    .map((field) => `Unknown ${vendor} field '${field}' may affect authority`);
}

function validateSourceName(format: PhysicalAgentFormat, sourceName: string): string[] {
  if (/\p{Cc}/u.test(sourceName)) return ["Source filename contains a control character"];
  if (sourceName.includes("\\") || sourceName.startsWith("/")) {
    return ["Source path is not a safe relative path"];
  }
  const segments = sourceName.split("/");
  if (segments.some((segment) => !segment || segment === "..")) {
    return ["Source path contains traversal"];
  }
  if (segments.some((segment) => segment.startsWith("."))) {
    return ["Source path contains a hidden segment"];
  }
  if (format !== "claude" && format !== "opencode" && segments.length !== 1) {
    return [`${format} agents must be direct children of their user directory`];
  }
  const expectedExtension =
    format === "codex" ? ".toml" : format === "copilot" ? ".agent.md" : ".md";
  if (!sourceName.endsWith(expectedExtension)) {
    return [`${format} agent filename must end with '${expectedExtension}'`];
  }
  return [];
}

export function portableFilenameError(name: string, subject: string): string | undefined {
  if (/\p{Cc}/u.test(name)) return `${subject} contains a control character`;
  if (/[:*?"<>|]/.test(name)) return `${subject} contains a Windows-reserved character`;
  if (name.endsWith(".") || name.endsWith(" ")) {
    return `${subject} has a Windows-reserved trailing dot or space`;
  }
  const stem = (name.split(".")[0] ?? "").toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM(?:[1-9]|[¹²³])|LPT(?:[1-9]|[¹²³]))$/.test(stem)) {
    return `${subject} uses a Windows-reserved device name`;
  }
  return undefined;
}

function sourceStem(format: PhysicalAgentFormat, sourceName: string): string {
  if (format === "opencode") return sourceName.slice(0, -".md".length);
  const filename = basename(sourceName);
  if (format === "copilot") return filename.slice(0, -".agent.md".length);
  if (format === "codex") return filename.slice(0, -".toml".length);
  return filename.slice(0, -".md".length);
}

function parseMarkdownAgent(
  format: MarkdownAgentFormat,
  content: string,
  sourceName: string,
): ParseResult {
  const nameErrors = validateSourceName(format, sourceName);
  const parsed = splitFrontmatter(content);
  if ("error" in parsed) return { agent: null, errors: [...nameErrors, parsed.error] };

  const vendor = markdownAgentVendor(format);
  const known = markdownAgentFields(format);
  const errors = [...nameErrors, ...unknownFieldErrors(parsed.fields, known, vendor)];
  let identity: string;
  if (format === "claude") {
    identity = requiredString(parsed.fields, "name", vendor, errors);
  } else if (format === "copilot" || format === "opencode") {
    identity = sourceStem(format, sourceName);
    if (
      format === "copilot" &&
      parsed.fields.name !== undefined &&
      (typeof parsed.fields.name !== "string" || !parsed.fields.name.trim())
    ) {
      errors.push(`${vendor} agent optional 'name' field must be a non-empty string`);
    }
  } else if (parsed.fields.name === undefined) {
    identity = sourceStem(format, sourceName);
  } else if (typeof parsed.fields.name === "string" && parsed.fields.name.trim()) {
    identity = parsed.fields.name.trim();
  } else {
    errors.push(`${vendor} agent optional 'name' field must be a non-empty string`);
    identity = sourceStem(format, sourceName);
  }
  const logicalIdentity =
    format === "copilot" || format === "opencode" ? sourceStem(format, sourceName) : identity;
  let description = "";
  if (format === "cursor" && parsed.fields.description === undefined) {
    description = "";
  } else {
    description = requiredString(parsed.fields, "description", vendor, errors);
  }

  if (format === "claude" && identity && !/^[a-z][a-z-]*$/.test(identity)) {
    errors.push("Claude agent 'name' must use lowercase letters and hyphens");
  }
  if (
    format === "claude" &&
    parsed.fields.maxTurns !== undefined &&
    (!Number.isSafeInteger(parsed.fields.maxTurns) || (parsed.fields.maxTurns as number) <= 0)
  ) {
    errors.push("Claude agent 'maxTurns' must be a positive integer");
  }
  if (format === "cursor" && identity && !/^[a-z][a-z-]*$/.test(identity)) {
    errors.push("Cursor agent identity must use lowercase letters and hyphens");
  }
  if (format === "copilot" && parsed.fields.target !== undefined) {
    const target = parsed.fields.target;
    if (target !== "vscode" && target !== "github-copilot") {
      errors.push("Shared agent 'target' must be 'vscode' or 'github-copilot'");
    }
  }
  if (format === "copilot") {
    for (const [field, restrictiveValue] of [
      ["disable-model-invocation", true],
      ["user-invocable", false],
      ["infer", false],
    ] as const) {
      const value = parsed.fields[field];
      if (value !== undefined && typeof value !== "boolean") {
        errors.push(`Shared agent '${field}' must be a boolean`);
      } else if (value === restrictiveValue) {
        errors.push(`Shared authority field '${field}' has no verified target mapping`);
      }
    }
  }
  if (format === "copilot" && Array.from(parsed.body).length > 30_000) {
    errors.push("Shared agent prompt exceeds the 30,000-character maximum");
  }
  if (format === "opencode") {
    if (parsed.fields.mode !== "subagent") {
      errors.push("OpenCode agent 'mode' must be 'subagent' for cross-agent migration");
    }
    if (parsed.fields.hidden !== undefined && typeof parsed.fields.hidden !== "boolean") {
      errors.push("OpenCode agent 'hidden' must be a boolean");
    }
    if (parsed.fields.disable !== undefined && typeof parsed.fields.disable !== "boolean") {
      errors.push("OpenCode agent 'disable' must be a boolean");
    }
    if (parsed.fields.tools !== undefined) {
      if (
        !isRecord(parsed.fields.tools) ||
        Object.values(parsed.fields.tools).some((value) => typeof value !== "boolean")
      ) {
        errors.push("OpenCode agent 'tools' must be a mapping of boolean values");
      }
    }
    if (parsed.fields.permission !== undefined && !isRecord(parsed.fields.permission)) {
      errors.push("OpenCode agent 'permission' must be a mapping");
    }
    for (const field of ["steps", "maxSteps"] as const) {
      const value = parsed.fields[field];
      if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
        errors.push(`OpenCode agent '${field}' must be a positive integer`);
      }
    }
  }

  return {
    agent: {
      identity,
      logicalIdentity,
      description,
      instructions: parsed.body,
      fields: parsed.fields,
    },
    errors,
  };
}

function parseCodexAgent(content: string, sourceName: string): ParseResult {
  const errors = validateSourceName("codex", sourceName);
  let fields: Record<string, unknown>;
  try {
    const parsed = TOML.parse(content);
    fields = parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { agent: null, errors: [...errors, `Invalid TOML agent: ${detail}`] };
  }

  errors.push(...unknownFieldErrors(fields, CODEX_FIELDS, "Codex"));
  const identity = requiredString(fields, "name", "Codex", errors);
  if (typeof fields.name === "string") {
    const portableError = portableFilenameError(fields.name, "Codex target identity");
    if (portableError) errors.push(portableError);
  }
  const description = requiredString(fields, "description", "Codex", errors);
  const instructions = requiredString(fields, "developer_instructions", "Codex", errors);
  return {
    agent: { identity, logicalIdentity: identity, description, instructions, fields },
    errors,
  };
}

function parseAgent(format: PhysicalAgentFormat, content: string, sourceName: string): ParseResult {
  if (format === "codex") return parseCodexAgent(content, sourceName);
  return parseMarkdownAgent(format, content, sourceName);
}

function stringList(value: unknown, field: string, errors: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  const values =
    typeof value === "string"
      ? value.split(",").map((entry) => entry.trim())
      : Array.isArray(value)
        ? value
        : null;
  if (!values || values.some((entry) => typeof entry !== "string")) {
    errors.push(`'${field}' must be a string or a list of strings`);
    return undefined;
  }
  return values as string[];
}

interface ToolGroup {
  shared: string;
  claude: readonly string[];
  sharedAliases: readonly string[];
  claudeAlternatives?: readonly string[];
}

const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    shared: "execute",
    claude: ["Bash", "PowerShell"],
    sharedAliases: ["execute", "shell", "bash", "powershell"],
  },
  { shared: "read", claude: ["Read"], sharedAliases: ["read", "notebookread"] },
  {
    shared: "edit",
    claude: ["Edit", "Write", "NotebookEdit"],
    sharedAliases: ["edit", "multiedit", "write", "notebookedit"],
  },
  { shared: "search", claude: ["Grep", "Glob"], sharedAliases: ["search", "grep", "glob"] },
  {
    shared: "agent",
    claude: ["Agent"],
    claudeAlternatives: ["Task"],
    sharedAliases: ["agent", "custom-agent", "task"],
  },
  {
    shared: "web",
    claude: ["WebSearch", "WebFetch"],
    sharedAliases: ["web", "websearch", "webfetch"],
  },
  { shared: "todo", claude: ["TodoWrite"], sharedAliases: ["todo", "todowrite"] },
] as const;

const CLAUDE_TOOL_GROUP = new Map<string, ToolGroup>();
const SHARED_TOOL_GROUP = new Map<string, ToolGroup>();
for (const group of TOOL_GROUPS) {
  for (const tool of group.claude) CLAUDE_TOOL_GROUP.set(tool, group);
  for (const tool of group.claudeAlternatives ?? []) CLAUDE_TOOL_GROUP.set(tool, group);
  for (const alias of group.sharedAliases) SHARED_TOOL_GROUP.set(alias, group);
}

function mapClaudeTools(tools: string[], errors: string[]): string[] {
  const selected = new Set(tools);
  const groups: ToolGroup[] = [];
  for (const tool of tools) {
    const group = CLAUDE_TOOL_GROUP.get(tool);
    if (!group) {
      errors.push(`Tool '${tool}' has no verified authority mapping`);
      continue;
    }
    if (!groups.includes(group)) groups.push(group);
  }
  for (const group of groups) {
    const complete = group.claudeAlternatives
      ? group.claude.some((tool) => selected.has(tool)) ||
        group.claudeAlternatives.some((tool) => selected.has(tool))
      : group.claude.every((tool) => selected.has(tool));
    if (!complete)
      errors.push(`Claude tool group '${group.shared}' is incomplete and cannot be widened`);
  }
  return groups.map((group) => group.shared);
}

function mapSharedTools(tools: string[], errors: string[]): string[] | undefined {
  if (tools.length === 1 && tools[0] === "*") return undefined;
  const mapped: string[] = [];
  for (const tool of tools) {
    const group = SHARED_TOOL_GROUP.get(tool.toLowerCase());
    if (!group) {
      errors.push(`Tool '${tool}' has no verified authority mapping`);
      continue;
    }
    for (const claudeTool of group.claude) {
      if (!mapped.includes(claudeTool)) mapped.push(claudeTool);
    }
  }
  return mapped;
}

function presentFields(fields: Record<string, unknown>, names: readonly string[]): string[] {
  return names.filter((name) => fields[name] !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lossWarnings(fields: Record<string, unknown>, names: readonly string[]): string[] {
  const lost = presentFields(fields, names);
  return lost.length > 0 ? [`Dropped known non-authority field(s): ${lost.join(", ")}`] : [];
}

function normalizeHyphenIdentity(
  identity: string,
  vendor: string,
): { value: string; error?: string } {
  if (/\p{Cc}/u.test(identity) || /[/\\]/.test(identity) || identity.startsWith(".")) {
    return { value: "", error: `${vendor} target identity is not path-safe` };
  }
  const normalized = identity
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  if (!/^[a-z][a-z-]*$/.test(normalized)) {
    return { value: "", error: `${vendor} target identity must use lowercase letters and hyphens` };
  }
  const portableError = portableFilenameError(normalized, `${vendor} target identity`);
  if (portableError) return { value: "", error: portableError };
  return { value: normalized };
}

function safeUnconstrainedIdentity(
  identity: string,
  vendor: string,
): { value: string; error?: string } {
  if (!identity || /\p{Cc}/u.test(identity) || /[/\\]/.test(identity) || identity.startsWith(".")) {
    return { value: "", error: `${vendor} target identity is not path-safe` };
  }
  const portableError = portableFilenameError(identity, `${vendor} target identity`);
  if (portableError) return { value: "", error: portableError };
  return { value: identity };
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function translate(
  from: PhysicalAgentFormat,
  to: PhysicalAgentFormat,
  content: string,
  sourceName: string,
) {
  const parsed = parseAgent(from, content, sourceName);
  if (!parsed.agent) return rejected(sourceName, parsed.errors);

  const errors = [...parsed.errors];
  const warnings: string[] = [];
  const { fields } = parsed.agent;
  let mappedTools: string[] | undefined;
  let readonly = false;
  let executionSteps: number | undefined;

  if (from === "claude") {
    for (const field of presentFields(fields, CLAUDE_AUTHORITY_FIELDS)) {
      errors.push(`Claude authority field '${field}' has no verified mapping to ${to}`);
    }
    const tools = stringList(fields.tools, "tools", errors);
    if (tools !== undefined) {
      if (to === "copilot") {
        mappedTools = mapClaudeTools(tools, errors);
      } else {
        errors.push(`Claude authority field 'tools' has no verified mapping to ${to}`);
      }
    }
    if (fields.maxTurns !== undefined) {
      if (to === "opencode") executionSteps = fields.maxTurns as number;
      else warnings.push("Dropped known non-authority field(s): maxTurns");
    }
    warnings.push(...lossWarnings(fields, CLAUDE_LOSS_FIELDS));
  }

  if (from === "cursor") {
    if (fields.readonly !== undefined && typeof fields.readonly !== "boolean") {
      errors.push("Cursor 'readonly' must be a boolean");
    } else if (fields.readonly === true) {
      if (to === "codex") readonly = true;
      else errors.push(`Cursor authority field 'readonly' has no verified mapping to ${to}`);
    }
    warnings.push(...lossWarnings(fields, CURSOR_LOSS_FIELDS));
  }

  if (from === "codex") {
    if (
      to === "cursor" &&
      (fields.sandbox_mode === undefined || fields.sandbox_mode === "read-only")
    ) {
      readonly = true;
    } else {
      errors.push(
        fields.sandbox_mode === undefined
          ? `Codex inherited sandbox authority has no verified mapping to ${to}`
          : `Codex authority field 'sandbox_mode' has no verified mapping to ${to}`,
      );
    }
    warnings.push(...lossWarnings(fields, CODEX_LOSS_FIELDS));
  }

  if (from === "copilot") {
    for (const field of presentFields(fields, SHARED_AUTHORITY_FIELDS)) {
      errors.push(`Shared authority field '${field}' has no verified mapping to ${to}`);
    }
    const tools = stringList(fields.tools, "tools", errors);
    if (tools !== undefined) {
      if (to === "claude") {
        mappedTools = mapSharedTools(tools, errors);
      } else {
        errors.push(`Shared authority field 'tools' has no verified mapping to ${to}`);
      }
    }
    warnings.push(...lossWarnings(fields, SHARED_LOSS_FIELDS));
    warnings.push(...lossWarnings(fields, ["disable-model-invocation", "user-invocable", "infer"]));
    if (typeof fields.name === "string" && fields.name.trim() !== parsed.agent.logicalIdentity) {
      warnings.push("Dropped known non-authority field(s): name");
    }
  }

  if (from === "opencode") {
    if (fields.permission !== undefined) {
      errors.push(`OpenCode authority field 'permission' has no verified mapping to ${to}`);
    }
    if (isRecord(fields.tools)) {
      const restricted = Object.entries(fields.tools).filter(([, enabled]) => enabled === false);
      if (restricted.length > 0) {
        errors.push(`OpenCode authority field 'tools' has no verified mapping to ${to}`);
      } else {
        warnings.push("Dropped known non-authority field(s): tools");
      }
    }
    if (fields.disable === true) {
      errors.push(`OpenCode authority field 'disable' has no verified mapping to ${to}`);
    } else if (fields.disable === false) {
      warnings.push("Dropped known non-authority field(s): disable");
    }
    for (const field of ["steps", "maxSteps"] as const) {
      if (fields[field] !== undefined) {
        errors.push(`OpenCode authority field '${field}' has no verified mapping to ${to}`);
      }
    }
    warnings.push(...lossWarnings(fields, OPENCODE_LOSS_FIELDS));
  }

  const targetIdentity =
    to === "claude" || to === "cursor"
      ? normalizeHyphenIdentity(parsed.agent.identity, to)
      : safeUnconstrainedIdentity(parsed.agent.identity, targetVendor(to));
  if (targetIdentity.error) errors.push(targetIdentity.error);
  if (!parsed.agent.description && from === "cursor") {
    errors.push(`${to} target requires a description that the Cursor source does not define`);
  }
  if (to === "codex" && !parsed.agent.instructions) {
    errors.push("Codex target requires non-empty developer instructions");
  }
  if (errors.length > 0) return rejected(sourceName, errors);

  const identity = targetIdentity.value;
  if (to === "opencode") {
    return {
      content: serializeMarkdown(
        {
          description: parsed.agent.description,
          mode: "subagent",
          ...(executionSteps !== undefined ? { steps: executionSteps } : {}),
        },
        parsed.agent.instructions,
      ),
      targetName: `${identity}.md`,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
  if (to === "codex") {
    const targetFields: TOML.JsonMap = {
      name: identity,
      description: parsed.agent.description,
      developer_instructions: parsed.agent.instructions,
    };
    if (readonly) targetFields.sandbox_mode = "read-only";
    return {
      content: TOML.stringify(targetFields),
      targetName: `${identity}.toml`,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  const targetFields: Record<string, unknown> = {
    name: identity,
    description: parsed.agent.description,
  };
  if (to === "cursor" && readonly) targetFields.readonly = true;
  if ((to === "claude" || to === "copilot") && mappedTools !== undefined) {
    targetFields.tools = mappedTools;
  }
  if (to === "copilot" && characterCount(parsed.agent.instructions) > 30_000) {
    return rejected(sourceName, ["Shared agent prompt exceeds the 30,000-character maximum"]);
  }
  const extension = to === "copilot" ? ".agent.md" : ".md";
  return {
    content: serializeMarkdown(targetFields, parsed.agent.instructions),
    targetName: `${identity}${extension}`,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function makeTranslator(from: PhysicalAgentFormat, to: PhysicalAgentFormat): Translator {
  return (content, sourceName) => {
    if (!content.trim() || !sourceName) return null;
    return translate(from, to, content.trim(), sourceName);
  };
}

export function inspectAgentSource(
  format: PhysicalAgentFormat,
  content: string,
  sourceName: string,
): { identity: string | null; errors: string[] } {
  const parsed = parseAgent(format, content.trim(), sourceName);
  return { identity: parsed.agent?.logicalIdentity ?? null, errors: parsed.errors };
}

export function setSharedAgentTarget(
  content: string,
  target: SharedAgentTarget | undefined,
): string {
  const parsed = splitFrontmatter(content);
  if ("error" in parsed) throw new Error(parsed.error);
  const fields = { ...parsed.fields };
  if (target) fields.target = target;
  else delete fields.target;
  return serializeMarkdown(fields, parsed.body);
}

export function getSharedAgentTarget(content: string): SharedAgentTarget | undefined {
  const parsed = splitFrontmatter(content);
  if ("error" in parsed) return undefined;
  const target = parsed.fields.target;
  return target === "github-copilot" || target === "vscode" ? target : undefined;
}

export const translateAgent = {
  claudeToCursor: makeTranslator("claude", "cursor"),
  claudeToCodex: makeTranslator("claude", "codex"),
  claudeToCopilot: makeTranslator("claude", "copilot"),
  cursorToClaude: makeTranslator("cursor", "claude"),
  cursorToCodex: makeTranslator("cursor", "codex"),
  cursorToCopilot: makeTranslator("cursor", "copilot"),
  codexToClaude: makeTranslator("codex", "claude"),
  codexToCursor: makeTranslator("codex", "cursor"),
  codexToCopilot: makeTranslator("codex", "copilot"),
  copilotToClaude: makeTranslator("copilot", "claude"),
  copilotToCursor: makeTranslator("copilot", "cursor"),
  copilotToCodex: makeTranslator("copilot", "codex"),
  claudeToOpenCode: makeTranslator("claude", "opencode"),
  cursorToOpenCode: makeTranslator("cursor", "opencode"),
  codexToOpenCode: makeTranslator("codex", "opencode"),
  copilotToOpenCode: makeTranslator("copilot", "opencode"),
  openCodeToClaude: makeTranslator("opencode", "claude"),
  openCodeToCursor: makeTranslator("opencode", "cursor"),
  openCodeToCodex: makeTranslator("opencode", "codex"),
  openCodeToCopilot: makeTranslator("opencode", "copilot"),
} as const;
