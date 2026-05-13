import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import { shouldNeverSync } from "../core/sanitizer";
import { extractArchive } from "../core/tar";
import { atomicWrite, readIfExists, type SnapshotArtifact, type SnapshotResult } from "./_utils";
import { collectSkillArtifacts, InvalidSkillNameError, validateSkillName } from "./skills-walker";

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
export async function snapshotCopilot(): Promise<SnapshotResult> {
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  // Single instructions file (may or may not have extension)
  const instructionsFile = await readIfExists(AgentPaths.copilot.instructionsFile);
  if (instructionsFile !== null) {
    artifacts.push({
      vaultPath: "copilot/instructions.md.age",
      sourcePath: AgentPaths.copilot.instructionsFile,
      plaintext: instructionsFile,
      warnings: [],
    });
  }

  // Instructions directory *.instructions.md
  try {
    const names = await readdir(AgentPaths.copilot.instructionsDir);
    for (const name of names) {
      if (!name.endsWith(".instructions.md")) continue;
      const sourcePath = join(AgentPaths.copilot.instructionsDir, name);
      if (shouldNeverSync(sourcePath)) continue;
      const content = await readIfExists(sourcePath);
      if (content !== null) {
        artifacts.push({
          vaultPath: `copilot/instructions/${name}.age`,
          sourcePath,
          plaintext: content,
          warnings: [],
        });
      }
    }
  } catch {
    // directory may not exist
  }

  // Prompts *.prompt.md
  try {
    const names = await readdir(AgentPaths.copilot.promptsDir);
    for (const name of names) {
      if (!name.endsWith(".prompt.md")) continue;
      const sourcePath = join(AgentPaths.copilot.promptsDir, name);
      if (shouldNeverSync(sourcePath)) continue;
      const content = await readIfExists(sourcePath);
      if (content !== null) {
        artifacts.push({
          vaultPath: `copilot/prompts/${name}.age`,
          sourcePath,
          plaintext: content,
          warnings: [],
        });
      }
    }
  } catch {
    // directory may not exist
  }

  // Skills — delegated to the shared walker so dot-skip, symlink rejection,
  // sentinel verification, never-sync interior scan, and symlink-filtered
  // archival stay identical across every skill-bearing agent. The walker
  // uses lstat throughout, so symlinked roots and symlinked SKILL.md
  // sentinels (the vendored-pool pattern seen on real machines) are skipped.
  const copilotSkills = await collectSkillArtifacts("copilot", AgentPaths.copilot.skillsDir);
  artifacts.push(...copilotSkills.artifacts);
  warnings.push(...copilotSkills.warnings);

  // Copilot agents live as single `<name>.agent.md` files per the GitHub docs.
  // The walker rejects dotfiles, traversal segments, and symlinked entries
  // (readFile follows symlinks, so a `foo.agent.md → /etc/passwd` symlink
  // would otherwise smuggle arbitrary content into the encrypted vault).
  // Markdown bodies are scanned for embedded literal secrets by the central
  // walker in `commands/push.ts`.
  try {
    const entries = await readdir(AgentPaths.copilot.agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const name = entry.name;
      try {
        validateCopilotAgentFileName(name);
      } catch {
        continue;
      }
      const sourcePath = join(AgentPaths.copilot.agentsDir, name);
      if (shouldNeverSync(sourcePath)) continue;
      const content = await readIfExists(sourcePath);
      if (content !== null) {
        artifacts.push({
          vaultPath: `copilot/agents/${name}.age`,
          sourcePath,
          plaintext: content,
          warnings: [],
        });
      }
    }
  } catch {
    // agents dir may not exist
  }

  return { artifacts, warnings };
}

/** Restore the legacy single-file Copilot instructions entry point. */
export async function applyCopilotInstructions(content: string): Promise<void> {
  await atomicWrite(AgentPaths.copilot.instructionsFile, content);
}

/** Restore one Copilot instruction file from the vault. */
export async function applyCopilotInstructionFile(
  fileName: string,
  content: string,
): Promise<void> {
  const target = join(AgentPaths.copilot.instructionsDir, fileName);
  await mkdir(AgentPaths.copilot.instructionsDir, { recursive: true });
  await atomicWrite(target, content);
}

/** Restore one Copilot prompt file from the vault. */
export async function applyCopilotPrompt(fileName: string, content: string): Promise<void> {
  const target = join(AgentPaths.copilot.promptsDir, fileName);
  await mkdir(AgentPaths.copilot.promptsDir, { recursive: true });
  await atomicWrite(target, content);
}

/** Extract one archived Copilot skill directory into the local skills folder. */
export async function applyCopilotSkill(skillName: string, base64Tar: string): Promise<void> {
  validateSkillName(skillName);
  const targetDir = join(AgentPaths.copilot.skillsDir, skillName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

/** Restore one Copilot `<name>.agent.md` single-file agent from the vault. */
export async function applyCopilotAgent(fileName: string, content: string): Promise<void> {
  validateCopilotAgentFileName(fileName);
  const target = join(AgentPaths.copilot.agentsDir, fileName);
  await mkdir(AgentPaths.copilot.agentsDir, { recursive: true });
  await atomicWrite(target, content);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { readdir as _readdir, readFile } from "node:fs/promises";
import { decryptString } from "../core/encryptor";

/** Read encrypted files from a vault subdirectory, ignoring missing directories. */
async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const names = await _readdir(dir);
    return names
      .filter((name) => name.endsWith(".age"))
      .map((name) => ({
        name,
        fullPath: join(dir, name),
      }));
  } catch {
    return [];
  }
}

/** Decrypt and apply all Copilot vault artifacts to the local machine. */
export async function applyCopilotVault(
  vaultDir: string,
  key: string,
  dryRun: boolean,
): Promise<void> {
  const copilotDir = join(vaultDir, "copilot");
  const files = await readAgeFiles(copilotDir);

  for (const { name, fullPath } of files) {
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);

    if (name === "instructions.md.age") {
      if (dryRun) {
        log.info("[dry-run] [copilot] would apply instructions");
        continue;
      }
      await applyCopilotInstructions(decrypted);
    }
  }

  // instructions/ sub-directory
  const instrFiles = await readAgeFiles(join(copilotDir, "instructions"));
  for (const { name, fullPath } of instrFiles) {
    if (!name.endsWith(".instructions.md.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const fileName = basename(name, ".age");
    if (dryRun) {
      log.info(`[dry-run] [copilot] would write instruction: ${fileName}`);
      continue;
    }
    await applyCopilotInstructionFile(fileName, decrypted);
  }

  // prompts/ sub-directory
  const promptFiles = await readAgeFiles(join(copilotDir, "prompts"));
  for (const { name, fullPath } of promptFiles) {
    if (!name.endsWith(".prompt.md.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const fileName = basename(name, ".age");
    if (dryRun) {
      log.info(`[dry-run] [copilot] would write prompt: ${fileName}`);
      continue;
    }
    await applyCopilotPrompt(fileName, decrypted);
  }

  // skills/ sub-directory — stored as <name>.tar.age
  const skillFiles = await readAgeFiles(join(copilotDir, "skills"));
  for (const { name, fullPath } of skillFiles) {
    if (!name.endsWith(".tar.age")) continue;
    const skillName = basename(name, ".tar.age");
    try {
      validateSkillName(skillName);
    } catch (err) {
      if (err instanceof InvalidSkillNameError) {
        log.warn(`[copilot] Skipping vault skill with invalid name '${name}': ${err.reason}`);
        continue;
      }
      throw err;
    }
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    if (dryRun) {
      log.info(`[dry-run] [copilot] would extract skill: ${skillName}`);
      continue;
    }
    await applyCopilotSkill(skillName, decrypted);
  }

  // agents/ sub-directory — stored as <name>.agent.md.age
  const agentFiles = await readAgeFiles(join(copilotDir, "agents"));
  for (const { name, fullPath } of agentFiles) {
    if (!name.endsWith(".agent.md.age")) continue;
    const fileName = basename(name, ".age");
    try {
      validateCopilotAgentFileName(fileName);
    } catch {
      log.warn(`[copilot] Skipping vault agent with invalid name '${name}'`);
      continue;
    }
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    if (dryRun) {
      log.info(`[dry-run] [copilot] would write agent: ${fileName}`);
      continue;
    }
    await applyCopilotAgent(fileName, decrypted);
  }
}
