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

  test("copilot → codex strips .prompt.md suffix", () => {
    const result = translateCommand.copilotToCodex("# Lint", "lint.prompt.md");
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("lint.md");
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
