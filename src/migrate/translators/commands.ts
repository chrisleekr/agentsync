/**
 * src/migrate/translators/commands.ts
 *
 * Pairwise translators for command/rule/prompt files between agents.
 * All command formats are Markdown files — the only difference is the
 * filename convention and target directory:
 *   - Claude/Cursor: *.md
 *   - Codex: *.md (in rules/ directory)
 *   - Copilot: *.prompt.md
 */

import type { Translator } from "../types";

/** Pass-through translator for agents with identical .md conventions. */
const mdToMd: Translator = (content, sourceName) => {
  const trimmed = content.trim();
  if (!trimmed || !sourceName) return null;
  return { content: `${trimmed}\n`, targetName: sourceName };
};

/** Convert .md command to Copilot's .prompt.md convention. */
const mdToPromptMd: Translator = (content, sourceName) => {
  const trimmed = content.trim();
  if (!trimmed || !sourceName) return null;
  const base = sourceName.endsWith(".md") ? sourceName.slice(0, -3) : sourceName;
  return { content: `${trimmed}\n`, targetName: `${base}.prompt.md` };
};

/** Convert Copilot's .prompt.md back to standard .md convention. */
const promptMdToMd: Translator = (content, sourceName) => {
  const trimmed = content.trim();
  if (!trimmed || !sourceName) return null;
  const base = sourceName.endsWith(".prompt.md")
    ? sourceName.slice(0, -".prompt.md".length)
    : sourceName;
  return { content: `${trimmed}\n`, targetName: `${base}.md` };
};

/**
 * All commands translators indexed by direction for registry registration.
 * Each function passes through Markdown content and adjusts the filename
 * convention (*.md vs *.prompt.md) based on the target agent.
 */
export const translateCommand = {
  claudeToCursor: mdToMd,
  cursorToClaude: mdToMd,
  claudeToCodex: mdToMd,
  cursorToCodex: mdToMd,
  codexToClaude: mdToMd,
  codexToCursor: mdToMd,
  claudeToCopilot: mdToPromptMd,
  cursorToCopilot: mdToPromptMd,
  codexToCopilot: mdToPromptMd,
  copilotToClaude: promptMdToMd,
  copilotToCursor: promptMdToMd,
  copilotToCodex: promptMdToMd,
};
