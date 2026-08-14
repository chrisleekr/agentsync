import { describe, expect, test } from "bun:test";
import { getSupportedPairs, getTranslator } from "../registry";
import { defineTranslator } from "../types";

describe("defineTranslator", () => {
  test("returns null when content is empty or whitespace-only", () => {
    const t = defineTranslator((trimmed, sourceName) => ({
      content: trimmed,
      targetName: sourceName ?? "out",
    }));
    expect(t("", "src.md")).toBeNull();
    expect(t("   \n\t  ", "src.md")).toBeNull();
  });

  test("delegates to inner fn for non-empty content with trimmed input", () => {
    const t = defineTranslator((trimmed, sourceName) => ({
      content: trimmed,
      targetName: sourceName ?? "out",
    }));
    const result = t("  hello  ", "src.md");
    expect(result).toEqual({ content: "hello", targetName: "src.md" });
  });

  test("inner fn receives undefined sourceName when caller omits it", () => {
    let captured: string | undefined = "<unset>";
    const t = defineTranslator((trimmed, sourceName) => {
      captured = sourceName;
      return { content: trimmed, targetName: "x" };
    });
    t("hi");
    expect(captured).toBeUndefined();
  });
});

describe("getTranslator", () => {
  test("returns a function for a registered pair", () => {
    const t = getTranslator("claude", "cursor", "mcp");
    expect(t).toBeFunction();
  });

  test("returns null for an unregistered pair", () => {
    // VS Code ↔ skills isn't registered (VS Code has no SKILL.md surface).
    const t = getTranslator("vscode", "claude", "skills");
    expect(t).toBeNull();
  });

  test("returns a translator for skills (claude → cursor)", () => {
    const t = getTranslator("claude", "cursor", "skills");
    expect(t).toBeFunction();
  });

  test("C1 returns a translator for a physical agents pair", () => {
    expect(getTranslator("claude", "codex", "agents")).toBeFunction();
  });

  test("C1 keeps VS Code as an orchestration alias for the shared agent format", () => {
    expect(getTranslator("claude", "vscode", "agents")).toBeNull();
    expect(getTranslator("claude", "copilot", "agents")).toBeFunction();
  });

  test("keeps Codex commands target-only", () => {
    expect(getTranslator("codex", "opencode", "commands")).toBeNull();
  });
});

describe("getSupportedPairs", () => {
  test("returns all pairs when no type filter is given", () => {
    const pairs = getSupportedPairs();
    expect(pairs.length).toBeGreaterThan(0);
    // Existing 74 pairs plus 41 OpenCode migration pairs.
    expect(pairs.length).toBe(115);
  });

  test("filters by config type", () => {
    const mcpPairs = getSupportedPairs("mcp");
    expect(mcpPairs.length).toBe(30);
    for (const p of mcpPairs) {
      expect(p.type).toBe("mcp");
    }
  });

  test("filters by config type for skills", () => {
    const skillPairs = getSupportedPairs("skills");
    expect(skillPairs.length).toBe(20);
  });

  test("filters by config type for rules", () => {
    const rulePairs = getSupportedPairs("rules");
    expect(rulePairs.length).toBe(6);
  });

  test("exposes 20 directed pairs among five physical migration formats", () => {
    const agentPairs = getSupportedPairs("agents");
    expect(agentPairs).toHaveLength(20);
    expect(new Set(agentPairs.map(({ from, to }) => `${from}→${to}`)).size).toBe(20);
    expect(agentPairs.every(({ from, to }) => from !== to)).toBe(true);
    expect(agentPairs.some(({ from, to }) => from === "claude" && to === "copilot")).toBe(true);
    expect(agentPairs.some(({ from, to }) => from === "copilot" && to === "codex")).toBe(true);
    expect(agentPairs.some(({ from, to }) => from === "vscode" || to === "vscode")).toBe(false);
    expect(agentPairs.some(({ from, to }) => from === "opencode" && to === "claude")).toBe(true);
    expect(agentPairs.some(({ from, to }) => from === "claude" && to === "opencode")).toBe(true);
  });

  test("returns correct from/to for a known pair", () => {
    const grPairs = getSupportedPairs("global-rules");
    const claudeToCursor = grPairs.find((p) => p.from === "claude" && p.to === "cursor");
    expect(claudeToCursor).toBeDefined();
  });
});
