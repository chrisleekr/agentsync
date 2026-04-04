import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "@clack/prompts";
import { AgentPaths } from "../config/paths";
import { shouldNeverSync } from "../core/sanitizer";
import { archiveDirectory, extractArchive } from "../core/tar";
import { type SnapshotArtifact, atomicWrite, readIfExists } from "./_utils";

export interface CopilotSnapshotResult {
  artifacts: SnapshotArtifact[];
  warnings: string[];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function snapshotCopilot(): Promise<CopilotSnapshotResult> {
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
    const entries = await readdir(AgentPaths.copilot.instructionsDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".instructions.md")) continue;
      const sourcePath = join(AgentPaths.copilot.instructionsDir, entry.name);
      if (shouldNeverSync(sourcePath)) continue;
      const content = await readIfExists(sourcePath);
      if (content !== null) {
        artifacts.push({
          vaultPath: `copilot/instructions/${entry.name}.age`,
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
    const entries = await readdir(AgentPaths.copilot.promptsDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".prompt.md")) continue;
      const sourcePath = join(AgentPaths.copilot.promptsDir, entry.name);
      if (shouldNeverSync(sourcePath)) continue;
      const content = await readIfExists(sourcePath);
      if (content !== null) {
        artifacts.push({
          vaultPath: `copilot/prompts/${entry.name}.age`,
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
    const entries = await readdir(AgentPaths.copilot.skillsDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = join(AgentPaths.copilot.skillsDir, entry.name);
      const skillMd = join(skillDir, "SKILL.md");
      if (!(await fileExists(skillMd))) continue; // not a valid skill directory
      const tarBuffer = await archiveDirectory(skillDir);
      artifacts.push({
        vaultPath: `copilot/skills/${entry.name}.tar.age`,
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
    const entries = await readdir(AgentPaths.copilot.agentsDir, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const agentDir = join(AgentPaths.copilot.agentsDir, entry.name);
      const tarBuffer = await archiveDirectory(agentDir);
      artifacts.push({
        vaultPath: `copilot/agents/${entry.name}.tar.age`,
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

export async function applyCopilotInstructions(content: string): Promise<void> {
  await atomicWrite(AgentPaths.copilot.instructionsFile, content);
}

export async function applyCopilotInstructionFile(
  fileName: string,
  content: string,
): Promise<void> {
  const target = join(AgentPaths.copilot.instructionsDir, fileName);
  await mkdir(AgentPaths.copilot.instructionsDir, { recursive: true });
  await atomicWrite(target, content);
}

export async function applyCopilotPrompt(fileName: string, content: string): Promise<void> {
  const target = join(AgentPaths.copilot.promptsDir, fileName);
  await mkdir(AgentPaths.copilot.promptsDir, { recursive: true });
  await atomicWrite(target, content);
}

/**
 * Extract a tar-archived (base64-encoded) skill directory into the skills dir.
 */
export async function applyCopilotSkill(skillName: string, base64Tar: string): Promise<void> {
  const targetDir = join(AgentPaths.copilot.skillsDir, skillName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

export async function applyCopilotAgent(agentName: string, base64Tar: string): Promise<void> {
  const targetDir = join(AgentPaths.copilot.agentsDir, agentName);
  await mkdir(targetDir, { recursive: true });
  const tarBuffer = Buffer.from(base64Tar, "base64");
  await extractArchive(tarBuffer, targetDir);
}

// ─── Apply (pull side) ────────────────────────────────────────────────────────

import { readdir as _readdir, readFile } from "node:fs/promises";
import { decryptString } from "../core/encryptor";

async function readAgeFiles(dir: string): Promise<{ name: string; fullPath: string }[]> {
  try {
    const entries = await _readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".age"))
      .map((e) => ({ name: e.name, fullPath: join(dir, e.name) }));
  } catch {
    return [];
  }
}

/**
 * Decrypt and apply all Copilot vault artifacts to the local machine.
 */
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
