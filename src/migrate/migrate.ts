/**
 * src/migrate/migrate.ts
 *
 * Orchestrator for cross-agent configuration migration.
 * Reads source configs, dispatches to translators, detects secrets,
 * and writes to target agent config files.
 */

import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import * as TOML from "@iarna/toml";
import { atomicWrite, readIfExists } from "../agents/_utils";
import { applyClaudeMd } from "../agents/claude";
import { applyCodexAgentsMd } from "../agents/codex";
import { applyCopilotInstructions } from "../agents/copilot";
import { applyCursorRules } from "../agents/cursor";
import type { AgentName } from "../agents/registry";
import { InvalidSkillNameError, validateSkillName } from "../agents/skills-walker";
import { AgentPaths } from "../config/paths";
import { redactSecretLiterals } from "../core/sanitizer";
import { getTranslator } from "./registry";
import type {
  ConfigType,
  ExtraFile,
  MigratedArtifact,
  MigrateOptions,
  MigrateResult,
} from "./types";

const ALL_CONFIG_TYPES: ConfigType[] = ["global-rules", "mcp", "commands", "skills", "rules"];

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
 * @returns Array of { content, name } pairs. Never throws — returns [] on missing files.
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
        try {
          if (to === "codex") {
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
            const existingParsed = JSON.parse(existing) as Record<string, unknown>;
            const incomingParsed = JSON.parse(content) as Record<string, unknown>;
            const existingServers = (existingParsed.servers ?? {}) as Record<string, unknown>;
            const incomingServers = (incomingParsed.servers ?? {}) as Record<string, unknown>;
            existingParsed.servers = { ...existingServers, ...incomingServers };
            const existingInputs = Array.isArray(existingParsed.inputs)
              ? existingParsed.inputs
              : [];
            const incomingInputs = Array.isArray(incomingParsed.inputs)
              ? incomingParsed.inputs
              : [];
            if (incomingInputs.length > 0) {
              // Source wins on collision (mirrors the spread-based servers
              // merge above and the documented "source value wins" rule in
              // docs/migrate.md). Iterate incoming first so its entry is
              // recorded under the dedupe key before the existing one.
              const seen = new Set<string>();
              const merged: unknown[] = [];
              for (const list of [incomingInputs, existingInputs]) {
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
              existingParsed.inputs = merged;
            }
            content = `${JSON.stringify(existingParsed, null, 2)}\n`;
          } else {
            // Claude and Cursor: mcpServers merge
            const existingParsed = JSON.parse(existing) as Record<string, unknown>;
            const incomingParsed = JSON.parse(content) as Record<string, unknown>;
            const existingServers = (existingParsed.mcpServers ?? {}) as Record<string, unknown>;
            const incomingServers = (incomingParsed.mcpServers ?? {}) as Record<string, unknown>;
            existingParsed.mcpServers = { ...existingServers, ...incomingServers };
            content = `${JSON.stringify(existingParsed, null, 2)}\n`;
          }
        } catch {
          /* existing file corrupt — overwrite entirely */
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

  const targetAgents: AgentName[] =
    options.to === "all" ? ALL_AGENTS.filter((a) => a !== options.from) : [options.to];

  const typesToMigrate: ConfigType[] = options.type ? [options.type] : ALL_CONFIG_TYPES;

  for (const type of typesToMigrate) {
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
