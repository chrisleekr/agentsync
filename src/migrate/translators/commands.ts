/**
 * src/migrate/translators/commands.ts
 *
 * Pairwise translators for command/rule/prompt files between agents.
 * All command formats are Markdown files — the only difference is the
 * filename convention and target directory:
 *   - Claude/Cursor: *.md
 *   - Codex: SKILL.md inside ~/.agents/skills/<name>/ (Codex has no native
 *            slash-command surface, so we wrap commands as skills since
 *            Codex skills are user-invokable as `/<name>`).
 *   - Copilot: *.prompt.md
 */

import { defineTranslator, type Translator } from "../types";
import { firstNonEmptyParagraph, parseFrontmatter, serializeFrontmatter } from "./frontmatter";

/** Pass-through translator for agents with identical .md conventions. */
const mdToMd: Translator = defineTranslator((trimmed, sourceName) => {
  if (!sourceName) return null;
  return { content: `${trimmed}\n`, targetName: sourceName };
});

/** Convert .md command to Copilot's .prompt.md convention. */
const mdToPromptMd: Translator = defineTranslator((trimmed, sourceName) => {
  if (!sourceName) return null;
  const base = sourceName.endsWith(".prompt.md")
    ? sourceName.slice(0, -".prompt.md".length)
    : sourceName.endsWith(".md")
      ? sourceName.slice(0, -3)
      : sourceName;
  return { content: `${trimmed}\n`, targetName: `${base}.prompt.md` };
});

/** Convert Copilot's .prompt.md back to standard .md convention. */
const promptMdToMd: Translator = defineTranslator((trimmed, sourceName) => {
  if (!sourceName) return null;
  const base = sourceName.endsWith(".prompt.md")
    ? sourceName.slice(0, -".prompt.md".length)
    : sourceName;
  return { content: `${trimmed}\n`, targetName: `${base}.md` };
});

/**
 * Wrap a command as a Codex skill: synthesise SKILL.md frontmatter
 * (`name` from the source basename, `description` from the source
 * frontmatter or first body paragraph) and emit `<basename>/SKILL.md`.
 *
 * Codex has no native slash-command concept but its skills are user-
 * invokable as `/<name>`. The orchestrator detects the `/SKILL.md`
 * suffix and routes the write to `~/.agents/skills/` instead of the
 * legacy `~/.codex/rules/` location.
 */
function fromName(sourceName: string): string {
  if (sourceName.endsWith(".prompt.md")) return sourceName.slice(0, -".prompt.md".length);
  if (sourceName.endsWith(".md")) return sourceName.slice(0, -".md".length);
  return sourceName;
}

const COMPATIBLE_FRONTMATTER_KEYS = ["allowed-tools", "argument-hint", "model"] as const;

const cmdToCodexSkill: Translator = defineTranslator((trimmed, sourceName) => {
  if (!sourceName) return null;
  const base = fromName(sourceName);
  if (!base) return null;

  const { fields, body, hasFrontmatter } = parseFrontmatter(trimmed);
  const sourceBody = hasFrontmatter ? body.trim() : trimmed;

  const description =
    (typeof fields.description === "string" ? fields.description : null) ??
    firstNonEmptyParagraph(sourceBody) ??
    `Migrated command ${base}`;

  const skillFm: Record<string, string | boolean> = { name: base, description };
  for (const key of COMPATIBLE_FRONTMATTER_KEYS) {
    const v = fields[key];
    if (typeof v === "string" || typeof v === "boolean") {
      skillFm[key] = v;
    }
  }

  const skillContent = `${serializeFrontmatter(skillFm)}\n${sourceBody}\n`;
  return {
    content: skillContent,
    targetName: `${base}/SKILL.md`,
    warnings: [
      "wrapped as Codex skill at ~/.agents/skills/ — Codex has no native slash-command surface",
    ],
  };
});

/**
 * All commands translators indexed by direction for registry registration.
 * Each function passes through Markdown content and adjusts the filename
 * convention (*.md vs *.prompt.md) based on the target agent.
 */
export const translateCommand = {
  claudeToCursor: mdToMd,
  cursorToClaude: mdToMd,
  // Codex targets wrap commands as SKILL.md (Codex has no native slash
  // commands; skills are user-invokable as `/<name>`).
  claudeToCodex: cmdToCodexSkill,
  cursorToCodex: cmdToCodexSkill,
  copilotToCodex: cmdToCodexSkill,
  codexToClaude: mdToMd,
  codexToCursor: mdToMd,
  claudeToCopilot: mdToPromptMd,
  cursorToCopilot: mdToPromptMd,
  codexToCopilot: mdToPromptMd,
  copilotToClaude: promptMdToMd,
  copilotToCursor: promptMdToMd,
};
