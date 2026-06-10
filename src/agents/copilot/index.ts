import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { AgentPaths } from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import {
  type ApplyPlan,
  defineFileArtifact,
  dirWriteApplier,
  makeApplyVault,
  skillNameFilter,
} from "../_apply";
import { collectMarkdownDir, collectSingleFile } from "../_snapshot";
import { atomicWrite, readIfExists, type SnapshotArtifact, type SnapshotResult } from "../_utils";
import { applySkillArchive, collectSkillArtifacts } from "../skills-walker";

/**
 * Reject Copilot agent filenames that could escape `agentsDir`, smuggle in
 * vendor dotfiles, or skip the documented `.agent.md` suffix. Called on both
 * sides of the wire so a malicious vault entry or a stray dotfile in the user
 * directory cannot widen the surface beyond what the GitHub Copilot CLI docs
 * actually consume.
 */
function validateCopilotAgentFileName(fileName: string): void {
  if (
    fileName.length === 0 ||
    fileName !== basename(fileName) ||
    fileName.startsWith(".") ||
    fileName.includes("\0") ||
    !fileName.endsWith(".agent.md")
  ) {
    throw new Error(`Invalid Copilot agent filename: ${fileName}`);
  }
}

/** Snapshot payload for the Copilot adapter. */
export type CopilotSnapshotResult = SnapshotResult;

/** Collect Copilot instructions, prompts, skills, and agents into vault artifacts. */
export async function snapshotCopilot(_config?: AgentSyncConfig): Promise<SnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  artifacts.push(
    // Single instructions entry point.
    ...(await collectSingleFile({
      sourcePath: AgentPaths.copilot.instructionsFile,
      vaultPath: "copilot/instructions.md.age",
    })),
    // Instructions directory *.instructions.md
    ...(await collectMarkdownDir({
      dir: AgentPaths.copilot.instructionsDir,
      vaultPath: (name) => `copilot/instructions/${name}.age`,
      match: (name) => name.endsWith(".instructions.md"),
    })),
    // Prompts *.prompt.md
    ...(await collectMarkdownDir({
      dir: AgentPaths.copilot.promptsDir,
      vaultPath: (name) => `copilot/prompts/${name}.age`,
      match: (name) => name.endsWith(".prompt.md"),
    })),
    // Copilot agents live as single `<name>.agent.md` files per the GitHub docs.
    // collectMarkdownDir rejects dotfiles, non-files, and symlinked entries
    // (readFile follows symlinks, so a `foo.agent.md -> /etc/passwd` link would
    // otherwise smuggle content into the vault); the match predicate enforces
    // the `.agent.md` suffix and the traversal/NUL rules.
    ...(await collectMarkdownDir({
      dir: AgentPaths.copilot.agentsDir,
      vaultPath: (name) => `copilot/agents/${name}.age`,
      match: (name) => {
        try {
          validateCopilotAgentFileName(name);
          return true;
        } catch {
          return false;
        }
      },
    })),
  );

  // Skills — delegated to the shared walker (dot-skip, symlink rejection,
  // sentinel verification, never-sync interior scan, symlink-filtered archival).
  const copilotSkills = await collectSkillArtifacts("copilot", AgentPaths.copilot.skillsDir);
  artifacts.push(...copilotSkills.artifacts);
  warnings.push(...copilotSkills.warnings);

  return { artifacts, warnings };
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

/** Restore the legacy single-file Copilot instructions entry point. */
export async function applyCopilotInstructions(content: string): Promise<void> {
  await atomicWrite(AgentPaths.copilot.instructionsFile, content);
}

/** Restore one Copilot instruction file from the vault. */
export function applyCopilotInstructionFile(fileName: string, content: string): Promise<void> {
  return dirWriteApplier({ dir: AgentPaths.copilot.instructionsDir })(fileName, content);
}

/** Restore one Copilot prompt file from the vault. */
export function applyCopilotPrompt(fileName: string, content: string): Promise<void> {
  return dirWriteApplier({ dir: AgentPaths.copilot.promptsDir })(fileName, content);
}

/**
 * Merge incoming mcpServers into ~/.copilot/mcp-config.json.
 * Mirrors the Claude MCP local-merge but skips vault denormalization
 * since migrate writes directly between local agents.
 */
export async function applyCopilotMcp(mcpJsonContent: string): Promise<void> {
  const existingRaw = await readIfExists(AgentPaths.copilot.mcpConfigJson);
  const existing = existingRaw ? (JSON.parse(existingRaw) as Record<string, unknown>) : {};
  const incoming = JSON.parse(mcpJsonContent) as Record<string, unknown>;
  const existingServers =
    typeof existing.mcpServers === "object" && existing.mcpServers !== null
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  const incomingServers =
    typeof incoming.mcpServers === "object" && incoming.mcpServers !== null
      ? (incoming.mcpServers as Record<string, unknown>)
      : {};
  existing.mcpServers = { ...existingServers, ...incomingServers };
  await mkdir(dirname(AgentPaths.copilot.mcpConfigJson), { recursive: true });
  await atomicWrite(AgentPaths.copilot.mcpConfigJson, `${JSON.stringify(existing, null, 2)}\n`);
}

/** Extract one archived Copilot skill directory into the local skills folder. */
export async function applyCopilotSkill(skillName: string, base64Tar: string): Promise<void> {
  await applySkillArchive(AgentPaths.copilot.skillsDir, skillName, base64Tar);
}

/** Restore one Copilot `<name>.agent.md` single-file agent from the vault. */
export function applyCopilotAgent(fileName: string, content: string): Promise<void> {
  return dirWriteApplier({
    dir: AgentPaths.copilot.agentsDir,
    validate: validateCopilotAgentFileName,
  })(fileName, content);
}

/** Build the Copilot apply plan. Exposed so `copy` can apply a single artifact. */
export function buildCopilotPlan(_config?: AgentSyncConfig): ApplyPlan {
  return {
    agent: "copilot",
    directives: [
      defineFileArtifact({
        vaultName: "instructions.md.age",
        dryRunLabel: "[dry-run] [copilot] would apply instructions",
        apply: applyCopilotInstructions,
      }),
      {
        kind: "dir",
        subdir: "instructions",
        suffix: ".age",
        match: (name) => name.endsWith(".instructions.md.age"),
        dryRunVerb: "would write instruction:",
        apply: applyCopilotInstructionFile,
      },
      {
        kind: "dir",
        subdir: "prompts",
        suffix: ".age",
        match: (name) => name.endsWith(".prompt.md.age"),
        dryRunVerb: "would write prompt:",
        apply: applyCopilotPrompt,
      },
      {
        kind: "dir",
        subdir: "skills",
        suffix: ".tar.age",
        dryRunVerb: "would extract skill:",
        apply: applyCopilotSkill,
        filter: skillNameFilter(),
      },
      {
        kind: "dir",
        subdir: "agents",
        suffix: ".age",
        match: (name) => name.endsWith(".agent.md.age"),
        dryRunVerb: "would write agent:",
        apply: applyCopilotAgent,
        // NOT skillNameFilter(): copilot agent filenames have their own rule
        // (.agent.md suffix) and validateCopilotAgentFileName throws a plain
        // Error, so map any failure to a fixed reason rather than re-throwing.
        filter: (name) => {
          try {
            validateCopilotAgentFileName(name);
            return null;
          } catch {
            return { reason: "invalid copilot agent filename" };
          }
        },
      },
    ],
  };
}

/** Decrypt and apply all Copilot vault artifacts to the local machine. */
export const applyCopilotVault = makeApplyVault(buildCopilotPlan);
