import { describe, expect, test } from "bun:test";
import {
  EMBEDDED_SECRET_PATTERNS,
  NEVER_SYNC_PATTERNS,
  redactionEnvNameForPath,
  redactSecretLiterals,
  sanitizeClaudeHooks,
  sanitizeClaudeMcp,
  sanitizeClaudePluginManifest,
  sanitizeClaudePluginMcp,
  scanForSecrets,
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

  // Claude plugin sanitizers (issue #31)

  test("sanitizeClaudePluginManifest preserves manifest metadata", () => {
    const manifest = JSON.stringify({
      name: "acme-toolkit",
      version: "1.2.3",
      description: "Acme tools",
      author: "Acme",
      commands: [{ name: "review" }],
    });
    const out = sanitizeClaudePluginManifest(manifest);
    const parsed = JSON.parse(out.value) as Record<string, unknown>;
    expect(parsed.name).toBe("acme-toolkit");
    expect(parsed.version).toBe("1.2.3");
    expect(parsed.description).toBe("Acme tools");
    expect((parsed.commands as { name: string }[])[0]?.name).toBe("review");
  });

  test("sanitizeClaudePluginManifest redacts literal secrets", () => {
    const manifest = JSON.stringify({
      name: "acme",
      env: { token: `sk-${"x".repeat(30)}` },
    });
    const out = sanitizeClaudePluginManifest(manifest);
    const parsed = JSON.parse(out.value) as { env: { token: string } };
    expect(parsed.env.token.startsWith("$AGENTSYNC_REDACTED")).toBeTrue();
    expect(out.warnings.length).toBe(1);
  });

  test("sanitizeClaudePluginMcp preserves the bare server descriptor", () => {
    const mcp = JSON.stringify({
      mcpServers: { acme: { command: "node", args: ["server.js"] } },
    });
    const out = sanitizeClaudePluginMcp(mcp);
    const parsed = JSON.parse(out.value) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeDefined();
  });

  test("sanitizeClaudePluginMcp redacts literal secrets inside server config", () => {
    const mcp = JSON.stringify({
      mcpServers: { acme: { env: { API_KEY: `sk-${"y".repeat(30)}` } } },
    });
    const out = sanitizeClaudePluginMcp(mcp);
    expect(out.warnings.length).toBe(1);
    expect(out.value).toContain("$AGENTSYNC_REDACTED");
  });

  test("EMBEDDED_SECRET_PATTERNS is non-empty so scanForSecrets has rules to run", () => {
    expect(EMBEDDED_SECRET_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of EMBEDDED_SECRET_PATTERNS) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.pattern).toBeInstanceOf(RegExp);
    }
  });

  test("scanForSecrets returns no warnings on plain prose", () => {
    const prose =
      "AgentSync syncs your local agent configuration through an encrypted vault. " +
      "Read README.md for setup. Path: /home/user/.claude/CLAUDE.md is fine.";
    expect(scanForSecrets(prose, "/home/user/.claude/CLAUDE.md")).toEqual([]);
  });

  test("scanForSecrets returns no warnings on empty input", () => {
    expect(scanForSecrets("", "/tmp/empty.md")).toEqual([]);
  });

  test.each<[string, string]>([
    ["anthropic-api-key", `sk-ant-api03-${"A".repeat(48)}`],
    ["openai-project-key", `sk-proj-${"a".repeat(48)}`],
    ["github-classic-pat", `ghp_${"x".repeat(36)}`],
    ["github-fine-grained-pat", `github_pat_${"y".repeat(82)}`],
    ["gitlab-pat", `glpat-${"z".repeat(20)}`],
    ["aws-access-key", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["google-api-key", `AIza${"a".repeat(35)}`],
    ["slack-token-bot", `xoxb-${"abc123".repeat(2)}`],
    ["slack-token-user", `xoxp-${"abc123".repeat(2)}`],
    ["slack-token-app", `xoxa-${"abc123".repeat(2)}`],
    ["slack-token-refresh", `xoxr-${"abc123".repeat(2)}`],
    ["slack-token-session", `xoxs-${"abc123".repeat(2)}`],
  ])("scanForSecrets detects %s embedded in prose", (expectedName, sampleSecret) => {
    const body = `Note from setup: my key is ${sampleSecret}. Do not share.`;
    const warnings = scanForSecrets(body, "/tmp/leaky.md");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.startsWith("Detected literal secret"))).toBe(true);
    expect(warnings.some((w) => w.includes("/tmp/leaky.md"))).toBe(true);
    // The matching pattern's name (or the slack-token base name for the
    // Slack probes — all five variants share one regex) must appear in at
    // least one warning.
    const stem = expectedName.startsWith("slack-token") ? "slack-token" : expectedName;
    expect(warnings.some((w) => w.includes(stem))).toBe(true);
  });

  test("scanForSecrets catches Gap 2 — secrets embedded in JSON-stringified env values", () => {
    // The original `redactSecretLiterals` only matches whole-string JSON
    // values. A prose-style env value like "the key is sk-ant-…" sails
    // through unanchored. The central scan in performPush sees the full
    // stringified JSON and must catch it.
    const mcpJson = JSON.stringify({
      mcpServers: {
        acme: {
          env: { GREETING: `my key is sk-ant-api03-${"A".repeat(48)} thanks` },
        },
      },
    });
    const warnings = scanForSecrets(mcpJson, "/home/user/.claude.json");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("anthropic-api-key"))).toBe(true);
  });

  test("scanForSecrets does NOT false-positive on long alphanumeric runs in prose", () => {
    const prose =
      "Commit 0123456789abcdef0123456789abcdef0123456789abcdef contains a fix. " +
      "The build hash AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA passed CI. " +
      "Branch feature-xyz merged at 2026-05-11.";
    expect(scanForSecrets(prose, "/tmp/notes.md")).toEqual([]);
  });
});
