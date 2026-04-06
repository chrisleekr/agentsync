import { describe, expect, test } from "bun:test";
import { getSupportedPairs, getTranslator } from "../registry";

describe("getTranslator", () => {
  test("returns a function for a registered pair", () => {
    const t = getTranslator("claude", "cursor", "mcp");
    expect(t).toBeFunction();
  });

  test("returns null for an unregistered pair", () => {
    const t = getTranslator("vscode", "copilot", "mcp");
    expect(t).toBeNull();
  });

  test("returns null for skills (out of scope)", () => {
    const t = getTranslator("claude", "cursor", "skills" as "mcp");
    expect(t).toBeNull();
  });
});

describe("getSupportedPairs", () => {
  test("returns all pairs when no type filter is given", () => {
    const pairs = getSupportedPairs();
    expect(pairs.length).toBeGreaterThan(0);
    // 12 global-rules + 12 mcp + 12 commands = 36 total
    expect(pairs.length).toBe(36);
  });

  test("filters by config type", () => {
    const mcpPairs = getSupportedPairs("mcp");
    expect(mcpPairs.length).toBe(12);
    for (const p of mcpPairs) {
      expect(p.type).toBe("mcp");
    }
  });

  test("returns correct from/to for a known pair", () => {
    const grPairs = getSupportedPairs("global-rules");
    const claudeToCursor = grPairs.find((p) => p.from === "claude" && p.to === "cursor");
    expect(claudeToCursor).toBeDefined();
  });
});
