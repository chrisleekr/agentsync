import { describe, expect, test } from "bun:test";
import * as TOML from "@iarna/toml";
import { inspectAgentSource, translateAgent } from "../../translators/agents";

function frontmatterOf(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return Bun.YAML.parse(match?.[1] ?? "") as Record<string, unknown>;
}

function sharedSource(tools: string): string {
  return `---\nname: reviewer\ndescription: Reviews\ntools: ${tools}\n---\n\nReview.`;
}

test("shared logical identity follows the filename rather than the optional display name", () => {
  const source = `---
name: Security Reviewer
description: Reviews security changes
---

Review security changes.`;

  expect(inspectAgentSource("copilot", source, "security.agent.md")).toEqual({
    identity: "security",
    errors: [],
  });

  const claude = translateAgent.copilotToClaude(source, "security.agent.md");
  const cursor = translateAgent.copilotToCursor(source, "security.agent.md");
  const codex = translateAgent.copilotToCodex(source, "security.agent.md");
  expect(claude?.targetName).toBe("security.md");
  expect(frontmatterOf(claude?.content ?? "").name).toBe("security");
  expect(cursor?.targetName).toBe("security.md");
  expect(frontmatterOf(cursor?.content ?? "").name).toBe("security");
  expect(codex?.targetName).toBe("security.toml");
  expect(TOML.parse(codex?.content ?? "").name).toBe("security");
  expect((claude?.warnings ?? []).join("\n")).toContain("name");
});

test("shared output accepts 30,000 Unicode characters", () => {
  const prompt = "🔒".repeat(30_000);
  const source = `---
name: security-reviewer
description: Reviews security changes
---

${prompt}`;

  const result = translateAgent.claudeToCopilot(source, "security.md");

  expect(result?.targetName).toBe("security-reviewer.agent.md");
  expect(result?.skipWrite).not.toBe(true);
});

describe("source-aware tool groups", () => {
  test.each([
    ["Bash", "execute"],
    ["Write", "edit"],
    ["Grep", "search"],
    ["WebFetch", "web"],
  ])("rejects incomplete Claude group %s", (tool, group) => {
    const result = translateAgent.claudeToCopilot(
      `---\nname: reviewer\ndescription: Reviews\ntools: [${tool}]\n---\n\nReview.`,
      "reviewer.md",
    );
    expect((result?.errors ?? []).join("\n")).toContain(`'${group}' is incomplete`);
  });

  test("accepts complete Claude groups and singleton Agent or legacy Task", () => {
    for (const tools of [
      "[Bash, PowerShell]",
      "[Read]",
      "[Edit, Write, NotebookEdit]",
      "[Grep, Glob]",
      "[WebSearch, WebFetch]",
      "[Agent]",
      "[Task]",
      "[TodoWrite]",
    ]) {
      expect(
        translateAgent.claudeToCopilot(sharedSource(tools), "reviewer.md")?.errors,
      ).toBeUndefined();
    }
  });

  test.each([
    ["read", ["Read"]],
    ["NotebookRead", ["Read"]],
    ["SHELL", ["Bash", "PowerShell"]],
    ["MultiEdit", ["Edit", "Write", "NotebookEdit"]],
    ["custom-agent", ["Agent"]],
    ["webfetch", ["WebSearch", "WebFetch"]],
  ])("expands shared alias %s to the complete Claude group", (alias, expected) => {
    const result = translateAgent.copilotToClaude(sharedSource(`[${alias}]`), "reviewer.agent.md");
    expect(frontmatterOf(result?.content ?? "").tools).toEqual(expected);
  });

  test("preserves wildcard and empty semantics and rejects unsupported Claude spelling", () => {
    const wildcard = translateAgent.copilotToClaude(sharedSource("['*']"), "reviewer.agent.md");
    expect(frontmatterOf(wildcard?.content ?? "").tools).toBeUndefined();
    const empty = translateAgent.copilotToClaude(sharedSource("[]"), "reviewer.agent.md");
    expect(frontmatterOf(empty?.content ?? "").tools).toEqual([]);
    for (const tool of ["read", "shell", "MultiEdit", "NotebookRead", "*"]) {
      const result = translateAgent.claudeToCopilot(
        sharedSource(tool === "*" ? '["*"]' : `[${tool}]`),
        "reviewer.md",
      );
      expect((result?.errors ?? []).join("\n")).toContain(tool);
    }
  });
});

test("shared invocation and subagent controls fail closed or warn by name", () => {
  for (const field of [
    "disable-model-invocation: true",
    "user-invocable: false",
    "infer: false",
    "agents: [reviewer]",
  ]) {
    const result = translateAgent.copilotToCodex(
      `---\ndescription: Reviews\n${field}\n---\n\nReview.`,
      "reviewer.agent.md",
    );
    expect((result?.errors ?? []).join("\n")).toMatch(
      /disable-model-invocation|user-invocable|infer|agents/,
    );
  }
  for (const field of ["disable-model-invocation: disabled", "user-invocable: yes", "infer: 1"]) {
    const result = translateAgent.copilotToClaude(
      `---\ndescription: Reviews\n${field}\n---\n\nReview.`,
      "reviewer.agent.md",
    );
    expect((result?.errors ?? []).join("\n")).toContain("must be a boolean");
  }
  for (const field of ["disable-model-invocation: false", "user-invocable: true", "infer: true"]) {
    const result = translateAgent.copilotToClaude(
      `---\ndescription: Reviews\n${field}\n---\n\nReview.`,
      "reviewer.agent.md",
    );
    expect(result?.errors).toBeUndefined();
    expect((result?.warnings ?? []).join("\n")).toContain(field.split(":")[0] ?? "");
  }
});

test("shared optional display name remains a validated string field", () => {
  for (const name of ["", "42"]) {
    const result = translateAgent.copilotToClaude(
      `---\nname: ${name}\ndescription: Reviews\n---\n\nReview.`,
      "reviewer.agent.md",
    );
    expect((result?.errors ?? []).join("\n")).toContain("non-empty string");
  }
});

test("Codex inherited sandbox fails closed except for conservative Cursor translation", () => {
  const codex = 'name = "reviewer"\ndescription = "Reviews"\ndeveloper_instructions = "Review."';
  expect((translateAgent.codexToClaude(codex, "reviewer.toml")?.errors ?? []).join("\n")).toContain(
    "sandbox_mode",
  );
  expect(
    (translateAgent.codexToCopilot(codex, "reviewer.toml")?.errors ?? []).join("\n"),
  ).toContain("sandbox_mode");
  expect(
    frontmatterOf(translateAgent.codexToCursor(codex, "reviewer.toml")?.content ?? "").readonly,
  ).toBe(true);
});

test.each([
  "CON",
  "com1",
  "LPT³",
  "bad:name",
  "trailing.",
  "trailing ",
])("rejects non-portable target identity %s without imposing a length limit", (name) => {
  const source = `name = ${JSON.stringify(name)}\ndescription = "Reviews"\ndeveloper_instructions = "Review."`;
  const result = translateAgent.codexToCopilot(source, "reviewer.toml");
  expect((result?.errors ?? []).join("\n")).toMatch(/Windows-reserved/);
});
