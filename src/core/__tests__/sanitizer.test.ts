import { describe, expect, test } from "bun:test";
import {
  NEVER_SYNC_PATTERNS,
  redactSecretLiterals,
  redactionEnvNameForPath,
  sanitizeClaudeHooks,
  sanitizeClaudeMcp,
  shouldNeverSync,
} from "../sanitizer";

describe("sanitizer", () => {
  test("redacts obvious secret-like values", () => {
    const result = redactSecretLiterals({
      token: "sk-abcdefghijklmnopqrstuvwxyz123456",
    });
    const value = result.value as { token: string };
    expect(value.token.startsWith("$AGENTSYNC_REDACTED")).toBeTrue();
    expect(result.warnings.length).toBe(1);
  });

  test("extracts hooks only from claude settings", () => {
    const output = sanitizeClaudeHooks(
      JSON.stringify({
        hooks: { PreToolUse: [] },
        other: { should: "be-dropped" },
      }),
    );
    const parsed = JSON.parse(output.value) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["hooks"]);
  });

  test("extracts mcpServers only from .claude.json", () => {
    const output = sanitizeClaudeMcp(
      JSON.stringify({ mcpServers: { test: { command: "npx" } }, other: 123 }),
    );
    const parsed = JSON.parse(output.value) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["mcpServers"]);
  });

  test("never sync excludes sensitive files", () => {
    expect(shouldNeverSync("/tmp/.codex/auth.json")).toBeTrue();
    expect(shouldNeverSync("/tmp/.claude/.credentials.json")).toBeTrue();
    expect(shouldNeverSync("/tmp/normal/file.md")).toBeFalse();
  });

  // ─── NEVER_SYNC_PATTERNS boundary cases ───────────────────────────────────

  test("NEVER_SYNC_PATTERNS is a non-empty array", () => {
    expect(NEVER_SYNC_PATTERNS.length).toBeGreaterThan(0);
  });

  test("**/auth.json matches nested auth.json", () => {
    expect(shouldNeverSync("/home/user/.codex/auth.json")).toBeTrue();
    expect(shouldNeverSync("auth.json")).toBeTrue();
  });

  test("**/.credentials.json matches nested .credentials.json", () => {
    expect(shouldNeverSync("/home/user/.claude/.credentials.json")).toBeTrue();
  });

  test("**/history.jsonl matches history.jsonl anywhere", () => {
    expect(shouldNeverSync("/home/user/.claude/history.jsonl")).toBeTrue();
  });

  test("**/sessions/** matches files inside sessions dir", () => {
    expect(shouldNeverSync("/home/user/.claude/sessions/abc.json")).toBeTrue();
    expect(shouldNeverSync("/home/user/.claude/sessions/nested/file")).toBeTrue();
  });

  test("**/.claude/statsig/** matches files inside statsig dir", () => {
    expect(shouldNeverSync("/home/user/.claude/statsig/data.json")).toBeTrue();
  });

  test("**/*.local.md matches local-only markdown files", () => {
    expect(shouldNeverSync("/home/user/.claude/notes.local.md")).toBeTrue();
    expect(shouldNeverSync("private.local.md")).toBeTrue();
  });

  test("**/.claude/settings.local.json is blocked", () => {
    expect(shouldNeverSync("/home/user/.claude/settings.local.json")).toBeTrue();
  });

  test("**/agentsync.toml is blocked", () => {
    expect(shouldNeverSync("/vault/agentsync.toml")).toBeTrue();
  });

  test("**/*.age is blocked", () => {
    expect(shouldNeverSync("/vault/claude/CLAUDE.md.age")).toBeTrue();
    expect(shouldNeverSync("file.age")).toBeTrue();
  });

  test("CLAUDE.md is NOT blocked", () => {
    expect(shouldNeverSync("/home/user/.claude/CLAUDE.md")).toBeFalse();
  });

  test("settings.json (not .local) is NOT blocked", () => {
    expect(shouldNeverSync("/home/user/.claude/settings.json")).toBeFalse();
  });

  // ─── redactionEnvNameForPath ───────────────────────────────────────────────

  test("redactionEnvNameForPath returns AGENTSYNC_REDACTED_ prefix", () => {
    const name = redactionEnvNameForPath("/home/user/.claude/settings.json");
    expect(name).toBe("AGENTSYNC_REDACTED_SETTINGS_JSON");
  });

  test("redactionEnvNameForPath handles hyphens and dots", () => {
    const name = redactionEnvNameForPath("/path/to/mcp.json");
    expect(name).toBe("AGENTSYNC_REDACTED_MCP_JSON");
  });

  test("redactionEnvNameForPath uses only the basename", () => {
    const a = redactionEnvNameForPath("/very/deep/path/config.toml");
    const b = redactionEnvNameForPath("config.toml");
    expect(a).toBe(b);
  });

  // ─── redactSecretLiterals — deep nesting and non-redacted pass-through ─────

  test("does not redact short non-secret strings", () => {
    const result = redactSecretLiterals({ key: "hello" });
    const value = result.value as { key: string };
    expect(value.key).toBe("hello");
    expect(result.warnings).toHaveLength(0);
  });

  test("redacts deeply nested secret value", () => {
    const input = { a: { b: { c: { apiKey: `sk-${"x".repeat(30)}` } } } };
    const result = redactSecretLiterals(input, "root");
    const deep = (result.value as typeof input).a.b.c;
    expect(deep.apiKey.startsWith("$AGENTSYNC_REDACTED")).toBeTrue();
    expect(result.warnings).toHaveLength(1);
  });

  test("handles array of values — redacts secrets, passes safe strings", () => {
    const input = ["safe-string", `sk-${"x".repeat(30)}`];
    const result = redactSecretLiterals(input, "arr");
    const value = result.value as string[];
    expect(value[0]).toBe("safe-string");
    expect(value[1]?.startsWith("$AGENTSYNC_REDACTED")).toBeTrue();
  });

  test("passes through null / boolean / number unchanged with zero warnings", () => {
    expect(redactSecretLiterals(null).warnings).toHaveLength(0);
    expect(redactSecretLiterals(42).warnings).toHaveLength(0);
    expect(redactSecretLiterals(true).warnings).toHaveLength(0);
  });
});
