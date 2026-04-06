import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import { shouldNeverSync } from "../core/sanitizer";
import { archiveDirectory, extractArchive } from "../core/tar";
import { atomicWrite, readIfExists, type SnapshotArtifact, type SnapshotResult } from "./_utils";

/** Snapshot payload for the Copilot adapter. */
export type CopilotSnapshotResult = SnapshotResult;

/** Check whether an optional skill directory sentinel file exists. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

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

  // Skills — each skill is a directory containing at minimum SKILL.md.
  // Archive the whole directory as <name>.tar, then that tar content is what we encrypt.
  try {
    const names = await readdir(AgentPaths.copilot.skillsDir);
    for (const name of names) {
      const skillDir = join(AgentPaths.copilot.skillsDir, name);
      const skillDirStat = await stat(skillDir).catch(() => null);
      if (!skillDirStat?.isDirectory()) continue;
      const skillMd = join(skillDir, "SKILL.md");
      if (!(await fileExists(skillMd))) continue; // not a valid skill directory
      const tarBuffer = await archiveDirectory(skillDir);
      artifacts.push({
        vaultPath: `copilot/skills/${name}.tar.age`,
        sourcePath: skillDir,
        // Store as base64 so it survives the UTF-8 string layer before encryption
        plaintext: tarBuffer.toString("base64"),
        warnings: [],
      });
    }
  } catch {
    // skills dir may not exist
  }

  // Agents directories (tar each one, similar to skills)
  try {
    const names = await readdir(AgentPaths.copilot.agentsDir);
    for (const name of names) {
      const agentDir = join(AgentPaths.copilot.agentsDir, name);
      const agentDirStat = await stat(agentDir).catch(() => null);
      if (!agentDirStat?.isDirectory()) continue;
      const tarBuffer = await archiveDirectory(agentDir);
      artifacts.push({
        vaultPath: `copilot/agents/${name}.tar.age`,
        sourcePath: agentDir,
        plaintext: tarBuffer.toString("base64"),
        warnings: [],
      });
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
  const targetDir = join(AgentPaths.copilot.skillsDir, skillName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

/** Extract one archived Copilot agent directory into the local agents folder. */
export async function applyCopilotAgent(agentName: string, base64Tar: string): Promise<void> {
  const targetDir = join(AgentPaths.copilot.agentsDir, agentName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
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
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const skillName = basename(name, ".tar.age");
    if (dryRun) {
      log.info(`[dry-run] [copilot] would extract skill: ${skillName}`);
      continue;
    }
    await applyCopilotSkill(skillName, decrypted);
  }

  // agents/ sub-directory — stored as <name>.tar.age
  const agentFiles = await readAgeFiles(join(copilotDir, "agents"));
  for (const { name, fullPath } of agentFiles) {
    if (!name.endsWith(".tar.age")) continue;
    const encrypted = await readFile(fullPath, "utf8");
    const decrypted = await decryptString(encrypted, key);
    const agentName = basename(name, ".tar.age");
    if (dryRun) {
      log.info(`[dry-run] [copilot] would extract agent: ${agentName}`);
      continue;
    }
    await applyCopilotAgent(agentName, decrypted);
  }
}
