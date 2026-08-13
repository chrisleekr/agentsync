/**
 * Internal to `src/migrate/translators`.
 *
 * Minimal YAML frontmatter parser/serializer shared by skills, rules,
 * and commands-to-skills translators. Handles the small subset of YAML
 * that AI agents use in their config frontmatter:
 *   - Top-level scalar key/value pairs
 *   - Quoted and unquoted string values
 *   - Boolean values true/false
 *   - Comma-separated lists, kept as raw string
 *
 * Not a full YAML parser by design — pulling in `js-yaml` for what these
 * configs actually use would be overkill and adds a dependency. If the
 * frontmatter has nested structures, we fall back to preserving the
 * raw block as-is.
 *
 * Used by: commands.ts, rules.ts, skills.ts.
 * Not used by: global-rules.ts, mcp.ts.
 */

export interface Frontmatter {
  /** Parsed key/value pairs (scalar values only). */
  fields: Record<string, string | boolean>;
  /** Body content after the frontmatter block (or the entire input if no frontmatter). */
  body: string;
  /** True if the input started with `---` and a closing `---` was found. */
  hasFrontmatter: boolean;
}

export type StructuredFrontmatter =
  | { fields: Record<string, unknown> }
  | { error: string; code: "malformed" | "not-a-mapping" }
  | null;

const FRONTMATTER_OPEN = /^---\s*\r?\n/;

/**
 * Parse YAML frontmatter from a markdown document.
 * Returns the body unchanged when no frontmatter is present.
 */
export function parseFrontmatter(input: string): Frontmatter {
  if (!FRONTMATTER_OPEN.test(input)) {
    return { fields: {}, body: input, hasFrontmatter: false };
  }
  const afterOpen = input.replace(FRONTMATTER_OPEN, "");
  // Match `\n---` only when followed by newline or end-of-string. Without this
  // guard, `\n----` or `\n---trailing` would parse as a closing marker and the
  // body would start with bogus dashes.
  const closeRe = /\r?\n---(?:\r?\n|$)/;
  const closeMatch = afterOpen.match(closeRe);
  if (!closeMatch || closeMatch.index === undefined) {
    return { fields: {}, body: input, hasFrontmatter: false };
  }
  const closeIdx = closeMatch.index;
  const fmBlock = afterOpen.slice(0, closeIdx);
  const body = afterOpen.slice(closeIdx + closeMatch[0].length);

  const fields: Record<string, string | boolean> = {};
  for (const rawLine of fmBlock.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (valueRaw === "true") {
      fields[key] = true;
    } else if (valueRaw === "false") {
      fields[key] = false;
    } else {
      // Strip surrounding quotes if present (single or double).
      const needsUnquoting =
        valueRaw.length >= 2 &&
        ((valueRaw.startsWith('"') && valueRaw.endsWith('"')) ||
          (valueRaw.startsWith("'") && valueRaw.endsWith("'")));
      fields[key] = needsUnquoting ? valueRaw.slice(1, -1) : valueRaw;
    }
  }

  return { fields, body, hasFrontmatter: true };
}

/** Parse complete YAML frontmatter when authority fields must be type-aware. */
export function parseStructuredFrontmatter(input: string): StructuredFrontmatter {
  if (!FRONTMATTER_OPEN.test(input)) return null;
  const match = input.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { error: "opening or closing marker is missing", code: "malformed" };
  try {
    const fields = Bun.YAML.parse(match[1] ?? "");
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return { error: "expected a mapping", code: "not-a-mapping" };
    }
    return { fields: fields as Record<string, unknown> };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      code: "malformed",
    };
  }
}

/**
 * Serialize a fields map into a YAML frontmatter block.
 * String values containing reserved characters (`:`, `#`, leading/trailing
 * whitespace) are double-quoted. Empty input yields no frontmatter at all.
 */
export function serializeFrontmatter(fields: Record<string, string | boolean>): string {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "";
  const lines = entries.map(([k, v]) => {
    if (typeof v === "boolean") return `${k}: ${v}`;
    const needsQuoting = /[:#]|^\s|\s$/.test(v) || v === "";
    return `${k}: ${needsQuoting ? JSON.stringify(v) : v}`;
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

/**
 * Extract the first non-empty paragraph of body text. Used to synthesise
 * a skill description when the source command has no `description:` field.
 * Returns null if the body has no usable paragraph.
 */
export function firstNonEmptyParagraph(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const firstParagraph = trimmed.split(/\n\s*\n/)[0]?.trim();
  if (!firstParagraph) return null;
  // Drop leading markdown heading markers (#, ##) but keep the title text.
  return firstParagraph.replace(/^#+\s*/, "").trim() || null;
}
