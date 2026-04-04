import { describe, expect, test } from "bun:test";
import { Agents } from "../registry";

// T023 — Agents registry

describe("Agents registry", () => {
  test("contains exactly 5 agents", () => {
    expect(Agents).toHaveLength(5);
  });

  test("contains the expected agent names", () => {
    const names = Agents.map((a) => a.name).sort();
    expect(names).toEqual(["claude", "codex", "copilot", "cursor", "vscode"]);
  });

  test("every agent name is unique", () => {
    const names = Agents.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("each agent exposes a snapshot function", () => {
    for (const agent of Agents) {
      expect(typeof agent.snapshot).toBe("function");
    }
  });

  test("each agent exposes an apply function", () => {
    for (const agent of Agents) {
      expect(typeof agent.apply).toBe("function");
    }
  });
});
