import { describe, expect, test } from "bun:test";
import { translateGlobalRules } from "../../translators/global-rules";

describe("global-rules translators", () => {
  test("empty input returns null", () => {
    expect(translateGlobalRules.claudeToCursor("")).toBeNull();
    expect(translateGlobalRules.claudeToCursor("   ")).toBeNull();
  });

  test("claude → cursor returns sentinel target name", () => {
    const result = translateGlobalRules.claudeToCursor("# My Rules\n\nBe helpful.");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("__cursor_rules__");
    expect(result?.content).toBe("# My Rules\n\nBe helpful.");
  });

  test("cursor → claude wraps content with heading", () => {
    const result = translateGlobalRules.cursorToClaude("Be concise.");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("rules.md");
    expect(result?.content).toContain("migrated from Cursor");
    expect(result?.content).toContain("Be concise.");
  });

  test("claude → codex preserves content, targets AGENTS.md", () => {
    const content = "# Guidelines\n\nFollow these rules.";
    const result = translateGlobalRules.claudeToCodex(content);
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("AGENTS.md");
    expect(result?.content).toBe(content);
  });

  test("codex → claude preserves content, targets CLAUDE.md", () => {
    const content = "# Agent Rules";
    const result = translateGlobalRules.codexToClaude(content);
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("CLAUDE.md");
  });

  test("claude → copilot targets instructions.md", () => {
    const result = translateGlobalRules.claudeToCopilot("rules");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("instructions.md");
  });

  test("copilot → cursor returns sentinel", () => {
    const result = translateGlobalRules.copilotToCursor("instructions");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("__cursor_rules__");
  });

  test("round-trip claude → codex → claude preserves content", () => {
    const original = "# My Rules\n\nBe helpful and concise.";
    const toCodex = translateGlobalRules.claudeToCodex(original);
    const backToClaude = translateGlobalRules.codexToClaude(toCodex?.content as string);
    expect(backToClaude?.content).toBe(original);
  });
});
