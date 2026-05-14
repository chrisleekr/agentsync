/**
 * src/migrate/translators/skills.ts
 *
 * Translators for the Anthropic SKILL.md spec. Claude, Cursor, and Codex all
 * implement the same progressive-disclosure spec verbatim — name + description
 * frontmatter, optional supporting files. Cross-translation is essentially
 * a path remap: SKILL.md content is byte-for-byte portable.
 *
 * Copilot CLI exposes a `~/.copilot/skills/` directory but, as of 2026-05,
 * has no documented loader. We emit copilot targets with a warning so users
 * know files are staged but not guaranteed to invoke at runtime.
 *
 * Supporting files (reference.md, scripts/, assets/) travel as `extraFiles`
 * on the translator return; the orchestrator carries them from source to
 * destination unchanged. Translators themselves are pure — they only see
 * the SKILL.md content string. Sidecars are gathered by the orchestrator
 * and merged with translator-emitted extraFiles before write.
 */

import type { Translator } from "../types";
import { parseFrontmatter } from "./_frontmatter";

/**
 * Identity translator for SKILL.md content. Validates that the input has the
 * required `description` field per the Anthropic spec (only `description` is
 * recommended; `name` defaults to the parent directory name). Emits a warning
 * if `description` is missing rather than rejecting — matches Claude's stance.
 */
const passthroughSkill: Translator = (content, sourceName) => {
  if (!sourceName) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  const { fields, hasFrontmatter } = parseFrontmatter(trimmed);
  const warnings: string[] = [];
  if (!hasFrontmatter) {
    warnings.push("SKILL.md has no frontmatter; downstream agents may not load it correctly.");
  } else if (!fields.description) {
    warnings.push("SKILL.md is missing the recommended `description` field.");
  }
  return {
    content: `${trimmed}\n`,
    targetName: sourceName,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
};

/**
 * Wraps `passthroughSkill` with a one-line warning that Copilot CLI has no
 * documented SKILL.md loader as of 2026-05. Files are written but invocation
 * is best-effort.
 */
const copilotSkillBestEffort: Translator = (content, sourceName) => {
  const result = passthroughSkill(content, sourceName);
  if (!result) return null;
  const baseWarnings = result.warnings ?? [];
  return {
    ...result,
    warnings: [
      ...baseWarnings,
      "Copilot CLI has no documented SKILL.md loader as of 2026-05; staged as best-effort.",
    ],
  };
};

/**
 * Skills translators indexed by direction. Claude/Cursor/Codex use the same
 * Anthropic spec verbatim, so all six in-group directions share `passthroughSkill`.
 * The three copilot-target directions add a warning; copilot-source directions
 * pass through cleanly because what Copilot has on disk already matches the spec.
 */
export const translateSkill = {
  claudeToCursor: passthroughSkill,
  claudeToCodex: passthroughSkill,
  claudeToCopilot: copilotSkillBestEffort,
  cursorToClaude: passthroughSkill,
  cursorToCodex: passthroughSkill,
  cursorToCopilot: copilotSkillBestEffort,
  codexToClaude: passthroughSkill,
  codexToCursor: passthroughSkill,
  codexToCopilot: copilotSkillBestEffort,
  copilotToClaude: passthroughSkill,
  copilotToCursor: passthroughSkill,
  copilotToCodex: passthroughSkill,
};
