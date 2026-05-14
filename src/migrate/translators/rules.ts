/**
 * src/migrate/translators/rules.ts
 *
 * Rules-folder translators for the global rules dirs:
 *   - Claude  ~/.claude/rules/*.md
 *   - Cursor  ~/.cursor/rules/*.{md,mdc}   (Cursor's `.mdc` carries
 *               `description`/`globs`/`alwaysApply` frontmatter)
 *   - Codex   ~/.codex/rules/*.md
 *
 * Translation is body-passthrough. Cursor `.mdc` frontmatter is stripped on
 * egress to claude/codex with a warning naming the dropped fields, and the
 * filename is rewritten `.mdc` → `.md`. The reverse direction (claude/codex
 * → cursor) writes plain `.md` (no frontmatter synthesis — claude/codex have
 * no `globs`/`alwaysApply` to translate).
 *
 * Copilot CLI and VS Code rules live workspace-relative under
 * `.github/instructions/` — out of scope for this global-artefact migration.
 */

import { defineTranslator, type Translator } from "../types";
import { parseFrontmatter } from "./frontmatter";

const STRIPPED_MDC_FIELDS = ["description", "globs", "alwaysApply"] as const;

/** Rewrite `.mdc` filename to `.md`. Other extensions pass through unchanged. */
function rewriteToMd(name: string): string {
  return name.endsWith(".mdc") ? `${name.slice(0, -".mdc".length)}.md` : name;
}

/**
 * Cursor rules → Claude/Codex: strip `.mdc` frontmatter (description/globs/
 * alwaysApply have no equivalent in plain markdown rules), rewrite filename
 * to `.md`. Body byte-passthrough.
 */
const cursorToPlainMd: Translator = defineTranslator((trimmed, sourceName) => {
  if (!sourceName) return null;
  const { fields, body, hasFrontmatter } = parseFrontmatter(trimmed);
  const targetBody = (hasFrontmatter ? body : trimmed).trim();
  if (!targetBody) return null;

  const dropped = STRIPPED_MDC_FIELDS.filter((f) => f in fields);
  const warnings =
    dropped.length > 0
      ? [`Dropped Cursor .mdc fields with no plain-md equivalent: ${dropped.join(", ")}.`]
      : [];

  return {
    content: `${targetBody}\n`,
    targetName: rewriteToMd(sourceName),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
});

/**
 * Claude/Codex rules → Cursor: body-passthrough as plain `.md`. We don't
 * synthesise `globs`/`alwaysApply` frontmatter because the source has no
 * scoping information. Cursor will load these files as always-apply rules.
 */
const plainMdToCursor: Translator = defineTranslator((trimmed, sourceName) => {
  if (!sourceName) return null;
  // If the source happens to have a `.mdc` extension (unlikely for
  // claude/codex but defensive), normalise to `.md` since target reads both.
  return { content: `${trimmed}\n`, targetName: rewriteToMd(sourceName) };
});

/** Plain markdown passthrough (claude ↔ codex). */
const plainMdPassthrough: Translator = defineTranslator((trimmed, sourceName) => {
  if (!sourceName) return null;
  return { content: `${trimmed}\n`, targetName: rewriteToMd(sourceName) };
});

/**
 * Rules translators indexed by direction. Six entries: claude↔cursor,
 * claude↔codex, cursor↔codex.
 */
export const translateRule = {
  claudeToCursor: plainMdToCursor,
  claudeToCodex: plainMdPassthrough,
  cursorToClaude: cursorToPlainMd,
  cursorToCodex: cursorToPlainMd,
  codexToClaude: plainMdPassthrough,
  codexToCursor: plainMdToCursor,
};
