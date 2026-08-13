import { describe, expect, test } from "bun:test";
import * as TOML from "@iarna/toml";
import { inspectAgentSource, translateAgent } from "../../translators/agents";

type Translation = NonNullable<ReturnType<(typeof translateAgent)[keyof typeof translateAgent]>>;

function frontmatterOf(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  expect(match).not.toBeNull();
  return Bun.YAML.parse(match?.[1] ?? "") as Record<string, unknown>;
}

function bodyOf(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

function expectRejected(result: Translation | null, field: string): void {
  expect(result).not.toBeNull();
  expect(result?.skipWrite).toBe(true);
  expect((result?.errors ?? []).join("\n")).toContain(field);
}

const CLAUDE_AGENT = `---
name: security-reviewer
description: Reviews security-sensitive changes
---

Review authentication and authorization changes.`;

const CURSOR_AGENT = `---
description: Reviews security-sensitive changes
---

Review authentication and authorization changes.`;

const CURSOR_READONLY_AGENT = `---
description: Reviews security-sensitive changes
readonly: true
---

Review authentication and authorization changes.`;

const CODEX_AGENT = `name = "security_reviewer"
description = "Reviews security-sensitive changes"
developer_instructions = "Review authentication and authorization changes."`;

const CODEX_READONLY_AGENT = `${CODEX_AGENT}
sandbox_mode = "read-only"`;

const SHARED_AGENT = `---
name: security-reviewer
description: Reviews security-sensitive changes
---

Review authentication and authorization changes.`;

describe("agents translator required fields and formats", () => {
  test("C3 returns null for empty content or a missing source filename", () => {
    expect(translateAgent.claudeToCursor("", "security-reviewer.md")).toBeNull();
    expect(translateAgent.claudeToCursor(CLAUDE_AGENT)).toBeNull();
  });

  test("C3 parses Claude YAML and emits required Codex TOML fields", () => {
    const result = translateAgent.claudeToCodex(CLAUDE_AGENT, "teams/security.md");
    expect(result?.targetName).toBe("security-reviewer.toml");
    const parsed = TOML.parse(result?.content ?? "") as Record<string, unknown>;
    expect(parsed.name).toBe("security-reviewer");
    expect(parsed.description).toBe("Reviews security-sensitive changes");
    expect(parsed.developer_instructions).toBe("Review authentication and authorization changes.");
  });

  test("C3 derives Cursor identity from the source filename and emits Claude YAML", () => {
    const result = translateAgent.cursorToClaude(CURSOR_AGENT, "security-reviewer.md");
    expect(result?.targetName).toBe("security-reviewer.md");
    const fields = frontmatterOf(result?.content ?? "");
    expect(fields.name).toBe("security-reviewer");
    expect(fields.description).toBe("Reviews security-sensitive changes");
    expect(bodyOf(result?.content ?? "")).toBe("Review authentication and authorization changes.");
  });

  test("C3 parses Codex TOML and emits Cursor YAML with a .md filename", () => {
    const result = translateAgent.codexToCursor(CODEX_AGENT, "security.toml");
    expect(result?.targetName).toBe("security-reviewer.md");
    const fields = frontmatterOf(result?.content ?? "");
    expect(fields.name).toBe("security-reviewer");
    expect(fields.description).toBe("Reviews security-sensitive changes");
    expect(fields.readonly).toBe(true);
    expect(bodyOf(result?.content ?? "")).toBe("Review authentication and authorization changes.");
  });

  test("C3 parses the shared agent format and emits required Claude fields", () => {
    const result = translateAgent.copilotToClaude(SHARED_AGENT, "security.agent.md");
    expect(result?.targetName).toBe("security.md");
    const fields = frontmatterOf(result?.content ?? "");
    expect(fields.name).toBe("security");
    expect(fields.description).toBe("Reviews security-sensitive changes");
    expect(bodyOf(result?.content ?? "")).toBe("Review authentication and authorization changes.");
  });

  test("C3 emits the documented shared .agent.md extension", () => {
    const result = translateAgent.claudeToCopilot(CLAUDE_AGENT, "security.md");
    expect(result?.targetName).toBe("security-reviewer.agent.md");
    expect(frontmatterOf(result?.content ?? "").description).toBe(
      "Reviews security-sensitive changes",
    );
  });

  test("C3 rejects missing vendor-required fields by name", () => {
    expectRejected(
      translateAgent.claudeToCursor("---\nname: reviewer\n---\n\nReview.", "reviewer.md"),
      "description",
    );
    expectRejected(
      translateAgent.codexToClaude('name = "reviewer"\ndescription = "Reviews"', "reviewer.toml"),
      "developer_instructions",
    );
    expectRejected(
      translateAgent.copilotToCursor("---\nname: reviewer\n---\n\nReview.", "reviewer.agent.md"),
      "description",
    );
  });

  test("C3 rejects malformed structured YAML and TOML", () => {
    expectRejected(
      translateAgent.claudeToCursor("---\nname: [broken\n---\nbody", "broken.md"),
      "YAML",
    );
    expectRejected(translateAgent.codexToClaude('name = "unterminated', "broken.toml"), "TOML");
  });
});

describe("agents translator authority preservation", () => {
  test("C4 maps documented Claude tool names to shared tool aliases", () => {
    const source = `---
name: reviewer
description: Reviews code
tools: [Read, Write, Grep, Bash, Task, WebFetch]
---

Review code.`;
    const incomplete = translateAgent.claudeToCopilot(source, "reviewer.md");
    expectRejected(incomplete, "incomplete");

    const completeSource = `---
name: reviewer
description: Reviews code
tools: [Read, Edit, Write, NotebookEdit, Grep, Glob, Bash, PowerShell, Agent, WebSearch, WebFetch]
---

Review code.`;
    const result = translateAgent.claudeToCopilot(completeSource, "reviewer.md");
    expect(frontmatterOf(result?.content ?? "").tools).toEqual([
      "read",
      "edit",
      "search",
      "execute",
      "agent",
      "web",
    ]);
    expect(result?.errors).toBeUndefined();
  });

  test("C4 maps documented shared aliases to Claude tools without widening an empty list", () => {
    const mapped = translateAgent.copilotToClaude(
      "---\nname: security-reviewer\ndescription: Reviews\ntools: [read, search]\n---\n\nReview.",
      "security.agent.md",
    );
    const mappedTools = frontmatterOf(mapped?.content ?? "").tools as string[];
    expect(mappedTools).toContain("Read");
    expect(mappedTools.some((tool) => tool === "Grep" || tool === "Glob")).toBe(true);

    const noTools = translateAgent.copilotToClaude(
      "---\nname: inert\ndescription: Has no tools\ntools: []\n---\n\nOnly reason.",
      "inert.agent.md",
    );
    expect(frontmatterOf(noTools?.content ?? "").tools).toEqual([]);
  });

  test("C4 maps Cursor readonly only to Codex read-only sandbox and back", () => {
    const toCodex = translateAgent.cursorToCodex(CURSOR_READONLY_AGENT, "security-reviewer.md");
    const codex = TOML.parse(toCodex?.content ?? "") as Record<string, unknown>;
    expect(codex.sandbox_mode).toBe("read-only");

    const toCursor = translateAgent.codexToCursor(CODEX_READONLY_AGENT, "security.toml");
    expect(frontmatterOf(toCursor?.content ?? "").readonly).toBe(true);
  });

  test("C4 rejects restrictions that have no verified target mapping", () => {
    expectRejected(
      translateAgent.claudeToCursor(
        "---\nname: reviewer\ndescription: Reviews\ndisallowedTools: [Write]\n---\n\nReview.",
        "reviewer.md",
      ),
      "disallowedTools",
    );
    expectRejected(
      translateAgent.claudeToCursor(
        "---\nname: planner\ndescription: Plans\npermissionMode: plan\n---\n\nPlan.",
        "planner.md",
      ),
      "permissionMode",
    );
    expectRejected(
      translateAgent.cursorToClaude(CURSOR_READONLY_AGENT, "security-reviewer.md"),
      "readonly",
    );
    expectRejected(
      translateAgent.codexToClaude(
        `${CODEX_AGENT}\n\n[mcp_servers.private]\nurl = "https://example.test"`,
        "security.toml",
      ),
      "mcp_servers",
    );
  });

  test("OpenCode agent restrictions fail closed while explicit nonrestrictions are named losses", () => {
    expectRejected(
      translateAgent.openCodeToClaude(
        "---\ndescription: Reviews\nmode: subagent\ntools:\n  write: false\n---\n\nReview.",
        "reviewer.md",
      ),
      "tools",
    );
    expectRejected(
      translateAgent.openCodeToClaude(
        "---\ndescription: Reviews\nmode: subagent\ndisable: true\n---\n\nReview.",
        "reviewer.md",
      ),
      "disable",
    );

    const toolsEnabled = translateAgent.openCodeToClaude(
      "---\ndescription: Reviews\nmode: subagent\ntools:\n  write: true\n---\n\nReview.",
      "reviewer.md",
    );
    expect(toolsEnabled?.skipWrite).not.toBe(true);
    expect(toolsEnabled?.warnings?.join("\n")).toContain("tools");

    const enabledAgent = translateAgent.openCodeToClaude(
      "---\ndescription: Reviews\nmode: subagent\ndisable: false\n---\n\nReview.",
      "reviewer.md",
    );
    expect(enabledAgent?.skipWrite).not.toBe(true);
    expect(enabledAgent?.warnings?.join("\n")).toContain("disable");
  });

  test.each([
    ["tools", "[]", "mapping of boolean values"],
    ["disable", '"false"', "must be a boolean"],
    ["steps", "0", "positive integer"],
    ["maxSteps", "1.5", "positive integer"],
  ])("rejects malformed OpenCode %s authority", (field, value, message) => {
    const result = translateAgent.openCodeToClaude(
      `---\ndescription: Reviews\nmode: subagent\n${field}: ${value}\n---\n\nReview.`,
      "reviewer.md",
    );
    expectRejected(result, message);
  });

  test.each([
    "steps",
    "maxSteps",
  ])("rejects the OpenCode %s execution bound when the target has no equivalent", (field) => {
    const result = translateAgent.openCodeToClaude(
      `---\ndescription: Reviews\nmode: subagent\n${field}: 3\n---\n\nReview.`,
      "reviewer.md",
    );
    expectRejected(result, `authority field '${field}'`);
  });

  test("maps a validated Claude maxTurns cap to OpenCode steps", () => {
    const result = translateAgent.claudeToOpenCode(
      "---\nname: reviewer\ndescription: Reviews\nmaxTurns: 7\n---\n\nReview.",
      "reviewer.md",
    );
    expect(result?.skipWrite).not.toBe(true);
    expect(frontmatterOf(result?.content ?? "").steps).toBe(7);
    expect((result?.warnings ?? []).join("\n")).not.toContain("maxTurns");
  });

  test.each(["0", "1.5", '"7"'])("rejects invalid Claude maxTurns %s", (value) => {
    const result = translateAgent.claudeToOpenCode(
      `---\nname: reviewer\ndescription: Reviews\nmaxTurns: ${value}\n---\n\nReview.`,
      "reviewer.md",
    );
    expectRejected(result, "maxTurns");
    expect(result?.errors?.join("\n")).toContain("positive integer");
  });

  test("names OpenCode variant as a known non-authority loss", () => {
    const result = translateAgent.openCodeToClaude(
      "---\ndescription: Reviews\nmode: subagent\nvariant: high\n---\n\nReview.",
      "reviewer.md",
    );
    expect(result?.skipWrite).not.toBe(true);
    expect((result?.warnings ?? []).join("\n")).toContain("variant");
  });

  test("C4 rejects unknown tool aliases and unknown fields rather than dropping them", () => {
    expectRejected(
      translateAgent.claudeToCopilot(
        "---\nname: reviewer\ndescription: Reviews\ntools: [Read, FutureWrite]\n---\n\nReview.",
        "reviewer.md",
      ),
      "FutureWrite",
    );
    expectRejected(
      translateAgent.copilotToCursor(
        "---\nname: reviewer\ndescription: Reviews\nfuture-capability: true\n---\n\nReview.",
        "reviewer.agent.md",
      ),
      "future-capability",
    );
  });

  test("C4 names known non-authority fields that are intentionally lost", () => {
    const result = translateAgent.claudeToCursor(
      "---\nname: reviewer\ndescription: Reviews\nmodel: sonnet\n---\n\nReview.",
      "reviewer.md",
    );
    expect((result?.warnings ?? []).join("\n")).toContain("model");
    expect(frontmatterOf(result?.content ?? "").model).toBeUndefined();
  });
});

describe("agents translator identity and shared prompt limits", () => {
  test("preserves nested OpenCode identities and rejects them for flat targets", () => {
    const source = "---\ndescription: Reviews code\nmode: subagent\n---\n\nReview carefully.";
    expect(inspectAgentSource("opencode", source, "teams/reviewer.md").identity).toBe(
      "teams/reviewer",
    );

    for (const result of [
      translateAgent.openCodeToClaude(source, "teams/reviewer.md"),
      translateAgent.openCodeToCursor(source, "teams/reviewer.md"),
      translateAgent.openCodeToCodex(source, "teams/reviewer.md"),
      translateAgent.openCodeToCopilot(source, "teams/reviewer.md"),
    ]) {
      expectRejected(result, "target identity is not path-safe");
    }
  });

  test("C5 applies Claude identity rules without inventing a universal length limit", () => {
    const longName = `review-${"a".repeat(80)}`;
    const result = translateAgent.claudeToCodex(
      `---\nname: ${longName}\ndescription: Reviews\n---\n\nReview.`,
      "review.md",
    );
    expect(result?.skipWrite).not.toBe(true);
    expect(result?.targetName).toBe(`${longName}.toml`);
  });

  test("C5 normalizes a valid Codex underscore identity for a Cursor target", () => {
    const result = translateAgent.codexToCursor(CODEX_AGENT, "security.toml");
    expect(result?.targetName).toBe("security-reviewer.md");
    expect(frontmatterOf(result?.content ?? "").name).toBe("security-reviewer");
    expect(frontmatterOf(result?.content ?? "").readonly).toBe(true);
  });

  test("C5 rejects hidden, traversal, and control-character source names", () => {
    expectRejected(translateAgent.claudeToCursor(CLAUDE_AGENT, ".hidden.md"), "hidden");
    expectRejected(translateAgent.claudeToCursor(CLAUDE_AGENT, "../reviewer.md"), "path");
    expectRejected(translateAgent.claudeToCursor(CLAUDE_AGENT, "bad\u0000name.md"), "control");
  });

  test("C6 accepts a 30,000-character shared prompt and rejects 30,001", () => {
    const atLimit = `---\nname: boundary\ndescription: Boundary\n---\n\n${"a".repeat(30_000)}`;
    const overLimit = `---\nname: boundary\ndescription: Boundary\n---\n\n${"a".repeat(30_001)}`;

    expect(translateAgent.claudeToCopilot(atLimit, "boundary.md")?.skipWrite).not.toBe(true);
    expectRejected(translateAgent.claudeToCopilot(overLimit, "boundary.md"), "30,000");
  });
});
