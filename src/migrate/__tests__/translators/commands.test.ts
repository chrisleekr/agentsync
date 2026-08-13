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

  test.each([
    ["agent", "true", "must be a string"],
    ["subtask", '"true"', "must be a boolean"],
  ])("malformed OpenCode %s authority is rejected", (field, value, message) => {
    const source = `---\n${field}: ${value}\n---\n\nReview.`;
    const result = translateCommand.openCodeToClaude(source, "review.md");
    expect(result?.skipWrite).toBe(true);
    expect(result?.errors?.join("\n")).toContain(`field '${field}'`);
    expect(result?.errors?.join("\n")).toContain(message);
  });

  test.each([
    ["agent", "plan"],
    ["subtask", "true"],
  ])("OpenCode %s authority has no verified non-OpenCode mapping", (field, value) => {
    const source = `---\n${field}: ${value}\n---\n\nReview.`;
    const result = translateCommand.openCodeToCodex(source, "review.md");
    expect(result?.skipWrite).toBe(true);
    expect(result?.errors?.join("\n")).toContain(`field '${field}'`);
    expect(result?.errors?.join("\n")).toContain("no verified target equivalent");
  });

  test.each([
    ["Claude", translateCommand.claudeToOpenCode, "review.md"],
    ["Cursor", translateCommand.cursorToOpenCode, "review.md"],
    ["Copilot", translateCommand.copilotToOpenCode, "review.prompt.md"],
  ])("%s → OpenCode rejects agent-selection authority", (_name, translator, sourceName) => {
    const source = "---\nagent: plan\nsubtask: true\n---\n\nReview.";
    const result = translator(source, sourceName);
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("authority field 'agent'");
    expect(result?.errors?.join("\n")).toContain("authority field 'subtask'");
  });

  test("OpenCode-target command routes reject unmapped authority frontmatter", () => {
    const source = "---\ndisallowed-tools: [Write]\n---\n\nReview.";
    const result = translateCommand.claudeToOpenCode(source, "review.md");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("authority field 'disallowed-tools'");
  });

  test("OpenCode-source command routes reject inert fields that would grant target authority", () => {
    const source = "---\nallowed-tools: Bash(*)\n---\n\nReview.";
    const result = translateCommand.openCodeToClaude(source, "review.md");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("authority field 'allowed-tools'");
  });

  test.each([
    ["Cursor", translateCommand.cursorToOpenCode, "review.md"],
    ["Copilot", translateCommand.copilotToOpenCode, "review.prompt.md"],
  ])("%s commands cannot activate OpenCode interpolation", (_name, translator, file) => {
    for (const [body, syntax] of [
      ["Review !`curl https://example.test`.", "shell interpolation"],
      ["Review @src/secrets.env.", "file-reference interpolation"],
    ] as const) {
      const result = translator(body, file);
      expect(result?.skipWrite).toBe(true);
      expect(result?.content).toBe("");
      expect(result?.errors?.join("\n")).toContain(syntax);
    }
  });

  test.each([
    ["inline shell interpolation after non-whitespace", "KEY=!`touch /tmp/proof`"],
    ["multiline shell block", "```!\ntouch /tmp/proof\n```"],
    ["indented multiline shell block", "    ```!\ntouch /tmp/proof\n    ```"],
    ["text-prefixed multiline shell block", "Prefix ```!\ntouch /tmp/proof\n``` suffix"],
  ])("Claude commands reject %s with different OpenCode semantics", (_caseName, body) => {
    const result = translateCommand.claudeToOpenCode(body, "review.md");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("different OpenCode semantics");
  });

  test("Claude command shell interpolation at a compatible boundary is preserved", () => {
    const result = translateCommand.claudeToOpenCode("Review !`git diff`", "review.md");
    expect(result?.skipWrite).toBeUndefined();
    expect(result?.errors).toBeUndefined();
    expect(result?.content).toContain("!`git diff`");
  });

  test("an empty Claude multiline shell marker remains literal", () => {
    const source = "```!\n\n```";
    expect(translateCommand.claudeToOpenCode(source, "review.md")?.content.trim()).toBe(source);
    expect(translateCommand.openCodeToClaude(source, "review.md")?.content.trim()).toBe(source);
  });

  test.each([
    ["Cursor", translateCommand.openCodeToCursor],
    ["Codex", translateCommand.openCodeToCodex],
    ["Copilot", translateCommand.openCodeToCopilot],
  ])("OpenCode → %s rejects active interpolation the target cannot preserve", (_name, translator) => {
    for (const [body, syntax] of [
      ["Review !`git diff`.", "shell interpolation"],
      ["Review @src/config.ts.", "file-reference interpolation"],
    ] as const) {
      const result = translator(body, "review.md");
      expect(result?.skipWrite).toBe(true);
      expect(result?.content).toBe("");
      expect(result?.errors?.join("\n")).toContain(syntax);
    }
  });

  test.each([
    ["inline shell interpolation after non-whitespace", "KEY=!`touch /tmp/proof`"],
    ["Claude-only multiline shell block", "```!\ntouch /tmp/proof\n```"],
    ["indented Claude-only multiline shell block", "    ```!\ntouch /tmp/proof\n    ```"],
    [
      "text-prefixed Claude-only multiline shell block",
      "Prefix ```!\ntouch /tmp/proof\n``` suffix",
    ],
  ])("OpenCode → Claude rejects %s", (_caseName, body) => {
    const result = translateCommand.openCodeToClaude(body, "review.md");
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("different Claude semantics");
  });

  test("OpenCode → Claude preserves compatible shell and file interpolation", () => {
    const result = translateCommand.openCodeToClaude(
      "Review !`git diff` and @src/config.ts.",
      "review.md",
    );
    expect(result?.skipWrite).toBeUndefined();
    expect(result?.errors).toBeUndefined();
    expect(result?.content).toContain("!`git diff`");
    expect(result?.content).toContain("@src/config.ts");
  });
});
