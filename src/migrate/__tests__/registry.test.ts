import { describe, expect, test } from "bun:test";
import { getSupportedPairs, getTranslator } from "../registry";

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
});

describe("getSupportedPairs", () => {
  test("returns all pairs when no type filter is given", () => {
    const pairs = getSupportedPairs();
    expect(pairs.length).toBeGreaterThan(0);
    // 12 global-rules + 20 mcp + 12 commands + 12 skills + 6 rules = 62 total
    expect(pairs.length).toBe(62);
  });

  test("filters by config type", () => {
    const mcpPairs = getSupportedPairs("mcp");
    expect(mcpPairs.length).toBe(20);
    for (const p of mcpPairs) {
      expect(p.type).toBe("mcp");
    }
  });

  test("filters by config type for skills", () => {
    const skillPairs = getSupportedPairs("skills");
    expect(skillPairs.length).toBe(12);
  });

  test("filters by config type for rules", () => {
    const rulePairs = getSupportedPairs("rules");
    expect(rulePairs.length).toBe(6);
  });

  test("returns correct from/to for a known pair", () => {
    const grPairs = getSupportedPairs("global-rules");
    const claudeToCursor = grPairs.find((p) => p.from === "claude" && p.to === "cursor");
    expect(claudeToCursor).toBeDefined();
  });
});
