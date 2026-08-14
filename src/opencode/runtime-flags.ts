export const OPEN_CODE_SKILL_FLAGS = [
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
] as const;

export type OpenCodeSkillFlag = (typeof OPEN_CODE_SKILL_FLAGS)[number];

const TRUE_VALUES = new Set(["true", "yes", "on", "1", "y"]);
const FALSE_VALUES = new Set(["false", "no", "off", "0", "n"]);

/** Match Effect Config.boolean as used by OpenCode v1.18.16 runtime flags. */
export function openCodeBooleanFlag(
  name: OpenCodeSkillFlag,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[name];
  if (value === undefined) return false;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error(
    `${name} must be one of true, yes, on, 1, y, false, no, off, 0, or n (case-sensitive)`,
  );
}
