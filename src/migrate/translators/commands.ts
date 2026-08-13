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
import { hasClaudeMultilineShellInterpolation } from "./claude-markdown";
import {
  firstNonEmptyParagraph,
  parseFrontmatter,
  parseStructuredFrontmatter,
  serializeFrontmatter,
} from "./frontmatter";

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
  let withoutExtension = sourceName;
  if (sourceName.endsWith(".prompt.md")) {
    withoutExtension = sourceName.slice(0, -".prompt.md".length);
  } else if (sourceName.endsWith(".md")) {
    withoutExtension = sourceName.slice(0, -".md".length);
  }
  return withoutExtension.replace(/[\\/]+/g, "-");
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

function openCodeCommandAuthorityErrors(content: string): string[] {
  const parsed = parseStructuredFrontmatter(content);
  if (!parsed) return [];
  if ("error" in parsed) {
    return [`OpenCode command frontmatter is invalid YAML: ${parsed.error}`];
  }
  const record = parsed.fields;
  const errors: string[] = [];
  if (Object.hasOwn(record, "agent")) {
    if (typeof record.agent !== "string") {
      errors.push("OpenCode command authority field 'agent' must be a string");
    } else {
      errors.push("OpenCode command authority field 'agent' has no verified target equivalent");
    }
  }
  if (Object.hasOwn(record, "subtask")) {
    if (typeof record.subtask !== "boolean") {
      errors.push("OpenCode command authority field 'subtask' must be a boolean");
    } else {
      errors.push("OpenCode command authority field 'subtask' has no verified target equivalent");
    }
  }
  for (const field of Object.keys(record)) {
    if (OPEN_CODE_UNMAPPED_COMMAND_AUTHORITY.has(field)) {
      errors.push(`OpenCode command authority field '${field}' has no verified target equivalent`);
    }
  }
  return errors;
}

const OPEN_CODE_UNMAPPED_COMMAND_AUTHORITY = new Set([
  "allowed-tools",
  "disallowed-tools",
  "tools",
  "disable-model-invocation",
  "user-invocable",
  "context",
  "background",
  "hooks",
  "paths",
  "shell",
]);

const OPEN_CODE_TARGET_COMMAND_AUTHORITY = new Set([
  ...OPEN_CODE_UNMAPPED_COMMAND_AUTHORITY,
  "agent",
  "subtask",
]);

const OPEN_CODE_SHELL_INTERPOLATION = /!`[^`]+`/;
const OPEN_CODE_SHELL_INTERPOLATIONS = /!`[^`]+`/g;
const OPEN_CODE_FILE_REFERENCE = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/;

type OpenCodeInterpolationPolicy = "compatible" | "reject" | "claude";

function claudeShellMismatch(body: string): boolean {
  if (hasClaudeMultilineShellInterpolation(body)) return true;
  for (const match of body.matchAll(OPEN_CODE_SHELL_INTERPOLATIONS)) {
    if (match.index > 0 && !/\s/.test(body[match.index - 1] ?? "")) return true;
  }
  return false;
}

function toOpenCode(
  base: Translator,
  interpolationPolicy: OpenCodeInterpolationPolicy = "compatible",
): Translator {
  return defineTranslator((trimmed, sourceName) => {
    const translated = base(trimmed, sourceName);
    if (!translated) return null;
    const parsedContent = parseFrontmatter(trimmed);
    const body = parsedContent.hasFrontmatter ? parsedContent.body : trimmed;
    const activeSyntax = OPEN_CODE_SHELL_INTERPOLATION.test(body)
      ? "shell interpolation"
      : OPEN_CODE_FILE_REFERENCE.test(body)
        ? "file-reference interpolation"
        : null;
    if (interpolationPolicy === "reject" && activeSyntax) {
      return {
        ...translated,
        content: "",
        errors: [
          `Command body contains OpenCode ${activeSyntax} with no verified source equivalent`,
        ],
        skipWrite: true,
      };
    }
    if (interpolationPolicy === "claude" && claudeShellMismatch(body)) {
      return {
        ...translated,
        content: "",
        errors: ["Command body contains Claude shell syntax with different OpenCode semantics"],
        skipWrite: true,
      };
    }
    const parsed = parseStructuredFrontmatter(trimmed);
    if (!parsed) return translated;
    if ("error" in parsed) {
      return {
        ...translated,
        content: "",
        errors: [`Command frontmatter is invalid YAML: ${parsed.error}`],
        skipWrite: true,
      };
    }
    const fields = Object.keys(parsed.fields).filter((field) =>
      OPEN_CODE_TARGET_COMMAND_AUTHORITY.has(field),
    );
    if (fields.length === 0) return translated;
    return {
      ...translated,
      content: "",
      errors: fields.map(
        (field) => `Command authority field '${field}' has no verified OpenCode mapping`,
      ),
      skipWrite: true,
    };
  });
}

function fromOpenCode(
  base: Translator,
  interpolationPolicy: Exclude<OpenCodeInterpolationPolicy, "compatible">,
): Translator {
  return defineTranslator((trimmed, sourceName) => {
    const translated = base(trimmed, sourceName);
    if (!translated) return null;
    const parsedContent = parseFrontmatter(trimmed);
    const body = parsedContent.hasFrontmatter ? parsedContent.body : trimmed;
    const errors = openCodeCommandAuthorityErrors(trimmed);
    const activeSyntax = OPEN_CODE_SHELL_INTERPOLATION.test(body)
      ? "shell interpolation"
      : OPEN_CODE_FILE_REFERENCE.test(body)
        ? "file-reference interpolation"
        : null;
    if (interpolationPolicy === "reject" && activeSyntax) {
      errors.push(
        `OpenCode command body contains ${activeSyntax} with no verified target equivalent`,
      );
    }
    if (interpolationPolicy === "claude" && claudeShellMismatch(body)) {
      errors.push("OpenCode command body contains shell syntax with different Claude semantics");
    }
    if (errors.length === 0) return translated;
    return { ...translated, content: "", errors, skipWrite: true };
  });
}

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
  claudeToOpenCode: toOpenCode(mdToMd, "claude"),
  cursorToOpenCode: toOpenCode(mdToMd, "reject"),
  copilotToOpenCode: toOpenCode(promptMdToMd, "reject"),
  openCodeToClaude: fromOpenCode(mdToMd, "claude"),
  openCodeToCursor: fromOpenCode(mdToMd, "reject"),
  openCodeToCodex: fromOpenCode(cmdToCodexSkill, "reject"),
  openCodeToCopilot: fromOpenCode(mdToPromptMd, "reject"),
};
