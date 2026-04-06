/**
 * src/migrate/migrate.ts
 *
 * Orchestrator for cross-agent configuration migration.
 * Reads source configs, dispatches to translators, detects secrets,
 * and writes to target agent config files.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as TOML from "@iarna/toml";
import { atomicWrite, readIfExists } from "../agents/_utils";
import { applyClaudeMd } from "../agents/claude";
import { applyCodexAgentsMd } from "../agents/codex";
import { applyCopilotInstructions } from "../agents/copilot";
import { applyCursorRules } from "../agents/cursor";
import type { AgentName } from "../agents/registry";
import { AgentPaths } from "../config/paths";
import { redactSecretLiterals } from "../core/sanitizer";
import { getTranslator } from "./registry";
import type { ConfigType, MigratedArtifact, MigrateOptions, MigrateResult } from "./types";

const ALL_CONFIG_TYPES: ConfigType[] = ["global-rules", "mcp", "commands"];
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
): Promise<Array<{ content: string; name: string }>> {
  const results: Array<{ content: string; name: string }> = [];

  if (type === "global-rules") {
    if (agent === "cursor") {
      const raw = await readIfExists(AgentPaths.cursor.settingsJson);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.rules === "string" && parsed.rules.trim()) {
            results.push({ content: parsed.rules, name: "__cursor_rules__" });
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
          const name = basename(filePath) || "rules.md";
          results.push({ content, name });
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
    };
    const filePath = pathMap[agent];
    if (filePath) {
      const content = await readIfExists(filePath);
      if (content) {
        const name = basename(filePath) || "mcp";
        results.push({ content, name });
      }
    }
  }

  if (type === "commands") {
    const dirMap: Partial<Record<AgentName, { dir: string; ext: string }>> = {
      claude: { dir: AgentPaths.claude.commandsDir, ext: ".md" },
      cursor: { dir: AgentPaths.cursor.commandsDir, ext: ".md" },
      codex: { dir: AgentPaths.codex.rulesDir, ext: ".md" },
      copilot: { dir: AgentPaths.copilot.promptsDir, ext: ".prompt.md" },
    };
    const entry = dirMap[agent];
    if (entry) {
      try {
        const files = await readdir(entry.dir);
        for (const f of files) {
          if (!f.endsWith(entry.ext)) continue;
          if (filterName && f !== filterName) continue;
          const content = await readFile(join(entry.dir, f), "utf8").catch(() => null);
          if (content) results.push({ content, name: f });
        }
      } catch {
        /* directory missing — return empty */
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
): Promise<MigratedArtifact | null> {
  if (type === "global-rules") {
    if (targetName === "__cursor_rules__") {
      const targetPath = AgentPaths.cursor.settingsJson;
      if (!dryRun) await applyCursorRules(content);
      return {
        targetPath,
        content,
        description: `Cursor rules field in ${targetPath}`,
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
      content,
      description: `${to} global rules written to ${targetPath}`,
    };
  }

  if (type === "mcp") {
    const pathMap: Partial<Record<AgentName, string>> = {
      claude: AgentPaths.claude.mcpJson,
      cursor: AgentPaths.cursor.mcpGlobal,
      codex: AgentPaths.codex.configToml,
      vscode: AgentPaths.vscode.mcpJson,
    };
    const targetPath = pathMap[to];
    if (!targetPath) return null;

    if (!dryRun) {
      // Per-server merge: read existing target, merge source servers in
      const existing = await readIfExists(targetPath);
      if (existing) {
        try {
          if (to === "codex") {
            // TOML merge: preserve non-MCP sections in config.toml
            const existingParsed = TOML.parse(existing);
            const incomingParsed = TOML.parse(content);
            const existingMcp = (existingParsed.mcp ?? {}) as TOML.JsonMap;
            const incomingMcp = (incomingParsed.mcp ?? {}) as TOML.JsonMap;
            const existingServers = (existingMcp.servers ?? {}) as TOML.JsonMap;
            const incomingServers = (incomingMcp.servers ?? {}) as TOML.JsonMap;
            existingMcp.servers = { ...existingServers, ...incomingServers };
            existingParsed.mcp = existingMcp;
            content = TOML.stringify(existingParsed);
          } else {
            // JSON merge: Claude, Cursor, VS Code
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
      content,
      description: `${to} MCP servers written to ${targetPath}`,
    };
  }

  if (type === "commands") {
    const dirMap: Partial<Record<AgentName, string>> = {
      claude: AgentPaths.claude.commandsDir,
      cursor: AgentPaths.cursor.commandsDir,
      codex: AgentPaths.codex.rulesDir,
      copilot: AgentPaths.copilot.promptsDir,
    };
    const dir = dirMap[to];
    if (!dir) return null;

    const targetPath = join(dir, targetName);
    if (!dryRun) await atomicWrite(targetPath, content);
    return {
      targetPath,
      content,
      description: `${to} command written to ${targetPath}`,
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

      for (const { content, name } of sources) {
        const translated = translator(content, name);
        if (!translated) {
          result.skipped.push({
            reason: "Translator returned null (empty or unsupported)",
            pair: { from: options.from, to: target, type },
          });
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
              // If TOML parsing also fails, content is malformed — skip secret check
            }
          }
        }

        try {
          const artifact = await applyMigrated(
            target,
            type,
            translated.targetName,
            finalContent,
            options.dryRun ?? false,
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
