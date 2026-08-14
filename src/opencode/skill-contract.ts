const OPEN_CODE_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type SkillFrontmatter =
  | { fields: Record<string, unknown> }
  | { error: string; code: "malformed" | "not-a-mapping" }
  | null;

function parseSkillFrontmatter(input: string): SkillFrontmatter {
  if (!/^---\s*\r?\n/.test(input)) return null;
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

function characterCount(value: string): number {
  return Array.from(value).length;
}

/** Validate the OpenCode v1.18.16 native skill metadata contract. */
export function openCodeSkillContractErrors(content: string, directoryName: string): string[] {
  const parsed = parseSkillFrontmatter(content.trim());
  if (!parsed) return ["OpenCode skill requires YAML frontmatter"];
  if ("error" in parsed) {
    return parsed.code === "not-a-mapping"
      ? ["OpenCode skill frontmatter must be a mapping"]
      : [`OpenCode skill has invalid YAML frontmatter: ${parsed.error}`];
  }

  const errors: string[] = [];
  const name = parsed.fields.name;
  if (typeof name !== "string" || characterCount(name) < 1 || characterCount(name) > 64) {
    errors.push("OpenCode skill requires a string 'name' between 1 and 64 characters");
  } else {
    if (!OPEN_CODE_SKILL_NAME.test(name)) {
      errors.push(
        "OpenCode skill 'name' must contain lowercase letters or numbers separated by single hyphens",
      );
    }
    if (name !== directoryName) {
      errors.push(`OpenCode skill must declare name '${directoryName}' to match its directory`);
    }
  }

  const description = parsed.fields.description;
  if (
    typeof description !== "string" ||
    description.trim().length === 0 ||
    characterCount(description) > 1024
  ) {
    errors.push(
      "OpenCode skill requires a non-empty string 'description' of at most 1024 characters",
    );
  }
  return errors;
}
