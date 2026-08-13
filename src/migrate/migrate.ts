/**
 * src/migrate/migrate.ts
 *
 * Orchestrator for cross-agent configuration migration.
 * Reads source configs, dispatches to translators, detects secrets,
 * and writes to target agent config files.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";
import * as TOML from "@iarna/toml";
import {
  applyEdits as applyJsoncEdits,
  modify as modifyJsonc,
  type ParseError,
  parse as parseJsonc,
} from "jsonc-parser";
import { atomicWrite, readIfExists, setJsoncTopLevelKey } from "../agents/_utils";
import { InvalidSkillNameError, validateSkillName } from "../agents/skills-walker";
import {
  AgentPaths,
  resolveOpenCodeConfigDirs,
  resolveOpenCodeConfigFiles,
  resolveOpenCodeWriteDir,
} from "../config/paths";
import { redactSecretLiterals, scanForSecrets } from "../core/sanitizer";
import { MIGRATION_AGENTS, type MigrationAgentName } from "./agent-names";
import { getTranslator } from "./registry";
import {
  getSharedAgentTarget,
  inspectAgentSource,
  type PhysicalAgentFormat,
  portableFilenameError,
  type SharedAgentTarget,
  setSharedAgentTarget,
} from "./translators/agents";
import { validateOpenCodeMcpLayer } from "./translators/mcp";
import { openCodeSkillContractErrors } from "./translators/skills";
import type {
  ConfigType,
  ExtraFile,
  MigratedArtifact,
  MigrateOptions,
  MigrateResult,
  Translator,
} from "./types";

const ALL_CONFIG_TYPES: ConfigType[] = [
  "global-rules",
  "mcp",
  "commands",
  "skills",
  "rules",
  "agents",
];

/** Heuristic: well-known text suffixes are utf8, everything else base64. */
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdc",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
  ".bash",
  ".zsh",
  ".js",
  ".ts",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".html",
  ".css",
]);

function looksLikeText(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(filename.slice(dot).toLowerCase());
}

/**
 * Pick the right skills directory for an agent.
 * Codex prefers `~/.agents/skills/` (current spec, cites agentskills.io)
 * with `~/.codex/skills/` as legacy fallback when the former is absent.
 */
async function resolveSkillsSourceDir(agent: MigrationAgentName): Promise<string | null> {
  if (agent === "claude") return AgentPaths.claude.skillsDir;
  if (agent === "cursor") return AgentPaths.cursor.skillsDir;
  if (agent === "copilot") return AgentPaths.copilot.skillsDir;
  if (agent === "codex") {
    const preferred = AgentPaths.codex.userSkillsDir;
    try {
      await stat(preferred);
      return preferred;
    } catch {
      return AgentPaths.codex.skillsDir;
    }
  }
  return null;
}

function resolveSkillsTargetDir(agent: MigrationAgentName): string | null {
  if (agent === "claude") return AgentPaths.claude.skillsDir;
  if (agent === "cursor") return AgentPaths.cursor.skillsDir;
  if (agent === "copilot") return AgentPaths.copilot.skillsDir;
  if (agent === "codex") return AgentPaths.codex.userSkillsDir;
  if (agent === "opencode") return join(resolveOpenCodeWriteDir(), "skills");
  return null;
}

function resolveRulesDir(agent: MigrationAgentName): string | null {
  if (agent === "claude") return AgentPaths.claude.rulesDir;
  if (agent === "cursor") return AgentPaths.cursor.rulesDir;
  if (agent === "codex") return AgentPaths.codex.rulesDir;
  return null;
}

function canonicalAgentFormat(agent: MigrationAgentName): PhysicalAgentFormat {
  return agent === "vscode" ? "copilot" : agent;
}

function resolveAgentsDir(agent: MigrationAgentName): string {
  if (agent === "claude") return AgentPaths.claude.agentsDir;
  if (agent === "cursor") return AgentPaths.cursor.agentsDir;
  if (agent === "codex") return AgentPaths.codex.agentsDir;
  if (agent === "vscode") return AgentPaths.vscode.agentsDir;
  if (agent === "opencode") return join(resolveOpenCodeWriteDir(), "agents");
  return AgentPaths.copilot.agentsDir;
}

function agentExtension(format: PhysicalAgentFormat): string {
  if (format === "codex") return ".toml";
  if (format === "copilot") return ".agent.md";
  return ".md";
}

function toPosixRelative(path: string): string {
  return path.split(sep).join("/");
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

const OPEN_CODE_BOOLEAN_FLAGS = [
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
] as const;
type OpenCodeBooleanFlag = (typeof OPEN_CODE_BOOLEAN_FLAGS)[number];
const OPEN_CODE_TRUE_VALUES = new Set(["true", "yes", "on", "1", "y"]);
const OPEN_CODE_FALSE_VALUES = new Set(["false", "no", "off", "0", "n"]);

function openCodeBooleanFlag(name: OpenCodeBooleanFlag, env = process.env): boolean {
  const value = env[name];
  if (value === undefined) return false;
  if (OPEN_CODE_TRUE_VALUES.has(value)) return true;
  if (OPEN_CODE_FALSE_VALUES.has(value)) return false;
  throw new Error(
    `${name} must be one of true, yes, on, 1, y, false, no, off, 0, or n (case-sensitive)`,
  );
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function openCodeEnvironmentErrors(env: NodeJS.ProcessEnv = process.env): string[] {
  const errors: string[] = [];
  if (env.OPENCODE_CONFIG) {
    errors.push(
      "OPENCODE_CONFIG is not supported by AgentSync migration; unset it and use OPENCODE_CONFIG_DIR instead",
    );
  }
  if (env.OPENCODE_CONFIG_CONTENT) {
    errors.push(
      "OPENCODE_CONFIG_CONTENT is not supported by AgentSync migration; unset it before migrating OpenCode configuration",
    );
  }
  for (const flag of OPEN_CODE_BOOLEAN_FLAGS) {
    try {
      openCodeBooleanFlag(flag, env);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

function openCodeDiscoversSharedSkill(
  source: MigrationAgentName,
  sourcePath: string,
  env = process.env,
): boolean {
  if (openCodeBooleanFlag("OPENCODE_DISABLE_EXTERNAL_SKILLS", env)) return false;
  if (source === "claude") {
    return (
      !openCodeBooleanFlag("OPENCODE_DISABLE_CLAUDE_CODE", env) &&
      !openCodeBooleanFlag("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", env)
    );
  }
  return (
    source === "codex" &&
    resolve(sourcePath).startsWith(`${resolve(AgentPaths.codex.userSkillsDir)}${sep}`)
  );
}

function assertOpenCodeEnvironment(): void {
  const errors = openCodeEnvironmentErrors();
  if (errors.length > 0) throw new Error(errors.join("; "));
}

interface SourceArtifact {
  content: string;
  name: string;
  sourcePath: string;
  sidecars?: ExtraFile[];
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

async function collectOpenCodeMarkdown(
  kind: "command" | "agent",
  filterName?: string,
): Promise<SourceArtifact[]> {
  const results: SourceArtifact[] = [];
  const identities = new Map<string, string>();
  for (const configDir of resolveOpenCodeConfigDirs()) {
    for (const directoryName of [kind, `${kind}s`]) {
      const root = join(configDir, directoryName);
      await assertExistingDirectoryComponents(root, `OpenCode ${kind} source directory component`);
      const rootInfo = await lstatIfExists(root);
      if (!rootInfo) continue;
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error(`OpenCode ${kind} source directory '${root}' must be a real directory`);
      }

      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const filePath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(filePath);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const name = toPosixRelative(relative(root, filePath));
          if (filterName && filterName !== name) continue;
          const key = normalizedIdentity(name.slice(0, -".md".length));
          const existing = identities.get(key);
          if (existing) {
            throw new Error(
              `Duplicate OpenCode ${kind} identity '${name.slice(0, -".md".length)}' in ${existing} and ${filePath}`,
            );
          }
          identities.set(key, filePath);
          results.push({ content: await readAgentFile(filePath), name, sourcePath: filePath });
        }
      }

      await walk(root);
    }
  }
  return results;
}

function validateOpenCodeSkill(content: string, name: string, sourcePath: string): void {
  const errors = openCodeSkillContractErrors(content, name);
  if (errors.length > 0) throw new Error(`OpenCode skill '${sourcePath}': ${errors.join("; ")}`);
}

async function collectOpenCodeSkills(filterName?: string): Promise<SourceArtifact[]> {
  const results: SourceArtifact[] = [];
  const identities = new Map<string, string>();
  const discovered: Array<{ name: string; skillDir: string; skillMdPath: string }> = [];
  for (const configDir of resolveOpenCodeConfigDirs()) {
    for (const directoryName of ["skill", "skills"]) {
      const root = join(configDir, directoryName);
      await assertExistingDirectoryComponents(root, "OpenCode skill source directory component");
      const rootInfo = await lstatIfExists(root);
      if (!rootInfo) continue;
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new Error(`OpenCode skill source directory '${root}' must be a real directory`);
      }

      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const entryPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(entryPath);
            continue;
          }
          if (!entry.isFile() || entry.name !== "SKILL.md") continue;
          const name = basename(dir);
          validateSkillName(name);
          discovered.push({ name, skillDir: dir, skillMdPath: entryPath });
        }
      }

      await walk(root);
    }
  }

  const skillRoots = new Set(discovered.map(({ skillDir }) => resolve(skillDir)));
  for (const { name, skillDir, skillMdPath } of discovered) {
    if (filterName && filterName !== name) continue;
    const key = normalizedIdentity(name);
    const existing = identities.get(key);
    if (existing) {
      throw new Error(
        `Duplicate OpenCode skill identity '${name}' in ${existing} and ${skillMdPath}`,
      );
    }
    const content = await readAgentFile(skillMdPath);
    validateOpenCodeSkill(content, name, skillMdPath);
    identities.set(key, skillMdPath);
    results.push({
      content,
      name,
      sourcePath: skillMdPath,
      sidecars: await readSkillSidecars(skillDir, skillRoots),
    });
  }
  return results;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeOpenCodeConfig(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeOpenCodeConfig(existing, value)
        : value;
  }
  return merged;
}

function parseOpenCodeConfig(raw: string, sourcePath: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    throw new Error(`OpenCode config '${sourcePath}' must contain a valid JSONC object`);
  }
  if (parsed.mcp !== undefined) {
    try {
      validateOpenCodeMcpLayer(parsed.mcp);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenCode config '${sourcePath}' has invalid MCP configuration: ${detail}`);
    }
  }
  return parsed;
}

const OPEN_CODE_JSONC_FORMATTING = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
} as const;
const OPEN_CODE_CONFIG_REFERENCE = /\{(?:env:[^}]+|file:[^}]+)\}/;

function patchOpenCodeMcp(
  existing: string,
  incomingMcp: Record<string, unknown>,
  targetPath: string,
): string {
  const raw = existing.trim() ? existing : "{}\n";
  const parsed = parseOpenCodeConfig(raw, targetPath);
  if (parsed.mcp !== undefined && !isPlainObject(parsed.mcp)) {
    throw new Error(`OpenCode config '${targetPath}' must contain an 'mcp' object`);
  }
  let patched = raw;
  for (const [serverName, server] of Object.entries(incomingMcp)) {
    patched = applyJsoncEdits(
      patched,
      modifyJsonc(patched, ["mcp", serverName], server, {
        formattingOptions: OPEN_CODE_JSONC_FORMATTING,
      }),
    );
  }
  return patched;
}

async function assertNoOpenCodeLowerMcpCollisions(
  targetPath: string,
  incomingNames: readonly string[],
): Promise<void> {
  const sources = resolveOpenCodeConfigFiles();
  const targetIndex = sources.findIndex(
    (sourcePath) => resolve(sourcePath) === resolve(targetPath),
  );
  if (targetIndex < 0) {
    throw new Error(`OpenCode MCP target '${targetPath}' is not a configured global source`);
  }
  const incoming = new Set(incomingNames);
  for (const sourcePath of sources.slice(0, targetIndex)) {
    const raw = await readRegularTextIfExists(sourcePath, "OpenCode config source");
    if (raw === null) continue;
    const parsed = parseOpenCodeConfig(raw, sourcePath);
    if (!isPlainObject(parsed.mcp)) continue;
    const lowerNames = Object.keys(parsed.mcp);
    if (lowerNames.some((name) => OPEN_CODE_CONFIG_REFERENCE.test(name))) {
      throw new Error(
        `OpenCode MCP source '${sourcePath}' contains a configuration reference in a server name; consolidate the layered definitions before migrating`,
      );
    }
    const collisions = lowerNames.filter((name) => incoming.has(name));
    if (collisions.length > 0) {
      throw new Error(
        `OpenCode MCP server(s) ${collisions.map((name) => `'${name}'`).join(", ")} also exist in lower-precedence source '${sourcePath}'; consolidate the layered definitions before migrating`,
      );
    }
  }
}

async function readOpenCodeEffectiveConfig(): Promise<{
  config: Record<string, unknown>;
  sourcePaths: string[];
}> {
  let config: Record<string, unknown> = {};
  const sourcePaths: string[] = [];
  for (const sourcePath of resolveOpenCodeConfigFiles()) {
    const raw = await readRegularTextIfExists(sourcePath, "OpenCode config source");
    if (raw === null) continue;
    config = mergeOpenCodeConfig(config, parseOpenCodeConfig(raw, sourcePath));
    sourcePaths.push(sourcePath);
  }
  return { config, sourcePaths };
}

async function resolveOpenCodeConfigTarget(): Promise<string> {
  const dir = resolveOpenCodeWriteDir();
  const dirInfo = await lstatIfExists(dir);
  if (dirInfo && (!dirInfo.isDirectory() || dirInfo.isSymbolicLink())) {
    throw new Error(`OpenCode config directory '${dir}' must be a real directory`);
  }
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const targetPath = join(dir, name);
    const info = await lstatIfExists(targetPath);
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`OpenCode config target '${targetPath}' must be a regular file`);
    }
    return targetPath;
  }
  return join(dir, "opencode.json");
}

async function readAgentFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Agent source '${path}' must be a regular file`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readAgentFiles(agent: MigrationAgentName, filterName?: string) {
  if (agent === "opencode") return collectOpenCodeMarkdown("agent", filterName);
  const format = canonicalAgentFormat(agent);
  const root = resolveAgentsDir(agent);
  const extension = agentExtension(format);
  const results: Array<{ content: string; name: string; sourcePath: string }> = [];
  const rootInfo = await lstat(root).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (!rootInfo) return results;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Agent source directory '${root}' must be a real directory`);
  }

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (format === "claude") await walk(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(extension)) continue;
      const name = format === "claude" ? toPosixRelative(relative(root, filePath)) : entry.name;
      if (filterName && name !== filterName) continue;
      const content = await readAgentFile(filePath);
      if (format === "copilot") {
        const target = getSharedAgentTarget(content);
        if (agent === "copilot" && target === "vscode") continue;
        if (agent === "vscode" && target === "github-copilot") continue;
      }
      results.push({ content, name, sourcePath: filePath });
    }
  }

  await walk(root);
  return results;
}

/** Read a single skill directory's supporting files (everything except SKILL.md). */
async function readSkillSidecars(
  skillDir: string,
  nestedSkillRoots: ReadonlySet<string> = new Set(),
): Promise<ExtraFile[]> {
  const sidecars: ExtraFile[] = [];
  async function walk(dir: string): Promise<void> {
    const info = await lstat(dir);
    assertRealDirectory(dir, "Skill sidecar directory", info);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (nestedSkillRoots.has(resolve(full))) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = toPosixRelative(relative(skillDir, full));
      if (rel === "SKILL.md") continue;
      const buf = await readRegularFileIfExists(full, "Skill sidecar source");
      if (!buf) throw new Error(`Skill sidecar source '${full}' disappeared during migration`);
      if (looksLikeText(entry.name)) {
        sidecars.push({ relPath: rel, content: buf.toString("utf8") });
      } else {
        sidecars.push({ relPath: rel, content: buf.toString("base64"), encoding: "base64" });
      }
    }
  }
  await walk(skillDir);
  return sidecars;
}
const ALL_AGENTS: readonly MigrationAgentName[] = MIGRATION_AGENTS;

/**
 * Read configuration files from a source agent for a given config type.
 * @param agent - Source agent to read from.
 * @param type - Configuration type to read.
 * @param filterName - If provided, only return artefacts matching this filename.
 * @returns Array of { content, name } pairs. Missing files return []; agent read failures throw.
 */
export async function readSourceArtefacts(
  agent: MigrationAgentName,
  type: ConfigType,
  filterName?: string,
): Promise<Array<{ content: string; name: string; sourcePath: string; sidecars?: ExtraFile[] }>> {
  const results: Array<{
    content: string;
    name: string;
    sourcePath: string;
    sidecars?: ExtraFile[];
  }> = [];

  if (agent === "opencode") assertOpenCodeEnvironment();

  if (type === "agents") return readAgentFiles(agent, filterName);

  if (type === "global-rules") {
    if (agent === "opencode") {
      const filePath = join(resolveOpenCodeWriteDir(), "AGENTS.md");
      const content = await readRegularTextIfExists(filePath, "OpenCode global rules source");
      if (content) results.push({ content, name: "AGENTS.md", sourcePath: filePath });
    } else if (agent === "cursor") {
      const settingsPath = AgentPaths.cursor.settingsJson;
      const raw = await readIfExists(settingsPath);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.rules === "string" && parsed.rules.trim()) {
            results.push({
              content: parsed.rules,
              name: "__cursor_rules__",
              sourcePath: settingsPath,
            });
          }
        } catch {
          /* skip malformed settings.json */
        }
      }
    } else {
      const pathMap: Partial<Record<MigrationAgentName, string>> = {
        claude: AgentPaths.claude.claudeMd,
        codex: AgentPaths.codex.agentsMd,
        copilot: AgentPaths.copilot.instructionsFile,
      };
      const filePath = pathMap[agent];
      if (filePath) {
        const content = await readIfExists(filePath);
        if (content) {
          results.push({ content, name: basename(filePath), sourcePath: filePath });
        }
      }
    }
  }

  if (type === "mcp") {
    if (agent === "opencode") {
      const effective = await readOpenCodeEffectiveConfig();
      if (effective.config.mcp !== undefined) {
        if (!isPlainObject(effective.config.mcp)) {
          throw new Error("Effective OpenCode 'mcp' configuration must be an object");
        }
        results.push({
          content: `${JSON.stringify({ mcp: effective.config.mcp }, null, 2)}\n`,
          name: "opencode.json",
          sourcePath:
            effective.sourcePaths.at(-1) ?? join(resolveOpenCodeWriteDir(), "opencode.json"),
        });
      }
      return results;
    }
    const pathMap: Partial<Record<MigrationAgentName, string>> = {
      claude: AgentPaths.claude.mcpJson,
      cursor: AgentPaths.cursor.mcpGlobal,
      codex: AgentPaths.codex.configToml,
      vscode: AgentPaths.vscode.mcpJson,
      copilot: AgentPaths.copilot.mcpConfigJson,
    };
    const filePath = pathMap[agent];
    if (filePath) {
      const content = await readIfExists(filePath);
      if (content) {
        const name = basename(filePath) || "mcp";
        results.push({ content, name, sourcePath: filePath });
      }
    }
  }

  if (type === "commands") {
    if (agent === "opencode") return collectOpenCodeMarkdown("command", filterName);
    const dirMap: Partial<Record<MigrationAgentName, { dir: string; ext: string }>> = {
      claude: { dir: AgentPaths.claude.commandsDir, ext: ".md" },
      cursor: { dir: AgentPaths.cursor.commandsDir, ext: ".md" },
      copilot: { dir: AgentPaths.copilot.promptsDir, ext: ".prompt.md" },
      // Codex has no slash-command surface — `commands` is target-only.
    };
    const entry = dirMap[agent];
    if (entry) {
      try {
        const files = await readdir(entry.dir);
        for (const f of files) {
          if (!f.endsWith(entry.ext)) continue;
          if (filterName && f !== filterName) continue;
          const filePath = join(entry.dir, f);
          const content = await readFile(filePath, "utf8").catch(() => null);
          if (content) results.push({ content, name: f, sourcePath: filePath });
        }
      } catch {
        /* directory missing — return empty */
      }
    }
  }

  if (type === "skills") {
    if (agent === "opencode") return collectOpenCodeSkills(filterName);
    const skillsDir = await resolveSkillsSourceDir(agent);
    if (skillsDir) {
      const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        try {
          validateSkillName(entry.name);
        } catch (err) {
          if (err instanceof InvalidSkillNameError) continue;
          throw err;
        }
        if (filterName && entry.name !== filterName) continue;
        const skillDir = join(skillsDir, entry.name);
        const skillMdPath = join(skillDir, "SKILL.md");
        const skillMd = await readIfExists(skillMdPath);
        if (!skillMd) continue;
        const sidecars = await readSkillSidecars(skillDir);
        results.push({ content: skillMd, name: entry.name, sourcePath: skillMdPath, sidecars });
      }
    }
  }

  if (type === "rules") {
    const dir = resolveRulesDir(agent);
    if (dir) {
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        if (!(f.endsWith(".md") || f.endsWith(".mdc"))) continue;
        if (filterName && f !== filterName) continue;
        const filePath = join(dir, f);
        const content = await readFile(filePath, "utf8").catch(() => null);
        if (content) results.push({ content, name: f, sourcePath: filePath });
      }
    }
  }

  return results;
}

/**
 * Parse a JSONC document into a plain object for reading existing values.
 *
 * Returns {} for a non-object root or any genuine parse error (trailing commas
 * and comments are tolerated, not errors). This mirrors setJsoncTopLevelKey's
 * own object/error gate, so a corrupt target is treated the same on the read
 * side (merge from nothing) as on the write side (write a clean object).
 */
function parseJsoncObject(raw: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/**
 * Merge two MCP `inputs` arrays with the source list winning on collision.
 * Dedupe by `id` when present, otherwise by structural equality. Incoming is
 * iterated first so its entry is recorded under the dedupe key before existing.
 */
function mergeMcpInputs(incoming: unknown[], existing: unknown[]): unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const list of [incoming, existing]) {
    for (const entry of list) {
      const id =
        entry && typeof entry === "object"
          ? ((entry as { id?: unknown }).id as string | undefined)
          : undefined;
      const dedupeKey = typeof id === "string" ? id : JSON.stringify(entry);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      merged.push(entry);
    }
  }
  return merged;
}

function resolveAgentTargetPath(to: MigrationAgentName, targetName: string): string {
  const format = canonicalAgentFormat(to);
  const expectedExtension = agentExtension(format);
  const portableError = portableFilenameError(targetName, `Agent target path '${targetName}'`);
  if (portableError) throw new Error(portableError);
  if (
    !targetName ||
    targetName.startsWith(".") ||
    targetName.includes("/") ||
    targetName.includes("\\") ||
    !targetName.endsWith(expectedExtension)
  ) {
    throw new Error(`Agent target path '${targetName}' is unsafe or has the wrong extension`);
  }
  const root = resolve(resolveAgentsDir(to));
  const targetPath = resolve(root, targetName);
  if (!targetPath.startsWith(`${root}${sep}`)) {
    throw new Error(`Agent target path '${targetName}' escapes its user directory`);
  }
  return targetPath;
}

interface AgentWriteTarget {
  path: string;
  mode: number;
}

async function validateAgentWriteTarget(
  to: MigrationAgentName,
  targetName: string,
): Promise<AgentWriteTarget> {
  const targetPath = resolveAgentTargetPath(to, targetName);
  const root = resolveAgentsDir(to);
  return preflightContainedFileWrite(root, targetPath, `${to} agent target`);
}

async function stageFileWrite(
  targetPath: string,
  content: string | Buffer,
  mode: number,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    if (process.platform !== "win32") await handle.chmod(mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeRename?.();
    await rename(tempPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

interface OpenCodeWriteTarget {
  path: string;
  mode: number;
}

function resolveOpenCodeContainedTarget(targetPath: string): { root: string; target: string } {
  const root = resolve(resolveOpenCodeWriteDir());
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`OpenCode target '${targetPath}' escapes its configured root '${root}'`);
  }
  return { root, target };
}

function assertRealDirectory(
  path: string,
  label: string,
  info: Awaited<ReturnType<typeof lstat>>,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} '${path}' must be a real directory`);
  }
}

async function assertExistingDirectoryComponents(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const filesystemRoot = parsePath(absolute).root;
  let current = filesystemRoot;
  for (const segment of relative(filesystemRoot, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstatIfExists(current);
    if (!info) return;
    assertRealDirectory(current, label, info);
  }
}

async function readRegularFileIfExists(path: string, label: string): Promise<Buffer | null> {
  await assertExistingDirectoryComponents(dirname(path), `${label} directory component`);
  const before = await lstatIfExists(path);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} '${path}' must be a regular file`);
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} '${path}' must be a regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readRegularTextIfExists(path: string, label: string): Promise<string | null> {
  const content = await readRegularFileIfExists(path, label);
  return content?.toString("utf8") ?? null;
}

async function preflightContainedFileWrite(
  rootPath: string,
  targetPath: string,
  label: string,
): Promise<{ path: string; mode: number }> {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(`${label} '${targetPath}' escapes its target root '${root}'`);
  }
  await assertExistingDirectoryComponents(dirname(target), `${label} directory component`);
  const info = await lstatIfExists(target);
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new Error(`${label} '${target}' must be a regular file`);
  }
  return { path: target, mode: info ? info.mode & 0o777 : 0o600 };
}

async function stageContainedFileWrite(
  rootPath: string,
  targetPath: string,
  content: string | Buffer,
  label: string,
): Promise<void> {
  await preflightContainedFileWrite(rootPath, targetPath, label);
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const target = await preflightContainedFileWrite(rootPath, targetPath, label);
  await stageFileWrite(target.path, content, target.mode, async () => {
    await preflightContainedFileWrite(rootPath, target.path, label);
  });
}

async function preflightOpenCodeWrite(targetPath: string): Promise<OpenCodeWriteTarget> {
  const { root, target } = resolveOpenCodeContainedTarget(targetPath);
  await assertExistingDirectoryComponents(dirname(target), "OpenCode target directory component");
  const rootInfo = await lstatIfExists(root);
  if (rootInfo) assertRealDirectory(root, "OpenCode config root", rootInfo);

  if (rootInfo) {
    const parentRel = relative(root, dirname(target));
    let current = root;
    for (const segment of parentRel ? parentRel.split(sep) : []) {
      current = join(current, segment);
      const info = await lstatIfExists(current);
      if (!info) break;
      assertRealDirectory(current, "OpenCode target directory", info);
    }
  }

  const targetInfo = await lstatIfExists(target);
  if (targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink())) {
    throw new Error(`OpenCode target '${target}' must be a regular file`);
  }
  return { path: target, mode: targetInfo ? targetInfo.mode & 0o777 : 0o600 };
}

async function ensureOpenCodeParentDirectories(targetPath: string): Promise<void> {
  const { root, target } = resolveOpenCodeContainedTarget(targetPath);
  await assertExistingDirectoryComponents(dirname(target), "OpenCode target directory component");
  if (!(await lstatIfExists(root))) {
    const missing: string[] = [];
    let current = root;
    while (!(await lstatIfExists(current))) {
      missing.unshift(current);
      const parent = dirname(current);
      if (parent === current) throw new Error(`Cannot create OpenCode config root '${root}'`);
      current = parent;
    }
    for (const path of missing) {
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const info = await lstat(path);
      assertRealDirectory(path, "OpenCode config root component", info);
    }
  }

  const rootInfo = await lstat(root);
  assertRealDirectory(root, "OpenCode config root", rootInfo);
  const parentRel = relative(root, dirname(target));
  let current = root;
  for (const segment of parentRel ? parentRel.split(sep) : []) {
    current = join(current, segment);
    const before = await lstatIfExists(current);
    if (!before) {
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    const info = await lstat(current);
    assertRealDirectory(current, "OpenCode target directory", info);
  }
}

async function stageOpenCodeWrite(targetPath: string, content: string | Buffer): Promise<void> {
  await preflightOpenCodeWrite(targetPath);
  await ensureOpenCodeParentDirectories(targetPath);
  const target = await preflightOpenCodeWrite(targetPath);
  const tempPath = join(dirname(target.path), `.${basename(target.path)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      target.mode,
    );
    if (process.platform !== "win32") await handle.chmod(target.mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await preflightOpenCodeWrite(target.path);
    await rename(tempPath, target.path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function readOpenCodeTargetIfExists(targetPath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isEnoent(error)) return "";
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`OpenCode target '${targetPath}' must be a regular file`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

interface SkillWrite {
  path: string;
  content: string | Buffer;
  name: string;
}

function resolveSkillSidecar(skillRoot: string, relPath: string, label: string): string {
  if (!relPath || isAbsolute(relPath) || relPath.includes("\\")) {
    throw new Error(`${label} sidecar path '${relPath}' must be a safe relative path`);
  }
  const segments = relPath.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."),
    )
  ) {
    throw new Error(`${label} sidecar path '${relPath}' contains an unsafe segment`);
  }
  for (const segment of segments) {
    const portableError = portableFilenameError(segment, `${label} sidecar path '${relPath}'`);
    if (portableError) throw new Error(portableError);
  }
  const root = resolve(skillRoot);
  const target = resolve(root, ...segments);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} sidecar path '${relPath}' escapes its skill directory`);
  }
  return target;
}

function planSkillWrites(
  skillRoot: string,
  content: string,
  extraFiles: ExtraFile[],
  label: string,
): SkillWrite[] {
  const writes: SkillWrite[] = [{ path: join(skillRoot, "SKILL.md"), content, name: "SKILL.md" }];
  for (const extra of extraFiles) {
    writes.push({
      path: resolveSkillSidecar(skillRoot, extra.relPath, label),
      content: extra.encoding === "base64" ? Buffer.from(extra.content, "base64") : extra.content,
      name: extra.relPath,
    });
  }
  const seen = new Map<string, string>();
  for (const write of writes) {
    const key = normalizedIdentity(write.path);
    const existing = seen.get(key);
    if (existing) {
      throw new Error(`${label} target collision: '${existing}' and '${write.name}'`);
    }
    seen.set(key, write.name);
  }
  return writes;
}

/**
 * Write a migrated artefact to the target agent using existing apply functions.
 * @param to - Target agent.
 * @param type - Configuration type.
 * @param targetName - Filename or sentinel (e.g., __cursor_rules__).
 * @param content - Translated content to write.
 * @param dryRun - If true, skip the write and return the planned artefact.
 * @returns The MigratedArtifact describing what was (or would be) written, or null if unsupported.
 */
export async function applyMigrated(
  to: MigrationAgentName,
  type: ConfigType,
  targetName: string,
  content: string,
  dryRun: boolean,
  extraFiles: ExtraFile[] = [],
  from?: MigrationAgentName,
  sourcePath?: string,
): Promise<MigratedArtifact | null> {
  if (to === "opencode") assertOpenCodeEnvironment();
  // Compose `${from} → ${to}: <kind>` when caller threads source info;
  // fall back to bare `<kind>` when invoked directly (e.g. unit tests).
  const arrow = from ? `${from} → ${to}: ` : "";
  const src = sourcePath ?? "";
  if (type === "agents") {
    if (to === "opencode") {
      const targetPath = resolveAgentTargetPath(to, targetName);
      await preflightOpenCodeWrite(targetPath);
      if (!dryRun) await stageOpenCodeWrite(targetPath, content);
      return {
        targetPath,
        sourcePath: src,
        content,
        description: `${arrow}agent "${targetName}"`,
      };
    }
    const target = await validateAgentWriteTarget(to, targetName);
    if (!dryRun) {
      await stageContainedFileWrite(
        resolveAgentsDir(to),
        target.path,
        content,
        `${to} agent target`,
      );
    }
    return {
      targetPath: target.path,
      sourcePath: src,
      content,
      description: `${arrow}agent "${targetName}"`,
    };
  }

  if (type === "global-rules") {
    // The cursor-rules sentinel only routes to cursor's settings.json when the
    // declared target is cursor. Without this gate, a translator that
    // mistakenly returns the sentinel for a non-cursor target would overwrite
    // cursor's settings.json instead of writing the intended agent file.
    // Fall-through (below) preserves data integrity for the source even if
    // the resulting target file is missing the translator's usual wrapper.
    if (targetName === "__cursor_rules__" && to === "cursor") {
      const targetPath = AgentPaths.cursor.settingsJson;
      const root = dirname(targetPath);
      await preflightContainedFileWrite(root, targetPath, "cursor global-rules target");
      const existing = (await readRegularTextIfExists(targetPath, "cursor settings target")) ?? "";
      content = setJsoncTopLevelKey(existing, "rules", content);
      if (!dryRun) {
        await stageContainedFileWrite(root, targetPath, content, "cursor global-rules target");
      }
      return {
        targetPath,
        sourcePath: src,
        content,
        description: `${arrow}cursor rules field`,
      };
    }
    const pathMap: Partial<Record<MigrationAgentName, string>> = {
      claude: AgentPaths.claude.claudeMd,
      codex: AgentPaths.codex.agentsMd,
      copilot: AgentPaths.copilot.instructionsFile,
      opencode: join(resolveOpenCodeWriteDir(), "AGENTS.md"),
    };
    const targetPath = pathMap[to];
    if (!targetPath) return null;

    if (to === "opencode") {
      await preflightOpenCodeWrite(targetPath);
      if (!dryRun) await stageOpenCodeWrite(targetPath, content);
      return {
        targetPath,
        sourcePath: src,
        content,
        description: `${arrow}global rules`,
      };
    }

    const root = dirname(targetPath);
    await preflightContainedFileWrite(root, targetPath, `${to} global-rules target`);
    if (!dryRun) {
      await stageContainedFileWrite(root, targetPath, content, `${to} global-rules target`);
    }
    return {
      targetPath,
      sourcePath: src,
      content,
      description: `${arrow}global rules`,
    };
  }

  if (type === "mcp") {
    if (to === "opencode") {
      const targetPath = await resolveOpenCodeConfigTarget();
      const incoming = JSON.parse(content) as Record<string, unknown>;
      if (!isPlainObject(incoming.mcp)) {
        throw new Error("Translated OpenCode MCP content must contain an 'mcp' object");
      }
      await preflightOpenCodeWrite(targetPath);
      await assertNoOpenCodeLowerMcpCollisions(targetPath, Object.keys(incoming.mcp));
      const existing = await readOpenCodeTargetIfExists(targetPath);
      content = patchOpenCodeMcp(existing, incoming.mcp, targetPath);
      if (!dryRun) await stageOpenCodeWrite(targetPath, content);
      return {
        targetPath,
        sourcePath: src,
        content,
        description: `${arrow}MCP servers`,
      };
    }
    const pathMap: Partial<Record<MigrationAgentName, string>> = {
      claude: AgentPaths.claude.mcpJson,
      cursor: AgentPaths.cursor.mcpGlobal,
      codex: AgentPaths.codex.configToml,
      vscode: AgentPaths.vscode.mcpJson,
      copilot: AgentPaths.copilot.mcpConfigJson,
    };
    const targetPath = pathMap[to];
    if (!targetPath) return null;

    const root = dirname(targetPath);
    await preflightContainedFileWrite(root, targetPath, `${to} MCP target`);
    // Merge during preflight as well as apply so dry-run validates the exact
    // target document that a real migration would update.
    const existing = await readRegularTextIfExists(targetPath, `${to} MCP target`);
    if (existing) {
      if (to === "codex") {
        const existingParsed = TOML.parse(existing);
        const incomingParsed = TOML.parse(content);
        const existingServers = (existingParsed.mcp_servers ?? {}) as TOML.JsonMap;
        const incomingServers = (incomingParsed.mcp_servers ?? {}) as TOML.JsonMap;
        existingParsed.mcp_servers = { ...existingServers, ...incomingServers };
        content = TOML.stringify(existingParsed);
      } else if (to === "vscode") {
        const incomingParsed = JSON.parse(content) as Record<string, unknown>;
        const incomingServers = (incomingParsed.servers ?? {}) as Record<string, unknown>;
        const existingObj = parseJsoncObject(existing);
        const existingServers = (existingObj.servers ?? {}) as Record<string, unknown>;
        let merged = setJsoncTopLevelKey(existing, "servers", {
          ...existingServers,
          ...incomingServers,
        });
        const incomingInputs = Array.isArray(incomingParsed.inputs) ? incomingParsed.inputs : [];
        if (incomingInputs.length > 0) {
          const existingInputs = Array.isArray(existingObj.inputs) ? existingObj.inputs : [];
          merged = setJsoncTopLevelKey(
            merged,
            "inputs",
            mergeMcpInputs(incomingInputs, existingInputs),
          );
        }
        content = merged;
      } else {
        const incomingParsed = JSON.parse(content) as Record<string, unknown>;
        const incomingServers = (incomingParsed.mcpServers ?? {}) as Record<string, unknown>;
        const existingObj = parseJsoncObject(existing);
        const existingServers = (existingObj.mcpServers ?? {}) as Record<string, unknown>;
        content = setJsoncTopLevelKey(existing, "mcpServers", {
          ...existingServers,
          ...incomingServers,
        });
      }
    }
    if (!dryRun) {
      await stageContainedFileWrite(root, targetPath, content, `${to} MCP target`);
    }
    return {
      targetPath,
      sourcePath: src,
      content,
      description: `${arrow}MCP servers`,
    };
  }

  if (type === "commands") {
    // Codex commands wrap as SKILL.md (Codex has no native slash-command
    // surface; skills are user-invokable as `/<name>`). Translator emits
    // `<basename>/SKILL.md` as targetName; orchestrator writes under
    // ~/.agents/skills/. Other agents write the plain command file.
    if (to === "codex" && targetName.endsWith("/SKILL.md")) {
      const skillName = targetName.slice(0, -"/SKILL.md".length);
      validateSkillName(skillName);
      const targetPath = resolveCommandTargetPath(
        AgentPaths.codex.userSkillsDir,
        targetName,
        "/SKILL.md",
        "Codex command",
      );
      await preflightContainedFileWrite(
        AgentPaths.codex.userSkillsDir,
        targetPath,
        "Codex command target",
      );
      if (!dryRun) {
        await stageContainedFileWrite(
          AgentPaths.codex.userSkillsDir,
          targetPath,
          content,
          "Codex command target",
        );
      }
      return {
        targetPath,
        sourcePath: src,
        content,
        description: `${arrow}command "${skillName}" wrapped as skill`,
      };
    }

    const dirMap: Partial<Record<MigrationAgentName, string>> = {
      claude: AgentPaths.claude.commandsDir,
      cursor: AgentPaths.cursor.commandsDir,
      copilot: AgentPaths.copilot.promptsDir,
      opencode: join(resolveOpenCodeWriteDir(), "commands"),
    };
    const dir = dirMap[to];
    if (!dir) return null;

    const targetPath =
      to === "opencode"
        ? resolveOpenCodeMarkdownTarget(dir, targetName)
        : resolveCommandTargetPath(
            dir,
            targetName,
            to === "copilot" ? ".prompt.md" : ".md",
            `${to} command`,
          );
    if (to === "opencode") {
      await preflightOpenCodeWrite(targetPath);
      if (!dryRun) await stageOpenCodeWrite(targetPath, content);
    } else {
      await preflightContainedFileWrite(dir, targetPath, `${to} command target`);
      if (!dryRun) {
        await stageContainedFileWrite(dir, targetPath, content, `${to} command target`);
      }
    }
    return {
      targetPath,
      sourcePath: src,
      content,
      description: `${arrow}command "${targetName}"`,
    };
  }

  if (type === "skills") {
    // targetName is the skill directory name (validated). Write SKILL.md
    // plus all extraFiles (sidecars carried from source) under it.
    const targetDir = resolveSkillsTargetDir(to);
    if (!targetDir) return null;
    validateSkillName(targetName);
    const skillRoot = join(targetDir, targetName);
    const skillMdPath = join(skillRoot, "SKILL.md");
    const label = to === "opencode" ? "OpenCode skill" : `${to} skill`;
    const writes = planSkillWrites(skillRoot, content, extraFiles, label);
    if (to === "opencode") {
      for (const write of writes) await preflightOpenCodeWrite(write.path);
      if (!dryRun) {
        for (const write of writes) await stageOpenCodeWrite(write.path, write.content);
      }
    } else {
      for (const write of writes) {
        await preflightContainedFileWrite(targetDir, write.path, `${label} target`);
      }
      if (!dryRun) {
        for (const write of writes) {
          await stageContainedFileWrite(targetDir, write.path, write.content, `${label} target`);
        }
      }
    }
    return {
      targetPath: skillMdPath,
      sourcePath: src,
      content,
      description:
        extraFiles.length > 0
          ? `${arrow}skill "${targetName}" (+${extraFiles.length} supporting files)`
          : `${arrow}skill "${targetName}"`,
    };
  }

  if (type === "rules") {
    const dir = resolveRulesDir(to);
    if (!dir) return null;
    const targetPath = join(dir, targetName);
    if (!dryRun) await atomicWrite(targetPath, content);
    return {
      targetPath,
      sourcePath: src,
      content,
      description: `${arrow}rule "${targetName}"`,
    };
  }

  return null;
}

interface AgentTargetPlan {
  physical: PhysicalAgentFormat;
  logical: MigrationAgentName;
  sharedTarget?: SharedAgentTarget;
}

interface PendingAgentWrite {
  target: AgentTargetPlan;
  targetName: string;
  content: string;
  sourcePath: string;
  artifact: MigratedArtifact;
}

function isSharedAlias(agent: MigrationAgentName): boolean {
  return agent === "copilot" || agent === "vscode";
}

function sharedTargetFor(agent: MigrationAgentName): SharedAgentTarget | undefined {
  if (agent === "copilot") return "github-copilot";
  if (agent === "vscode") return "vscode";
  return undefined;
}

function agentTargetPlans(options: MigrateOptions): AgentTargetPlan[] {
  const source = canonicalAgentFormat(options.from);
  if (options.to !== "all") {
    const physical = canonicalAgentFormat(options.to);
    return [
      {
        physical,
        logical: options.to,
        sharedTarget: sharedTargetFor(options.to),
      },
    ];
  }

  return (["claude", "cursor", "codex", "copilot", "opencode"] as const)
    .filter((physical) => physical !== source)
    .map((physical) => ({ physical, logical: physical }));
}

function selectedAgentTargetPlans(targets: readonly MigrationAgentName[]): AgentTargetPlan[] {
  const selected = new Set(targets);
  const sharedBoth = selected.has("copilot") && selected.has("vscode");
  const plans: AgentTargetPlan[] = [];
  for (const target of ALL_AGENTS) {
    if (!selected.has(target)) continue;
    if (target === "vscode" && sharedBoth) continue;
    if (target === "copilot" && sharedBoth) {
      plans.push({ physical: "copilot", logical: "copilot" });
      continue;
    }
    plans.push({
      physical: canonicalAgentFormat(target),
      logical: target,
      sharedTarget: sharedTargetFor(target),
    });
  }
  return plans;
}

function collisionKey(targetPath: string): string {
  return targetPath.normalize("NFC").toLowerCase();
}

function resolveOpenCodeMarkdownTarget(root: string, targetName: string): string {
  if (!targetName.endsWith(".md") || targetName.startsWith("/") || targetName.includes("\\")) {
    throw new Error(`OpenCode target path '${targetName}' is unsafe or has the wrong extension`);
  }
  const segments = targetName.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`OpenCode target path '${targetName}' contains traversal`);
  }
  for (const segment of segments) {
    if (segment.startsWith(".")) {
      throw new Error(`OpenCode target path '${targetName}' contains a hidden segment`);
    }
    const portableError = portableFilenameError(segment, `OpenCode target path '${targetName}'`);
    if (portableError) throw new Error(portableError);
  }
  const resolvedRoot = resolve(root);
  const targetPath = resolve(resolvedRoot, ...segments);
  if (!targetPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`OpenCode target path '${targetName}' escapes its user directory`);
  }
  return targetPath;
}

function resolveCommandTargetPath(
  root: string,
  targetName: string,
  expectedSuffix: string,
  label: string,
): string {
  if (
    !targetName ||
    isAbsolute(targetName) ||
    targetName.includes("\\") ||
    !targetName.endsWith(expectedSuffix)
  ) {
    throw new Error(`${label} target path '${targetName}' is unsafe or has the wrong extension`);
  }
  const segments = targetName.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."),
    )
  ) {
    throw new Error(`${label} target path '${targetName}' contains an unsafe segment`);
  }
  for (const segment of segments) {
    const portableError = portableFilenameError(segment, `${label} target path '${targetName}'`);
    if (portableError) throw new Error(portableError);
  }
  const resolvedRoot = resolve(root);
  const targetPath = resolve(resolvedRoot, ...segments);
  if (!targetPath.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${label} target path '${targetName}' escapes its user directory`);
  }
  return targetPath;
}

function sharedCoverage(content: string): SharedAgentTarget | "both" {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("existing shared agent has invalid frontmatter");
  let fields: unknown;
  try {
    fields = Bun.YAML.parse(match[1] ?? "");
  } catch {
    throw new Error("existing shared agent has invalid frontmatter");
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("existing shared agent has invalid frontmatter");
  }
  const target = (fields as Record<string, unknown>).target;
  if (target === undefined) return "both";
  if (target === "github-copilot" || target === "vscode") return target;
  throw new Error("existing shared agent has an invalid target");
}

async function preflightSharedOwnership(
  target: AgentTargetPlan,
  targetName: string,
  content: string,
): Promise<void> {
  if (target.physical !== "copilot") return;
  const targetPath = resolveAgentTargetPath(target.logical, targetName);
  const existing = await readAgentFile(targetPath).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (existing === null) return;
  const incomingCoverage = sharedCoverage(content);
  const existingCoverage = sharedCoverage(existing);
  if (incomingCoverage !== existingCoverage) {
    throw new Error(
      `existing shared agent target coverage '${existingCoverage}' does not match incoming '${incomingCoverage}'`,
    );
  }
}

interface ExistingAgentPath {
  path: string;
}

async function existingAgentPaths(
  target: AgentTargetPlan,
): Promise<Map<string, ExistingAgentPath>> {
  const root = resolveAgentsDir(target.logical);
  if (target.physical === "opencode") {
    const paths = new Map<string, ExistingAgentPath>();
    for (const source of await collectOpenCodeMarkdown("agent")) {
      const key = collisionKey(resolveOpenCodeMarkdownTarget(root, source.name));
      const existing = paths.get(key);
      if (existing && resolve(existing.path) !== resolve(source.sourcePath)) {
        throw new Error(
          `Agent target identity collision: '${existing.path}' and '${source.sourcePath}'`,
        );
      }
      paths.set(key, { path: source.sourcePath });
    }
    return paths;
  }
  const rootInfo = await lstat(root).catch((error) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (!rootInfo) return new Map();
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Agent target directory '${root}' must be a real directory`);
  }
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (isEnoent(error)) return [];
    throw error;
  });
  const paths = new Map<string, ExistingAgentPath>();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.toLowerCase().endsWith(agentExtension(target.physical))) continue;
    const key = collisionKey(join(root, entry.name));
    const existing = paths.get(key);
    const entryPath = join(root, entry.name);
    if (existing && resolve(existing.path) !== resolve(entryPath)) {
      throw new Error(`Agent target path collision: '${existing.path}' and '${entryPath}'`);
    }
    paths.set(key, { path: entryPath });
  }
  return paths;
}

async function performAgentMigrate(
  options: MigrateOptions,
  result: MigrateResult,
  targets: AgentTargetPlan[] = agentTargetPlans(options),
): Promise<void> {
  let sources: Awaited<ReturnType<typeof readSourceArtefacts>>;
  try {
    sources = await readSourceArtefacts(options.from, "agents", options.name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`Failed to read ${options.from} agents: ${message}`);
    return;
  }
  if (sources.length === 0) {
    if (options.name) {
      result.errors.push(`Source artefact '${options.name}' not found in ${options.from} agents`);
      return;
    }
    for (const target of targets) {
      result.skipped.push({
        reason: "No source artefacts found",
        pair: { from: options.from, to: target.logical, type: "agents" },
      });
    }
    return;
  }

  const sourceFormat = canonicalAgentFormat(options.from);
  const errorCountBeforeSourcePreflight = result.errors.length;
  const validSources: typeof sources = [];
  const identities = new Map<string, { identity: string; sourcePath: string }>();
  for (const source of sources) {
    const inspected = inspectAgentSource(sourceFormat, source.content, source.name);
    if (inspected.errors.length > 0 || !inspected.identity) {
      for (const error of inspected.errors) {
        result.errors.push(`${options.from} agents '${source.name}': ${error}`);
      }
      continue;
    }
    const key = inspected.identity.normalize("NFC").toLowerCase();
    const existing = identities.get(key);
    if (existing) {
      result.errors.push(
        `Duplicate logical agent identity '${inspected.identity}' in ${existing.sourcePath} and ${source.sourcePath}`,
      );
      continue;
    }
    identities.set(key, { identity: inspected.identity, sourcePath: source.sourcePath });
    validSources.push(source);
  }
  if (
    identities.size !== validSources.length ||
    result.errors.length > errorCountBeforeSourcePreflight
  ) {
    return;
  }

  const pending: PendingAgentWrite[] = [];
  for (const target of targets) {
    const translator = getTranslator(sourceFormat, target.physical, "agents");
    if (!translator) {
      result.skipped.push({
        reason: "No translator registered",
        pair: { from: options.from, to: target.logical, type: "agents" },
      });
      continue;
    }

    const targetPending: PendingAgentWrite[] = [];
    let targetPreflightFailed = false;
    for (const source of validSources) {
      const translated = translator(source.content, source.name);
      if (!translated) {
        result.skipped.push({
          reason: "Translator returned null (empty or unsupported)",
          pair: { from: options.from, to: target.logical, type: "agents" },
        });
        continue;
      }
      for (const warning of translated.warnings ?? []) {
        result.warnings.push(`${options.from} → ${target.logical} (agents): ${warning}`);
      }
      if ((translated.errors?.length ?? 0) > 0) {
        for (const error of translated.errors ?? []) {
          result.errors.push(
            `${options.from} → ${target.logical} (agents, ${source.name}): ${error}`,
          );
        }
        targetPreflightFailed = true;
        continue;
      }
      if (translated.skipWrite) continue;

      try {
        const content =
          target.physical === "copilot"
            ? setSharedAgentTarget(translated.content, target.sharedTarget)
            : translated.content;
        const artifact = await applyMigrated(
          target.logical,
          "agents",
          translated.targetName,
          content,
          true,
          [],
          options.from,
          source.sourcePath,
        );
        if (artifact) {
          await preflightSharedOwnership(target, translated.targetName, content);
          targetPending.push({
            target,
            targetName: translated.targetName,
            content,
            sourcePath: source.sourcePath,
            artifact,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(
          `Agent preflight failed for ${target.logical}/${translated.targetName}: ${message}`,
        );
        targetPreflightFailed = true;
      }
    }

    const existingPaths = await existingAgentPaths(target).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Agent preflight failed for ${target.logical}: ${message}`);
      targetPreflightFailed = true;
      return new Map<string, ExistingAgentPath>();
    });
    const pendingPaths = new Map<string, string>();
    for (const item of targetPending) {
      const key = collisionKey(item.artifact.targetPath);
      const existing = existingPaths.get(key);
      const pendingExisting = pendingPaths.get(key);
      if (pendingExisting) {
        result.errors.push(
          `Agent target path collision: '${pendingExisting}' and '${item.targetName}'`,
        );
        targetPreflightFailed = true;
      } else if (existing && resolve(existing.path) !== resolve(item.artifact.targetPath)) {
        result.errors.push(
          `Agent target path collision: '${existing.path}' and '${item.artifact.targetPath}'`,
        );
        targetPreflightFailed = true;
      }
      pendingPaths.set(key, item.targetName);
    }
    if (targetPreflightFailed) continue;
    pending.push(...targetPending);
  }

  for (const item of pending) {
    if (options.dryRun) {
      result.migrated.push(item.artifact);
      continue;
    }
    try {
      await preflightSharedOwnership(item.target, item.targetName, item.content);
      const artifact = await applyMigrated(
        item.target.logical,
        "agents",
        item.targetName,
        item.content,
        false,
        [],
        options.from,
        item.sourcePath,
      );
      if (artifact) result.migrated.push(artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(
        `Write failed for ${item.target.logical}/agents/${item.targetName}: ${message}`,
      );
    }
  }
}

export interface MigrateTargetsOptions {
  from: MigrationAgentName;
  targets: readonly MigrationAgentName[];
  types: readonly ConfigType[];
  dryRun?: boolean;
}

function appendMigrateResult(target: MigrateResult, source: MigrateResult): void {
  target.migrated.push(...source.migrated);
  target.skipped.push(...source.skipped);
  target.warnings.push(...source.warnings);
  target.errors.push(...source.errors);
}

const SAFE_MCP_CONFIG_REFERENCE = /(?:\{(?:env:[^}]+|file:[^}]+)\}|\$\{env:[^}]+\})/g;
const SAFE_COPILOT_MCP_ENV_REFERENCE = /\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})/g;

function authorizationIsReferenceBacked(value: unknown, source: MigrationAgentName): boolean {
  if (typeof value !== "string") return false;
  let referenceCount = 0;
  let masked = value.replace(SAFE_MCP_CONFIG_REFERENCE, () => {
    referenceCount += 1;
    return "{reference}";
  });
  if (source === "copilot") {
    masked = masked.replace(SAFE_COPILOT_MCP_ENV_REFERENCE, () => {
      referenceCount += 1;
      return "{reference}";
    });
  }
  if (referenceCount === 0) return false;
  masked = masked.trim();
  return /^(?:[A-Za-z][A-Za-z0-9+.-]*[ \t]+)?\{reference\}(?:[ \t]*\{reference\})*$/.test(masked);
}

function clientSecretIsReferenceBacked(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const references = value.match(SAFE_MCP_CONFIG_REFERENCE);
  return Boolean(
    references &&
      references.length > 0 &&
      value.replace(SAFE_MCP_CONFIG_REFERENCE, "").trim() === "",
  );
}

function literalMcpCredentialErrors(
  value: unknown,
  source: MigrationAgentName,
  inHeaders = false,
  inOauth = false,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => literalMcpCredentialErrors(entry, source, inHeaders, inOauth));
  }
  if (!isPlainObject(value)) return [];
  const errors: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      inHeaders &&
      normalizedKey === "authorization" &&
      !authorizationIsReferenceBacked(child, source)
    ) {
      errors.push("MCP Authorization header contains a literal credential");
    }
    if (inOauth && normalizedKey === "clientsecret" && !clientSecretIsReferenceBacked(child)) {
      errors.push("MCP OAuth clientSecret contains a literal credential");
    }
    errors.push(
      ...literalMcpCredentialErrors(
        child,
        source,
        normalizedKey === "headers" || normalizedKey === "http_headers",
        normalizedKey === "oauth",
      ),
    );
  }
  return errors;
}

function parseMcpSecurityDocument(content: string, agent: MigrationAgentName): unknown {
  if (agent === "vscode") {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
    if (errors.length > 0 || !isPlainObject(parsed)) {
      throw new Error("VS Code MCP document must contain a valid JSONC object");
    }
    return parsed;
  }
  try {
    return JSON.parse(content);
  } catch {
    return TOML.parse(content);
  }
}

function mcpSecretSafetyErrors(
  sourceContent: string,
  finalContent: string,
  from: MigrationAgentName,
  target: MigrationAgentName,
): string[] {
  let source: unknown;
  let output: unknown;
  try {
    source = parseMcpSecurityDocument(sourceContent, from);
    output = parseMcpSecurityDocument(finalContent, target);
  } catch {
    return [
      `MCP content for ${from} → ${target} is neither valid JSON nor TOML; secret scan cannot run`,
    ];
  }
  const errors = [
    ...literalMcpCredentialErrors(source, from),
    ...literalMcpCredentialErrors(output, target),
  ];
  const redacted = redactSecretLiterals(output, "mcpContent");
  errors.push(...redacted.warnings);
  errors.push(...scanForSecrets(finalContent, `${from} → ${target} MCP output`));
  return [...new Set(errors)].map((error) => `${error} — migration aborted for security`);
}

async function codexCommandSkillPreflight(
  from: MigrationAgentName,
  types: readonly ConfigType[],
  filterName?: string,
): Promise<string[]> {
  if (from !== "opencode" || !types.includes("commands") || !types.includes("skills")) return [];

  const commandTranslator = getTranslator(from, "codex", "commands");
  const skillTranslator = getTranslator(from, "codex", "skills");
  if (!commandTranslator || !skillTranslator) {
    return ["OpenCode → Codex command/skill preflight requires both translators"];
  }

  let commands: Awaited<ReturnType<typeof readSourceArtefacts>>;
  let skills: Awaited<ReturnType<typeof readSourceArtefacts>>;
  try {
    [commands, skills] = await Promise.all([
      readSourceArtefacts(from, "commands", filterName),
      readSourceArtefacts(from, "skills", filterName),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`OpenCode → Codex command/skill preflight failed: ${message}`];
  }

  const destinations = new Map<string, { type: "command" | "skill"; path: string }>();
  const errors: string[] = [];
  for (const source of commands) {
    const translated = commandTranslator(source.content, source.name);
    if (!translated || translated.skipWrite || (translated.errors?.length ?? 0) > 0) continue;
    try {
      const skillName = translated.targetName.slice(0, -"/SKILL.md".length);
      validateSkillName(skillName);
      const path = resolveCommandTargetPath(
        AgentPaths.codex.userSkillsDir,
        translated.targetName,
        "/SKILL.md",
        "Codex command",
      );
      destinations.set(collisionKey(path), { type: "command", path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`OpenCode → Codex command preflight failed for '${source.name}': ${message}`);
    }
  }
  for (const source of skills) {
    const translated = skillTranslator(source.content, source.name);
    if (!translated || translated.skipWrite || (translated.errors?.length ?? 0) > 0) continue;
    try {
      validateSkillName(translated.targetName);
      const path = join(AgentPaths.codex.userSkillsDir, translated.targetName, "SKILL.md");
      const existing = destinations.get(collisionKey(path));
      if (existing?.type === "command") {
        errors.push(
          `OpenCode → Codex command/skill target collision: '${existing.path}' and '${path}'`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`OpenCode → Codex skill preflight failed for '${source.name}': ${message}`);
    }
  }
  return errors;
}

interface PendingCommandWrite {
  targetName: string;
  content: string;
  extraFiles: ExtraFile[];
  sourcePath: string;
  sourceName: string;
  artifact: MigratedArtifact;
}

interface ExistingTargetPath {
  path: string;
}

function recordExistingTargetPath(
  paths: Map<string, ExistingTargetPath>,
  targetPath: string,
  actualPath: string,
  label: string,
): void {
  const key = collisionKey(targetPath);
  const existing = paths.get(key);
  if (existing && resolve(existing.path) !== resolve(actualPath)) {
    throw new Error(`${label} collision: '${existing.path}' and '${actualPath}'`);
  }
  paths.set(key, { path: actualPath });
}

async function existingCommandTargetPaths(
  target: MigrationAgentName,
): Promise<Map<string, ExistingTargetPath>> {
  const paths = new Map<string, ExistingTargetPath>();
  if (target === "opencode") {
    const root = join(resolveOpenCodeWriteDir(), "commands");
    for (const source of await collectOpenCodeMarkdown("command")) {
      recordExistingTargetPath(
        paths,
        resolveOpenCodeMarkdownTarget(root, source.name),
        source.sourcePath,
        "Command target path",
      );
    }
    return paths;
  }

  if (target === "codex") {
    const root = AgentPaths.codex.userSkillsDir;
    const info = await lstatIfExists(root);
    if (!info) return paths;
    assertRealDirectory(root, "Codex command target directory", info);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const targetPath = join(root, entry.name, "SKILL.md");
      recordExistingTargetPath(paths, targetPath, targetPath, "Command target path");
    }
    return paths;
  }

  const targetConfig: Partial<Record<MigrationAgentName, { root: string; extension: string }>> = {
    claude: { root: AgentPaths.claude.commandsDir, extension: ".md" },
    cursor: { root: AgentPaths.cursor.commandsDir, extension: ".md" },
    copilot: { root: AgentPaths.copilot.promptsDir, extension: ".prompt.md" },
  };
  const targetDirectory = targetConfig[target];
  if (!targetDirectory) return paths;
  const { root, extension } = targetDirectory;
  const rootInfo = await lstatIfExists(root);
  if (!rootInfo) return paths;
  assertRealDirectory(root, `${target} command target directory`, rootInfo);

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.name.endsWith(extension)) {
        recordExistingTargetPath(paths, entryPath, entryPath, "Command target path");
      }
    }
  }
  await walk(root);
  return paths;
}

async function performCommandTarget(
  options: MigrateOptions,
  target: MigrationAgentName,
  sources: Awaited<ReturnType<typeof readSourceArtefacts>>,
  translator: Translator,
  result: MigrateResult,
): Promise<void> {
  const pending: PendingCommandWrite[] = [];
  let failed = false;
  for (const { content, name, sourcePath, sidecars = [] } of sources) {
    const translated = translator(content, name);
    if (!translated) {
      result.skipped.push({
        reason: "Translator returned null (empty or unsupported)",
        pair: { from: options.from, to: target, type: "commands" },
      });
      continue;
    }
    for (const warning of translated.warnings ?? []) {
      result.warnings.push(`${options.from} → ${target} (commands): ${warning}`);
    }
    if ((translated.errors?.length ?? 0) > 0) {
      for (const error of translated.errors ?? []) {
        result.errors.push(`${options.from} → ${target} (commands): ${error}`);
      }
      failed = true;
      continue;
    }
    if (translated.skipWrite) continue;

    const extraFiles = [...(translated.extraFiles ?? []), ...sidecars];
    try {
      const artifact = await applyMigrated(
        target,
        "commands",
        translated.targetName,
        translated.content,
        true,
        extraFiles,
        options.from,
        sourcePath,
      );
      if (artifact) {
        pending.push({
          targetName: translated.targetName,
          content: translated.content,
          extraFiles,
          sourcePath,
          sourceName: name,
          artifact,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Command preflight failed for ${target}/${name}: ${message}`);
      failed = true;
    }
  }

  const paths = new Map<string, string>();
  for (const item of pending) {
    const key = collisionKey(item.artifact.targetPath);
    const existing = paths.get(key);
    if (existing) {
      result.errors.push(
        `Command target path collision for ${target}: '${existing}' and '${item.sourceName}'`,
      );
      failed = true;
    } else {
      paths.set(key, item.sourceName);
    }
  }
  if (pending.length > 0) {
    try {
      const existingPaths = await existingCommandTargetPaths(target);
      for (const item of pending) {
        const existing = existingPaths.get(collisionKey(item.artifact.targetPath));
        if (existing && resolve(existing.path) !== resolve(item.artifact.targetPath)) {
          result.errors.push(
            `Command target path collision for ${target}: '${existing.path}' and '${item.artifact.targetPath}'`,
          );
          failed = true;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${target} command target preflight failed: ${message}`);
      failed = true;
    }
  }
  if (failed) return;

  for (const item of pending) {
    if (options.dryRun) {
      result.migrated.push(item.artifact);
      continue;
    }
    try {
      const artifact = await applyMigrated(
        target,
        "commands",
        item.targetName,
        item.content,
        false,
        item.extraFiles,
        options.from,
        item.sourcePath,
      );
      if (artifact) result.migrated.push(artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Write failed for ${target}/commands/${item.targetName}: ${message}`);
    }
  }
}

interface PendingSkillWrite {
  targetName: string;
  content: string;
  extraFiles: ExtraFile[];
  sourcePath: string;
  sourceName: string;
  artifact: MigratedArtifact;
}

async function existingSkillTargetPaths(
  target: MigrationAgentName,
): Promise<Map<string, ExistingTargetPath>> {
  const paths = new Map<string, ExistingTargetPath>();
  const root = resolveSkillsTargetDir(target);
  if (!root) return paths;
  if (target === "opencode") {
    for (const source of await collectOpenCodeSkills()) {
      recordExistingTargetPath(
        paths,
        join(root, source.name, "SKILL.md"),
        source.sourcePath,
        "Skill target path",
      );
    }
    return paths;
  }

  const info = await lstatIfExists(root);
  if (!info) return paths;
  assertRealDirectory(root, `${target} skill target directory`, info);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const targetPath = join(root, entry.name, "SKILL.md");
    recordExistingTargetPath(paths, targetPath, targetPath, "Skill target path");
  }
  return paths;
}

async function performSkillTarget(
  options: MigrateOptions,
  target: MigrationAgentName,
  sources: Awaited<ReturnType<typeof readSourceArtefacts>>,
  translator: Translator,
  result: MigrateResult,
): Promise<void> {
  const pending: PendingSkillWrite[] = [];
  let failed = false;
  for (const { content, name, sourcePath, sidecars = [] } of sources) {
    const translated = translator(content, name);
    if (!translated) {
      result.skipped.push({
        reason: "Translator returned null (empty or unsupported)",
        pair: { from: options.from, to: target, type: "skills" },
      });
      continue;
    }
    for (const warning of translated.warnings ?? []) {
      result.warnings.push(`${options.from} → ${target} (skills): ${warning}`);
    }
    if ((translated.errors?.length ?? 0) > 0) {
      for (const error of translated.errors ?? []) {
        result.errors.push(`${options.from} → ${target} (skills, ${name}): ${error}`);
      }
      failed = true;
      continue;
    }
    if (translated.skipWrite) continue;
    if (target === "opencode" && openCodeDiscoversSharedSkill(options.from, sourcePath)) {
      result.warnings.push(
        `${options.from} → opencode (skills, ${name}): no file copied because OpenCode already discovers this shared skill root`,
      );
      continue;
    }

    const extraFiles = [...(translated.extraFiles ?? []), ...sidecars];
    try {
      const artifact = await applyMigrated(
        target,
        "skills",
        translated.targetName,
        translated.content,
        true,
        extraFiles,
        options.from,
        sourcePath,
      );
      if (artifact) {
        pending.push({
          targetName: translated.targetName,
          content: translated.content,
          extraFiles,
          sourcePath,
          sourceName: name,
          artifact,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Skill preflight failed for ${target}/${name}: ${message}`);
      failed = true;
    }
  }

  const pendingIdentities = new Map<string, string>();
  for (const item of pending) {
    const key = normalizedIdentity(item.targetName);
    const existing = pendingIdentities.get(key);
    if (existing) {
      result.errors.push(
        `Skill target identity collision for ${target}: '${existing}' and '${item.sourceName}'`,
      );
      failed = true;
    } else {
      pendingIdentities.set(key, item.sourceName);
    }
  }
  if (pending.length > 0) {
    try {
      const existingPaths = await existingSkillTargetPaths(target);
      for (const item of pending) {
        const existing = existingPaths.get(collisionKey(item.artifact.targetPath));
        if (existing && resolve(existing.path) !== resolve(item.artifact.targetPath)) {
          result.errors.push(
            `Skill target path collision for ${target}: '${existing.path}' and '${item.artifact.targetPath}'`,
          );
          failed = true;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${target} skill target preflight failed: ${message}`);
      failed = true;
    }
  }
  if (failed) return;

  for (const item of pending) {
    if (options.dryRun) {
      result.migrated.push(item.artifact);
      continue;
    }
    try {
      const artifact = await applyMigrated(
        target,
        "skills",
        item.targetName,
        item.content,
        false,
        item.extraFiles,
        options.from,
        item.sourcePath,
      );
      if (artifact) result.migrated.push(artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Write failed for ${target}/skills/${item.targetName}: ${message}`);
    }
  }
}

/** Execute one migration request containing selected target agents and config types. */
export async function performMigrateTargets(
  options: MigrateTargetsOptions,
): Promise<MigrateResult> {
  const result: MigrateResult = { migrated: [], skipped: [], warnings: [], errors: [] };
  if (options.from === "opencode" || options.targets.includes("opencode")) {
    const environmentErrors = openCodeEnvironmentErrors();
    if (environmentErrors.length > 0) {
      result.errors.push(...environmentErrors);
      return result;
    }
  }
  const targets = [...new Set(options.targets)];
  const types = [...new Set(options.types)];
  const dryRun = options.dryRun ?? false;
  const selectsAllAgents = ALL_AGENTS.every((agent) => targets.includes(agent));
  const codexPreflightErrors = targets.includes("codex")
    ? await codexCommandSkillPreflight(options.from, types)
    : [];
  const codexCommandSkillsBlocked = codexPreflightErrors.length > 0;
  result.errors.push(...codexPreflightErrors);

  for (const type of types) {
    if (type === "agents") {
      if (selectsAllAgents) {
        await performAgentMigrate({ from: options.from, to: "all", type, dryRun }, result);
        continue;
      }

      let selectedTargets = targets;
      if (isSharedAlias(options.from)) {
        const conflicting = targets.filter(
          (target) => target !== options.from && isSharedAlias(target),
        );
        if (conflicting.length > 0) {
          result.errors.push("Copilot and VS Code agents use the same physical store");
          selectedTargets = targets.filter((target) => !conflicting.includes(target));
        }
      }
      const plans = selectedAgentTargetPlans(selectedTargets);
      if (plans.length > 0) {
        await performAgentMigrate({ from: options.from, to: "all", type, dryRun }, result, plans);
      }
      continue;
    }

    const blockCodexForType =
      codexCommandSkillsBlocked && (type === "commands" || type === "skills");
    let targetRequests: Array<MigrationAgentName | "all"> = selectsAllAgents ? ["all"] : targets;
    if (blockCodexForType) {
      targetRequests = targets.filter(
        (target) => target !== "codex" && (!selectsAllAgents || target !== options.from),
      );
    }
    for (const target of targetRequests) {
      appendMigrateResult(
        result,
        await performMigrate({
          from: options.from,
          to: target,
          type,
          dryRun,
        }),
      );
    }
  }

  return result;
}

/**
 * Execute a cross-agent configuration migration.
 *
 * Reads source config, translates via the registry, detects secrets in MCP
 * content (aborts if found), and writes to target agent config files.
 * Write errors are caught per-artefact without aborting remaining items.
 *
 * @param options - Migration options (from, to, type, name, dryRun).
 * @returns Aggregate result with migrated, skipped, warnings, and errors.
 */
export async function performMigrate(options: MigrateOptions): Promise<MigrateResult> {
  const result: MigrateResult = {
    migrated: [],
    skipped: [],
    warnings: [],
    errors: [],
  };

  if (options.from === "opencode" || options.to === "opencode" || options.to === "all") {
    const environmentErrors = openCodeEnvironmentErrors();
    if (environmentErrors.length > 0) {
      result.errors.push(...environmentErrors);
      return result;
    }
  }

  const sharedAgentsConflict =
    options.to !== "all" && isSharedAlias(options.from) && isSharedAlias(options.to);
  if (sharedAgentsConflict && options.type === "agents") {
    result.errors.push("Copilot and VS Code agents use the same physical store");
    return result;
  }

  const targetAgents: MigrationAgentName[] =
    options.to === "all" ? ALL_AGENTS.filter((a) => a !== options.from) : [options.to];

  const typesToMigrate: ConfigType[] = options.type ? [options.type] : ALL_CONFIG_TYPES;
  const codexPreflightErrors = targetAgents.includes("codex")
    ? await codexCommandSkillPreflight(options.from, typesToMigrate, options.name)
    : [];
  const codexCommandSkillsBlocked = codexPreflightErrors.length > 0;
  result.errors.push(...codexPreflightErrors);

  for (const type of typesToMigrate) {
    if (type === "agents") {
      if (sharedAgentsConflict) {
        result.errors.push("Copilot and VS Code agents use the same physical store");
        continue;
      }
      await performAgentMigrate(options, result);
      continue;
    }
    if (
      codexCommandSkillsBlocked &&
      (type === "commands" || type === "skills") &&
      targetAgents.every((target) => target === "codex")
    ) {
      continue;
    }
    let sources: Awaited<ReturnType<typeof readSourceArtefacts>>;
    try {
      sources = await readSourceArtefacts(options.from, type, options.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to read ${options.from} ${type}: ${message}`);
      return result;
    }
    if (sources.length === 0) {
      // Hard-error when the user explicitly named an artefact that doesn't
      // exist — silent skip would hide typos. Matches secret-detection abort.
      if (options.name) {
        result.errors.push(
          `Source artefact '${options.name}' not found in ${options.from} ${type}`,
        );
        return result;
      }
      for (const target of targetAgents) {
        result.skipped.push({
          reason: "No source artefacts found",
          pair: { from: options.from, to: target, type },
        });
      }
      continue;
    }

    for (const target of targetAgents) {
      if (
        codexCommandSkillsBlocked &&
        target === "codex" &&
        (type === "commands" || type === "skills")
      ) {
        continue;
      }
      const translator = getTranslator(options.from, target, type);
      if (!translator) {
        result.skipped.push({
          reason: "No translator registered",
          pair: { from: options.from, to: target, type },
        });
        continue;
      }

      if (type === "commands") {
        await performCommandTarget(options, target, sources, translator, result);
        continue;
      }

      if (type === "skills") {
        await performSkillTarget(options, target, sources, translator, result);
        continue;
      }

      for (const { content, name, sourcePath, sidecars = [] } of sources) {
        const translated = translator(content, name);
        if (!translated) {
          result.skipped.push({
            reason: "Translator returned null (empty or unsupported)",
            pair: { from: options.from, to: target, type },
          });
          continue;
        }

        if (translated.warnings && translated.warnings.length > 0) {
          for (const w of translated.warnings) {
            result.warnings.push(`${options.from} → ${target} (${type}): ${w}`);
          }
        }

        if ((translated.errors?.length ?? 0) > 0) {
          for (const error of translated.errors ?? []) {
            result.errors.push(`${options.from} → ${target} (${type}): ${error}`);
          }
          continue;
        }

        // Translator opted out of writing (e.g. every server in the source
        // was dropped by the target's schema). Warnings have already been
        // captured above, so just move on without creating an empty stub.
        if (translated.skipWrite) {
          continue;
        }

        const finalContent = translated.content;
        if (type === "mcp") {
          const secretErrors = mcpSecretSafetyErrors(content, finalContent, options.from, target);
          if (secretErrors.length > 0) {
            result.errors.push(...secretErrors);
            return result;
          }
        }

        try {
          // Combine translator-emitted extras (rare) with source sidecars
          // (skills' supporting files travel from source dir verbatim).
          const allExtras = [...(translated.extraFiles ?? []), ...sidecars];
          const artifact = await applyMigrated(
            target,
            type,
            translated.targetName,
            finalContent,
            options.dryRun ?? false,
            allExtras,
            options.from,
            sourcePath,
          );
          if (artifact) {
            result.migrated.push(artifact);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Write failed for ${target}/${type}/${translated.targetName}: ${msg}`);
        }
      }
    }
  }

  return result;
}
