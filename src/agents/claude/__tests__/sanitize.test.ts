import { describe, expect, test } from "bun:test";
import { AGENTSYNC_HOME_PLACEHOLDER } from "../../../core/path-portability";
import { sanitizeClaudeHooks, sanitizeClaudeMcp } from "../sanitize";

describe("claude-sanitize", () => {
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

  // ─── HOME path portability ────────────────────────────────────────────────
  // Each sanitize function rewrites a literal home-prefix to the
  // ${AGENTSYNC_HOME} placeholder before serializing so the vault round-trips
  // across machines with different home directories.

  test("sanitizeClaudeHooks rewrites home-prefixed paths to placeholder", () => {
    const home = "/home/alpha";
    const raw = JSON.stringify({
      hooks: { PreToolUse: [{ command: `${home}/.claude/runner` }] },
    });
    const out = JSON.parse(sanitizeClaudeHooks(raw, home).value) as {
      hooks: { PreToolUse: { command: string }[] };
    };
    expect(out.hooks.PreToolUse[0]?.command).toBe(`${AGENTSYNC_HOME_PLACEHOLDER}/.claude/runner`);
  });

  test("sanitizeClaudeMcp rewrites home-prefixed paths to placeholder", () => {
    const home = "/Users/alpha";
    const raw = JSON.stringify({
      mcpServers: { fs: { command: "node", cwd: `${home}/proj` } },
    });
    const out = JSON.parse(sanitizeClaudeMcp(raw, home).value) as {
      mcpServers: { fs: { cwd: string } };
    };
    expect(out.mcpServers.fs.cwd).toBe(`${AGENTSYNC_HOME_PLACEHOLDER}/proj`);
  });

  test("sanitize functions pass through unchanged when home is empty", () => {
    const home = "/Users/alpha";
    const raw = JSON.stringify({ hooks: { PreToolUse: [{ command: `${home}/runner` }] } });
    const out = JSON.parse(sanitizeClaudeHooks(raw, "").value) as {
      hooks: { PreToolUse: { command: string }[] };
    };
    expect(out.hooks.PreToolUse[0]?.command).toBe(`${home}/runner`);
  });

  // ─── Secret policy threading ──────────────────────────────────────────────
  // Proves the adapter honours the SecretPolicy it is handed, not just the
  // default — guards against an adapter silently dropping the policy argument.

  test("sanitizeClaudeMcp redacts a secret value under the default policy", () => {
    const raw = JSON.stringify({ mcpServers: { x: { env: { TOKEN: `ghp_${"a".repeat(36)}` } } } });
    const out = JSON.parse(sanitizeClaudeMcp(raw, "").value) as {
      mcpServers: { x: { env: { TOKEN: string } } };
    };
    expect(out.mcpServers.x.env.TOKEN).toContain("REDACTED");
  });

  test("sanitizeClaudeMcp leaves the secret unredacted when policy mode is off", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const raw = JSON.stringify({ mcpServers: { x: { env: { TOKEN: token } } } });
    const out = JSON.parse(
      sanitizeClaudeMcp(raw, "", { mode: "off", allow: [], redactBase64: true }).value,
    ) as { mcpServers: { x: { env: { TOKEN: string } } } };
    expect(out.mcpServers.x.env.TOKEN).toBe(token);
  });
});
