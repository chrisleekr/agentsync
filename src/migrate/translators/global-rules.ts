/**
 * src/migrate/translators/global-rules.ts
 *
 * Pairwise translators for global rules between agents.
 * All global-rules formats are Markdown — translation is wrapping/unwrapping,
 * not semantic transformation. Cursor is special: its rules are stored as an
 * inline string in settings.json, not a standalone file.
 */

import type { Translator } from "../types";

/** Sentinel target name consumed by the orchestrator to route through applyCursorRules(). */
const CURSOR_RULES_SENTINEL = "__cursor_rules__";

// ── To/from Cursor (inline string in settings.json) ──────────────────────────

const toCursor: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: CURSOR_RULES_SENTINEL };
};

const fromCursor: Translator = (content, sourceName) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const target = sourceName ?? "rules.md";
  return { content: `# Rules (migrated from Cursor)\n\n${trimmed}\n`, targetName: target };
};

// ── Between file-based agents (Claude, Codex, Copilot) ───────────────────────

const claudeToCodex: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: "AGENTS.md" };
};

const codexToClaude: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: "CLAUDE.md" };
};

const claudeToCopilot: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: "instructions.md" };
};

const copilotToClaude: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: "CLAUDE.md" };
};

const cursorToCodex: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return {
    content: `# Rules (migrated from Cursor)\n\n${trimmed}\n`,
    targetName: "AGENTS.md",
  };
};

const codexToCursor: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: CURSOR_RULES_SENTINEL };
};

const cursorToCopilot: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return {
    content: `# Rules (migrated from Cursor)\n\n${trimmed}\n`,
    targetName: "instructions.md",
  };
};

const copilotToCursor: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: CURSOR_RULES_SENTINEL };
};

const codexToCopilot: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: "instructions.md" };
};

const copilotToCodex: Translator = (content) => {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { content: trimmed, targetName: "AGENTS.md" };
};

/**
 * All global-rules translators indexed by direction for registry registration.
 * Each function takes raw Markdown content and returns { content, targetName } or null.
 */
export const translateGlobalRules = {
  claudeToCursor: toCursor,
  cursorToClaude: fromCursor,
  claudeToCodex,
  codexToClaude,
  claudeToCopilot,
  copilotToClaude,
  cursorToCodex,
  codexToCursor,
  cursorToCopilot,
  copilotToCursor,
  codexToCopilot,
  copilotToCodex,
};
