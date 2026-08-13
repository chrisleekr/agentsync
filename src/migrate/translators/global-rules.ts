/**
 * src/migrate/translators/global-rules.ts
 *
 * Pairwise translators for global rules between agents.
 * All global-rules formats are Markdown — translation is wrapping/unwrapping,
 * not semantic transformation. Cursor is special: its rules are stored as an
 * inline string in settings.json, not a standalone file.
 */

import { defineTranslator, type Translator } from "../types";
import { hasClaudeFileImport } from "./claude-markdown";

/** Sentinel target name consumed by the orchestrator to route through applyCursorRules(). */
const CURSOR_RULES_SENTINEL = "__cursor_rules__";

// ── To/from Cursor (inline string in settings.json) ──────────────────────────

const toCursor: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: CURSOR_RULES_SENTINEL,
}));

const cursorToClaude: Translator = defineTranslator((trimmed) => ({
  content: `# Rules (migrated from Cursor)\n\n${trimmed}\n`,
  targetName: "CLAUDE.md",
}));

// ── Between file-based agents (Claude, Codex, Copilot) ───────────────────────

const claudeToCodex: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: "AGENTS.md",
}));

const codexToClaude: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: "CLAUDE.md",
}));

const claudeToCopilot: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: "instructions.md",
}));

const copilotToClaude: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: "CLAUDE.md",
}));

const cursorToCodex: Translator = defineTranslator((trimmed) => ({
  content: `# Rules (migrated from Cursor)\n\n${trimmed}\n`,
  targetName: "AGENTS.md",
}));

const codexToCursor: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: CURSOR_RULES_SENTINEL,
}));

const cursorToCopilot: Translator = defineTranslator((trimmed) => ({
  content: `# Rules (migrated from Cursor)\n\n${trimmed}\n`,
  targetName: "instructions.md",
}));

const copilotToCursor: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: CURSOR_RULES_SENTINEL,
}));

const codexToCopilot: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: "instructions.md",
}));

const copilotToCodex: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: "AGENTS.md",
}));

const toOpenCode: Translator = defineTranslator((trimmed) => ({
  content: trimmed,
  targetName: "AGENTS.md",
}));

const claudeToOpenCode: Translator = defineTranslator((trimmed) => {
  if (hasClaudeFileImport(trimmed)) {
    return {
      content: "",
      targetName: "AGENTS.md",
      errors: ["Claude global rules contain a file import that OpenCode does not expand"],
      skipWrite: true,
    };
  }
  return { content: trimmed, targetName: "AGENTS.md" };
});

const openCodeToClaude: Translator = defineTranslator((trimmed) => {
  if (hasClaudeFileImport(trimmed)) {
    return {
      content: "",
      targetName: "CLAUDE.md",
      errors: [
        "OpenCode global rules contain a Claude file-reference import with no verified source equivalent",
      ],
      skipWrite: true,
    };
  }
  return { content: trimmed, targetName: "CLAUDE.md" };
});

/**
 * All global-rules translators indexed by direction for registry registration.
 * Each function takes raw Markdown content and returns { content, targetName } or null.
 */
export const translateGlobalRules = {
  claudeToCursor: toCursor,
  cursorToClaude,
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
  claudeToOpenCode,
  cursorToOpenCode: defineTranslator((trimmed) => ({
    content: `# Rules (migrated from Cursor)\n\n${trimmed}\n`,
    targetName: "AGENTS.md",
  })),
  codexToOpenCode: toOpenCode,
  copilotToOpenCode: toOpenCode,
  openCodeToClaude,
  openCodeToCursor: codexToCursor,
  openCodeToCodex: toOpenCode,
  openCodeToCopilot: codexToCopilot,
};
