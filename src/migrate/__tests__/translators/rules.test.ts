import { describe, expect, test } from "bun:test";
import { translateRule } from "../../translators/rules";

describe("rules translators", () => {
  test("empty body returns null", () => {
    expect(translateRule.claudeToCodex("", "foo.md")).toBeNull();
    expect(translateRule.claudeToCodex("   \n  ", "foo.md")).toBeNull();
  });

  test("missing sourceName returns null", () => {
    expect(translateRule.claudeToCodex("body", undefined)).toBeNull();
  });

  test("claude → codex: byte-equal markdown body, .md filename", () => {
    const body = "# Mermaid\n\nUse classDef with high-contrast hex pairs.";
    const result = translateRule.claudeToCodex(body, "mermaid.md");
    expect(result?.targetName).toBe("mermaid.md");
    expect(result?.content.trim()).toBe(body.trim());
    expect(result?.warnings).toBeUndefined();
  });

  test("codex → claude: same passthrough as the reverse", () => {
    const body = "Plain rule body.";
    const result = translateRule.codexToClaude(body, "lint.md");
    expect(result?.targetName).toBe("lint.md");
    expect(result?.content.trim()).toBe(body);
  });

  test("cursor → claude: strips .mdc frontmatter, rewrites filename to .md", () => {
    const mdc = `---
description: Standards for components
globs: src/**/*.tsx
alwaysApply: false
---

Use functional components.`;
    const result = translateRule.cursorToClaude(mdc, "components.mdc");
    expect(result?.targetName).toBe("components.md");
    expect(result?.content).not.toContain("---");
    expect(result?.content).not.toContain("globs:");
    expect(result?.content.trim()).toBe("Use functional components.");
    expect(result?.warnings?.[0]).toContain("description, globs, alwaysApply");
  });

  test("cursor → codex: same .mdc handling", () => {
    const mdc = `---
description: x
globs: "**/*.ts"
---

body`;
    const result = translateRule.cursorToCodex(mdc, "x.mdc");
    expect(result?.targetName).toBe("x.md");
    expect(result?.warnings?.[0]).toContain("description, globs");
  });

  test("cursor input without frontmatter passes through unchanged, no warning", () => {
    const body = "Just a plain markdown rule.";
    const result = translateRule.cursorToClaude(body, "plain.md");
    expect(result?.targetName).toBe("plain.md");
    expect(result?.content.trim()).toBe(body);
    expect(result?.warnings).toBeUndefined();
  });

  test("claude → cursor: writes plain .md to ~/.cursor/rules/, no frontmatter added", () => {
    const body = "Mermaid rules go here.";
    const result = translateRule.claudeToCursor(body, "mermaid.md");
    expect(result?.targetName).toBe("mermaid.md");
    expect(result?.content).not.toContain("---");
    expect(result?.content.trim()).toBe(body);
  });

  test("codex → cursor: same plain-md target", () => {
    const body = "Body.";
    const result = translateRule.codexToCursor(body, "x.md");
    expect(result?.targetName).toBe("x.md");
    expect(result?.content.trim()).toBe(body);
  });
});
