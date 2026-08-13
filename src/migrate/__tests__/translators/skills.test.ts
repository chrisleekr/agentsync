import { describe, expect, test } from "bun:test";
import { translateSkill } from "../../translators/skills";

describe("skills translators", () => {
  const validSkill = `---
name: lint
description: Lint the project
---

Run lint over the whole repo.`;

  test("empty content returns null", () => {
    expect(translateSkill.claudeToCursor("", "lint")).toBeNull();
    expect(translateSkill.claudeToCursor("   ", "lint")).toBeNull();
  });

  test("missing sourceName returns null", () => {
    expect(translateSkill.claudeToCursor(validSkill)).toBeNull();
  });

  test("claude → cursor passes SKILL.md content through verbatim", () => {
    const result = translateSkill.claudeToCursor(validSkill, "lint");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("lint");
    expect(result?.content).toContain("name: lint");
    expect(result?.content).toContain("description: Lint the project");
    expect(result?.content).toContain("Run lint over the whole repo.");
    expect(result?.warnings).toBeUndefined();
  });

  test("claude → codex same passthrough", () => {
    const result = translateSkill.claudeToCodex(validSkill, "lint");
    expect(result?.targetName).toBe("lint");
    expect(result?.content.trim()).toBe(validSkill.trim());
  });

  test("cursor → claude passthrough is byte-equal after normalisation", () => {
    const result = translateSkill.cursorToClaude(validSkill, "lint");
    expect(result?.content.trim()).toBe(validSkill.trim());
  });

  test("copilot → claude/cursor/codex passes through (no warning)", () => {
    expect(translateSkill.copilotToClaude(validSkill, "lint")?.warnings).toBeUndefined();
    expect(translateSkill.copilotToCursor(validSkill, "lint")?.warnings).toBeUndefined();
    expect(translateSkill.copilotToCodex(validSkill, "lint")?.warnings).toBeUndefined();
  });

  test("any → copilot adds the best-effort warning", () => {
    const fromClaude = translateSkill.claudeToCopilot(validSkill, "lint");
    expect(fromClaude?.warnings).toBeDefined();
    expect(fromClaude?.warnings?.[0]).toContain("Copilot CLI has no documented SKILL.md loader");

    const fromCursor = translateSkill.cursorToCopilot(validSkill, "lint");
    expect(fromCursor?.warnings?.[0]).toContain("Copilot CLI has no documented SKILL.md loader");

    const fromCodex = translateSkill.codexToCopilot(validSkill, "lint");
    expect(fromCodex?.warnings?.[0]).toContain("Copilot CLI has no documented SKILL.md loader");
  });

  test("missing description frontmatter emits warning", () => {
    const noDesc = `---
name: lint
---

Body.`;
    const result = translateSkill.claudeToCursor(noDesc, "lint");
    expect(result?.warnings?.[0]).toContain("missing the recommended `description`");
  });

  test("no frontmatter at all emits warning", () => {
    const result = translateSkill.claudeToCursor("# Lint\n\nDo it.", "lint");
    expect(result?.warnings?.[0]).toContain("no frontmatter");
  });

  test("OpenCode-target skill routes reject unmapped authority frontmatter", () => {
    const source = `---
name: lint
description: Lint the project
disallowed-tools: [Write]
---

Run lint.`;
    const result = translateSkill.claudeToOpenCode(source, "lint");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("authority field 'disallowed-tools'");
  });

  test.each([
    ["missing frontmatter", "Run lint.", "requires YAML frontmatter"],
    [
      "missing name",
      "---\ndescription: Lint the project\n---\n\nRun lint.",
      "requires a string 'name'",
    ],
    ["missing description", "---\nname: lint\n---\n\nRun lint.", "requires a non-empty string"],
    [
      "mismatched name",
      "---\nname: review\ndescription: Lint\n---\n\nRun lint.",
      "match its directory",
    ],
    ["uppercase name", "---\nname: Lint\ndescription: Lint\n---\n\nRun lint.", "lowercase letters"],
    [
      "double hyphen",
      "---\nname: lint--all\ndescription: Lint\n---\n\nRun lint.",
      "single hyphens",
    ],
    [
      "overlong name",
      `---\nname: ${"a".repeat(65)}\ndescription: Lint\n---\n\nRun lint.`,
      "between 1 and 64",
    ],
  ])("OpenCode target rejects a skill with %s", (_caseName, source, expectedError) => {
    const result = translateSkill.claudeToOpenCode(source, "lint");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain(expectedError);
  });

  test("OpenCode-source skill routes reject inert fields that would grant target authority", () => {
    const source = `---
name: lint
description: Lint the project
allowed-tools: Bash(*)
---

Run lint.`;
    const result = translateSkill.openCodeToClaude(source, "lint");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("authority field 'allowed-tools'");
  });

  test.each([
    ["inline shell", "Summarize !`git diff`.", "shell interpolation"],
    ["shell block", "```!\ngit status\ngit diff\n```", "shell interpolation"],
    ["indented shell block", "    ```!\ngit status\n    ```", "shell interpolation"],
    ["text-prefixed shell block", "Prefix ```!\ngit status\n``` suffix", "shell interpolation"],
    ["shell inside an ordinary fence", "```text\n!`git status`\n```", "shell interpolation"],
    ["file reference", "Review @src/auth.ts.", "file-reference interpolation"],
    [
      "parent-relative file reference",
      "Review @../../../.ssh/id_rsa.",
      "file-reference interpolation",
    ],
  ])("OpenCode → Claude rejects inert %s", (_name, body, expectedError) => {
    const source = `---
name: lint
description: Lint the project
---

${body}`;
    const result = translateSkill.openCodeToClaude(source, "lint");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain(expectedError);
  });

  test("OpenCode → non-Claude preserves inert dynamic-content text", () => {
    const source = `---
name: lint
description: Lint the project
---

Review @src/auth.ts, then show !\`git diff\`.`;
    expect(translateSkill.openCodeToCursor(source, "lint")?.content.trim()).toBe(source);
  });

  test("OpenCode → Claude preserves shell-like text after a non-whitespace character", () => {
    const source =
      "---\nname: lint\ndescription: Lint the project\n---\n\nSet KEY=!" + "`command` literally.";
    expect(translateSkill.openCodeToClaude(source, "lint")?.content.trim()).toBe(source);
  });

  test.each([
    ["inline", "Run !`git diff` before reviewing."],
    ["fenced", "```!\ngit status\n```"],
    ["indented fenced", "    ```!\ngit status\n    ```"],
    ["text-prefixed fenced", "Prefix ```!\ngit status\n``` suffix"],
    ["ordinary fenced", "```text\n!`git status`\n```"],
  ])("Claude → OpenCode rejects active %s shell interpolation", (_caseName, body) => {
    const source = `---
name: lint
description: Lint the project
---

${body}`;
    const result = translateSkill.claudeToOpenCode(source, "lint");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("does not execute");
  });

  test("Claude shell syntax inside inline code remains literal", () => {
    const body = "Mention ``!`command`` literally.";
    const source = `---
name: lint
description: Lint the project
---

${body}`;
    expect(translateSkill.claudeToOpenCode(source, "lint")?.content.trim()).toBe(source);
    expect(translateSkill.openCodeToClaude(source, "lint")?.content.trim()).toBe(source);
  });
});
