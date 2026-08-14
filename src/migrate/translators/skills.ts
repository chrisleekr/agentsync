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

import { openCodeSkillContractErrors } from "../../opencode/skill-contract";
import { defineTranslator, type Translator } from "../types";
import { hasClaudeFileImport, hasClaudeSkillShellInterpolation } from "./claude-markdown";
import { parseFrontmatter, parseStructuredFrontmatter } from "./frontmatter";

/**
 * Identity translator for SKILL.md content. Validates that the input has the
 * required `description` field per the Anthropic spec (only `description` is
 * recommended; `name` defaults to the parent directory name). Emits a warning
 * if `description` is missing rather than rejecting — matches Claude's stance.
 */
const passthroughSkill: Translator = defineTranslator((trimmed, sourceName) => {
  if (!sourceName) return null;
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
});

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

const OPEN_CODE_UNMAPPED_SKILL_AUTHORITY = new Set([
  "allowed-tools",
  "disallowed-tools",
  "disable-model-invocation",
  "user-invocable",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
]);

export { openCodeSkillContractErrors } from "../../opencode/skill-contract";

const openCodeSkillTarget: Translator = (content, sourceName) => {
  const translated = passthroughSkill(content, sourceName);
  if (!translated) return null;
  const contractErrors = openCodeSkillContractErrors(content, sourceName ?? "");
  if (contractErrors.length > 0) {
    return { ...translated, content: "", errors: contractErrors, skipWrite: true };
  }
  const parsed = parseStructuredFrontmatter(content.trim());
  if (!parsed || "error" in parsed) return translated;
  const fields = Object.keys(parsed.fields).filter((field) =>
    OPEN_CODE_UNMAPPED_SKILL_AUTHORITY.has(field),
  );
  if (fields.length === 0) return translated;
  return {
    ...translated,
    content: "",
    errors: fields.map(
      (field) => `Skill authority field '${field}' has no verified OpenCode mapping`,
    ),
    skipWrite: true,
  };
};

const claudeToOpenCodeSkill: Translator = (content, sourceName) => {
  const translated = openCodeSkillTarget(content, sourceName);
  if (!translated || translated.skipWrite) return translated;
  const { body } = parseFrontmatter(content.trim());
  if (!hasClaudeSkillShellInterpolation(body)) return translated;
  return {
    ...translated,
    content: "",
    errors: ["Claude skill body contains shell interpolation that OpenCode does not execute"],
    skipWrite: true,
  };
};

function fromOpenCodeSkill(base: Translator, rejectClaudeDynamicContext = false): Translator {
  return (content, sourceName) => {
    const translated = base(content, sourceName);
    if (!translated) return null;
    const parsed = parseStructuredFrontmatter(content.trim());
    if (!parsed) return translated;
    if ("error" in parsed) {
      return {
        ...translated,
        content: "",
        errors: [`OpenCode skill frontmatter is invalid YAML: ${parsed.error}`],
        skipWrite: true,
      };
    }
    const fields = Object.keys(parsed.fields).filter((field) =>
      OPEN_CODE_UNMAPPED_SKILL_AUTHORITY.has(field),
    );
    if (fields.length > 0) {
      return {
        ...translated,
        content: "",
        errors: fields.map(
          (field) => `OpenCode skill authority field '${field}' has no verified target equivalent`,
        ),
        skipWrite: true,
      };
    }
    if (!rejectClaudeDynamicContext) return translated;
    const { body } = parseFrontmatter(content.trim());
    const activeSyntax = hasClaudeSkillShellInterpolation(body)
      ? "shell interpolation"
      : hasClaudeFileImport(body)
        ? "file-reference interpolation"
        : null;
    if (!activeSyntax) return translated;
    return {
      ...translated,
      content: "",
      errors: [
        `OpenCode skill body contains Claude ${activeSyntax} with no verified source equivalent`,
      ],
      skipWrite: true,
    };
  };
}

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
  claudeToOpenCode: claudeToOpenCodeSkill,
  cursorToOpenCode: openCodeSkillTarget,
  codexToOpenCode: openCodeSkillTarget,
  copilotToOpenCode: openCodeSkillTarget,
  openCodeToClaude: fromOpenCodeSkill(passthroughSkill, true),
  openCodeToCursor: fromOpenCodeSkill(passthroughSkill),
  openCodeToCodex: fromOpenCodeSkill(passthroughSkill),
  openCodeToCopilot: fromOpenCodeSkill(copilotSkillBestEffort),
};
