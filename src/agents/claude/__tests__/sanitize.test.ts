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
});
