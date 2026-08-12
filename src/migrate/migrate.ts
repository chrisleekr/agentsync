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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import * as TOML from "@iarna/toml";
import { type ParseError, parse as parseJsonc } from "jsonc-parser";
import { atomicWrite, readIfExists, setJsoncTopLevelKey } from "../agents/_utils";
import { applyClaudeMd } from "../agents/claude";
import { applyCodexAgentsMd } from "../agents/codex";
import { applyCopilotInstructions } from "../agents/copilot";
import { applyCursorRules } from "../agents/cursor";
import type { AgentName } from "../agents/registry";
import { InvalidSkillNameError, validateSkillName } from "../agents/skills-walker";
import { AgentPaths } from "../config/paths";
import { redactSecretLiterals } from "../core/sanitizer";
import { getTranslator } from "./registry";
import {
  getSharedAgentTarget,
  inspectAgentSource,
  type PhysicalAgentFormat,
  portableFilenameError,
  type SharedAgentTarget,
  setSharedAgentTarget,
} from "./translators/agents";
import type {
  ConfigType,
  ExtraFile,
  MigratedArtifact,
  MigrateOptions,
  MigrateResult,
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
async function resolveSkillsSourceDir(agent: AgentName): Promise<string | null> {
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

function resolveSkillsTargetDir(agent: AgentName): string | null {
  if (agent === "claude") return AgentPaths.claude.skillsDir;
  if (agent === "cursor") return AgentPaths.cursor.skillsDir;
  if (agent === "copilot") return AgentPaths.copilot.skillsDir;
  if (agent === "codex") return AgentPaths.codex.userSkillsDir;
  return null;
}

function resolveRulesDir(agent: AgentName): string | null {
  if (agent === "claude") return AgentPaths.claude.rulesDir;
  if (agent === "cursor") return AgentPaths.cursor.rulesDir;
  if (agent === "codex") return AgentPaths.codex.rulesDir;
  return null;
}

function canonicalAgentFormat(agent: AgentName): PhysicalAgentFormat {
  return agent === "vscode" ? "copilot" : agent;
}

function resolveAgentsDir(agent: AgentName): string {
  if (agent === "claude") return AgentPaths.claude.agentsDir;
  if (agent === "cursor") return AgentPaths.cursor.agentsDir;
  if (agent === "codex") return AgentPaths.codex.agentsDir;
  if (agent === "vscode") return AgentPaths.vscode.agentsDir;
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

async function readAgentFiles(agent: AgentName, filterName?: string) {
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
async function readSkillSidecars(skillDir: string): Promise<ExtraFile[]> {
  const sidecars: ExtraFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(skillDir, full);
      if (rel === "SKILL.md") continue;
      const buf = await readFile(full).catch(() => null);
      if (!buf) continue;
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
const ALL_AGENTS: AgentName[] = ["claude", "cursor", "codex", "copilot", "vscode"];

/**
 * Read configuration files from a source agent for a given config type.
 * @param agent - Source agent to read from.
 * @param type - Configuration type to read.
 * @param filterName - If provided, only return artefacts matching this filename.
 * @returns Array of { content, name } pairs. Missing files return []; agent read failures throw.
 */
export async function readSourceArtefacts(
  agent: AgentName,
  type: ConfigType,
  filterName?: string,
): Promise<Array<{ content: string; name: string; sourcePath: string; sidecars?: ExtraFile[] }>> {
  const results: Array<{
    content: string;
    name: string;
    sourcePath: string;
    sidecars?: ExtraFile[];
  }> = [];

  if (type === "agents") return readAgentFiles(agent, filterName);

  if (type === "global-rules") {
    if (agent === "cursor") {
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
      const pathMap: Partial<Record<AgentName, string>> = {
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
    const pathMap: Partial<Record<AgentName, string>> = {
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
    const dirMap: Partial<Record<AgentName, { dir: string; ext: string }>> = {
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

function resolveAgentTargetPath(to: AgentName, targetName: string): string {
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
  to: AgentName,
  targetName: string,
): Promise<AgentWriteTarget> {
  const targetPath = resolveAgentTargetPath(to, targetName);
  const root = resolveAgentsDir(to);
  const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (rootInfo && (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())) {
    throw new Error(`Agent target directory '${root}' must be a real directory`);
  }
  const targetInfo = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (targetInfo && (!targetInfo.isFile() || targetInfo.isSymbolicLink())) {
    throw new Error(`Agent target '${targetName}' must be a regular file`);
  }
  return {
    path: targetPath,
    mode: targetInfo ? targetInfo.mode & 0o777 : 0o600,
  };
}

async function stageAgentWrite(targetPath: string, content: string, mode: number): Promise<void> {
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
    await rename(tempPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
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
  to: AgentName,
  type: ConfigType,
  targetName: string,
  content: string,
  dryRun: boolean,
  extraFiles: ExtraFile[] = [],
  from?: AgentName,
  sourcePath?: string,
): Promise<MigratedArtifact | null> {
  // Compose `${from} → ${to}: <kind>` when caller threads source info;
  // fall back to bare `<kind>` when invoked directly (e.g. unit tests).
  const arrow = from ? `${from} → ${to}: ` : "";
  const src = sourcePath ?? "";
  if (type === "agents") {
    let target = await validateAgentWriteTarget(to, targetName);
    if (!dryRun) {
      await mkdir(dirname(target.path), { recursive: true });
      target = await validateAgentWriteTarget(to, targetName);
      await stageAgentWrite(target.path, content, target.mode);
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
      if (!dryRun) await applyCursorRules(content);
      return {
        targetPath,
        sourcePath: src,
        content,
        description: `${arrow}cursor rules field`,
      };
    }
    const pathMap: Partial<Record<AgentName, string>> = {
      claude: AgentPaths.claude.claudeMd,
      codex: AgentPaths.codex.agentsMd,
      copilot: AgentPaths.copilot.instructionsFile,
    };
    const targetPath = pathMap[to];
    if (!targetPath) return null;

    const applyMap: Partial<Record<AgentName, (c: string) => Promise<void>>> = {
      claude: applyClaudeMd,
      codex: applyCodexAgentsMd,
      copilot: applyCopilotInstructions,
    };
    const applyFn = applyMap[to];
    if (!applyFn) return null;
    if (!dryRun) await applyFn(content);
    return {
      targetPath,
      sourcePath: src,
      content,
      description: `${arrow}global rules`,
    };
  }

  if (type === "mcp") {
    const pathMap: Partial<Record<AgentName, string>> = {
      claude: AgentPaths.claude.mcpJson,
      cursor: AgentPaths.cursor.mcpGlobal,
      codex: AgentPaths.codex.configToml,
      vscode: AgentPaths.vscode.mcpJson,
      copilot: AgentPaths.copilot.mcpConfigJson,
    };
    const targetPath = pathMap[to];
    if (!targetPath) return null;

    if (!dryRun) {
      // Per-server merge: read existing target, merge source servers in.
      // The merge key is target-specific because each target uses a different
      // top-level layout (Codex: TOML `[mcp.servers.*]`; VS Code: `servers` +
      // `inputs`; Claude/Cursor: `mcpServers`). Using the wrong key would
      // either write to a section the target ignores or duplicate state.
      const existing = await readIfExists(targetPath);
      if (existing) {
        if (to === "codex") {
          // Codex config.toml is strict TOML, not JSONC. A malformed existing
          // file throws here and is recorded as a write error upstream, never
          // silently overwritten.
          const existingParsed = TOML.parse(existing);
          const incomingParsed = TOML.parse(content);
          const existingMcp = (existingParsed.mcp ?? {}) as TOML.JsonMap;
          const incomingMcp = (incomingParsed.mcp ?? {}) as TOML.JsonMap;
          const existingServers = (existingMcp.servers ?? {}) as TOML.JsonMap;
          const incomingServers = (incomingMcp.servers ?? {}) as TOML.JsonMap;
          existingMcp.servers = { ...existingServers, ...incomingServers };
          existingParsed.mcp = existingMcp;
          content = TOML.stringify(existingParsed);
        } else if (to === "vscode") {
          // VS Code mcp.json is JSONC (comments, trailing commas) and sits
          // beside user state. Edit servers/inputs in place so unrelated keys
          // and comments survive; a strict JSON.parse used to throw on any
          // JSONC feature, after which the bare catch overwrote the whole file.
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
          // Claude, Cursor, and Copilot: mcpServers merge. ~/.claude.json is
          // large and JSONC-tolerant, and Claude Code continuously writes
          // trackedFileBackups, projects, and other state to it. A strict
          // JSON.parse threw on any JSONC feature and the bare catch then
          // overwrote the whole file with just mcpServers, destroying that
          // state. Edit mcpServers in place, matching applyClaudeMcp on the
          // pull side. A genuinely corrupt target (real JSON error, not a JSONC
          // feature) reads as {} and is rewritten as a clean mcpServers object —
          // the same fail-open the pull path takes, since no safe in-place edit
          // of unparseable content exists.
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
      await atomicWrite(targetPath, content);
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
      const targetPath = join(AgentPaths.codex.userSkillsDir, skillName, "SKILL.md");
      if (!dryRun) {
        await mkdir(join(AgentPaths.codex.userSkillsDir, skillName), { recursive: true });
        await atomicWrite(targetPath, content);
      }
      return {
        targetPath,
        sourcePath: src,
        content,
        description: `${arrow}command "${skillName}" wrapped as skill`,
      };
    }

    const dirMap: Partial<Record<AgentName, string>> = {
      claude: AgentPaths.claude.commandsDir,
      cursor: AgentPaths.cursor.commandsDir,
      copilot: AgentPaths.copilot.promptsDir,
    };
    const dir = dirMap[to];
    if (!dir) return null;

    const targetPath = join(dir, targetName);
    if (!dryRun) await atomicWrite(targetPath, content);
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
    if (!dryRun) {
      await mkdir(skillRoot, { recursive: true });
      await atomicWrite(skillMdPath, content);
      for (const extra of extraFiles) {
        const isBase64 = extra.encoding === "base64";
        const buf = isBase64 ? Buffer.from(extra.content, "base64") : extra.content;
        const extraPath = join(skillRoot, extra.relPath);
        await atomicWrite(extraPath, buf);
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
  logical: AgentName;
  sharedTarget?: SharedAgentTarget;
}

interface PendingAgentWrite {
  target: AgentTargetPlan;
  targetName: string;
  content: string;
  sourcePath: string;
  artifact: MigratedArtifact;
}

function isSharedAlias(agent: AgentName): boolean {
  return agent === "copilot" || agent === "vscode";
}

function sharedTargetFor(agent: AgentName): SharedAgentTarget | undefined {
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

  return (["claude", "cursor", "codex", "copilot"] as const)
    .filter((physical) => physical !== source)
    .map((physical) => ({ physical, logical: physical }));
}

function selectedAgentTargetPlans(targets: readonly AgentName[]): AgentTargetPlan[] {
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

async function existingAgentPaths(target: AgentTargetPlan): Promise<Map<string, string>> {
  const root = resolveAgentsDir(target.logical);
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
  const paths = new Map<string, string>();
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.name.toLowerCase().endsWith(agentExtension(target.physical))) continue;
    const key = collisionKey(join(root, entry.name));
    const existing = paths.get(key);
    if (existing && existing !== entry.name) {
      throw new Error(`Agent target path collision: '${existing}' and '${entry.name}'`);
    }
    paths.set(key, entry.name);
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
      return new Map<string, string>();
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
      } else if (existing && existing !== item.targetName) {
        result.errors.push(`Agent target path collision: '${existing}' and '${item.targetName}'`);
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
  from: AgentName;
  targets: readonly AgentName[];
  types: readonly ConfigType[];
  dryRun?: boolean;
}

function appendMigrateResult(target: MigrateResult, source: MigrateResult): void {
  target.migrated.push(...source.migrated);
  target.skipped.push(...source.skipped);
  target.warnings.push(...source.warnings);
  target.errors.push(...source.errors);
}

/** Execute one migration request containing selected target agents and config types. */
export async function performMigrateTargets(
  options: MigrateTargetsOptions,
): Promise<MigrateResult> {
  const result: MigrateResult = { migrated: [], skipped: [], warnings: [], errors: [] };
  const targets = [...new Set(options.targets)];
  const types = [...new Set(options.types)];
  const dryRun = options.dryRun ?? false;
  const selectsAllAgents = ALL_AGENTS.every((agent) => targets.includes(agent));

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

    const targetRequests: Array<AgentName | "all"> = selectsAllAgents ? ["all"] : targets;
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

  const sharedAgentsConflict =
    options.to !== "all" && isSharedAlias(options.from) && isSharedAlias(options.to);
  if (sharedAgentsConflict && options.type === "agents") {
    result.errors.push("Copilot and VS Code agents use the same physical store");
    return result;
  }

  const targetAgents: AgentName[] =
    options.to === "all" ? ALL_AGENTS.filter((a) => a !== options.from) : [options.to];

  const typesToMigrate: ConfigType[] = options.type ? [options.type] : ALL_CONFIG_TYPES;

  for (const type of typesToMigrate) {
    if (type === "agents") {
      if (sharedAgentsConflict) {
        result.errors.push("Copilot and VS Code agents use the same physical store");
        continue;
      }
      await performAgentMigrate(options, result);
      continue;
    }
    const sources = await readSourceArtefacts(options.from, type, options.name);
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
      const translator = getTranslator(options.from, target, type);
      if (!translator) {
        result.skipped.push({
          reason: "No translator registered",
          pair: { from: options.from, to: target, type },
        });
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

        // Secret detection for MCP content — abort if secrets found
        const finalContent = translated.content;
        if (type === "mcp") {
          try {
            const parsed = JSON.parse(finalContent);
            const redacted = redactSecretLiterals(parsed, "mcpServers");
            if (redacted.warnings.length > 0) {
              result.errors.push(
                ...redacted.warnings.map((w) => `${w} — migration aborted for security`),
              );
              return result;
            }
          } catch {
            // For TOML content, parse it first then check for secrets
            try {
              const tomlParsed = TOML.parse(finalContent);
              const redacted = redactSecretLiterals(tomlParsed, "mcpContent");
              if (redacted.warnings.length > 0) {
                result.errors.push(
                  ...redacted.warnings.map((w) => `${w} — migration aborted for security`),
                );
                return result;
              }
            } catch {
              // Translators emit content we control; unparseable bytes here mean
              // a translator bug. Fail closed so a future broken translator can't
              // smuggle secrets past the redaction gate.
              result.errors.push(
                `MCP content for ${options.from} → ${target} is neither valid JSON nor TOML — secret scan cannot run; aborting`,
              );
              return result;
            }
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
