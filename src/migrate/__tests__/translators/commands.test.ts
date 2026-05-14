import { describe, expect, test } from "bun:test";
import { translateCommand } from "../../translators/commands";

describe("commands translators", () => {
  test("empty content returns null", () => {
    expect(translateCommand.claudeToCursor("", "review.md")).toBeNull();
    expect(translateCommand.claudeToCursor("  ", "review.md")).toBeNull();
  });

  test("missing sourceName returns null", () => {
    expect(translateCommand.claudeToCursor("content")).toBeNull();
  });

  test("claude → cursor passes filename through", () => {
    const result = translateCommand.claudeToCursor("# Review\nCheck code.", "review.md");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("review.md");
    expect(result?.content).toBe("# Review\nCheck code.\n");
  });

  test("claude → copilot adds .prompt.md suffix", () => {
    const result = translateCommand.claudeToCopilot("# Review", "review.md");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("review.prompt.md");
  });

  test("copilot → claude strips .prompt.md suffix", () => {
    const result = translateCommand.copilotToClaude("# Review", "review.prompt.md");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("review.md");
  });

  test("codex → copilot adds .prompt.md suffix", () => {
    const result = translateCommand.codexToCopilot("# Lint", "lint.md");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("lint.prompt.md");
  });

  test("copilot → codex wraps as SKILL.md", () => {
    const result = translateCommand.copilotToCodex("# Lint\n\nDo lint things.", "lint.prompt.md");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("lint/SKILL.md");
    expect(result?.content).toContain("name: lint");
    expect(result?.content).toContain("description:");
    expect(result?.warnings?.[0]).toContain("wrapped as Codex skill");
  });

  test("claude → codex wraps as SKILL.md and preserves source description", () => {
    const src = "---\ndescription: Lint the project\nmodel: sonnet\n---\n\nRun lint.";
    const result = translateCommand.claudeToCodex(src, "lint.md");
    expect(result?.targetName).toBe("lint/SKILL.md");
    expect(result?.content).toMatch(/name: lint/);
    expect(result?.content).toMatch(/description: Lint the project/);
    // Compatible frontmatter passes through.
    expect(result?.content).toMatch(/model: sonnet/);
    // Body preserved.
    expect(result?.content).toContain("Run lint.");
  });

  test("cursor → codex synthesises description from first paragraph when missing", () => {
    const src = "# Lint\n\nLint the codebase before commit.";
    const result = translateCommand.cursorToCodex(src, "lint.md");
    expect(result?.targetName).toBe("lint/SKILL.md");
    expect(result?.content).toMatch(/description: Lint/);
  });

  test("round-trip claude → copilot → claude preserves filename", () => {
    const toCopilot = translateCommand.claudeToCopilot("content", "review.md");
    const backToClaude = translateCommand.copilotToClaude(
      toCopilot?.content as string,
      toCopilot?.targetName as string,
    );
    expect(backToClaude?.targetName).toBe("review.md");
  });
});
