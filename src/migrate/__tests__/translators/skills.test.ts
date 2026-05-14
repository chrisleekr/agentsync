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
});
