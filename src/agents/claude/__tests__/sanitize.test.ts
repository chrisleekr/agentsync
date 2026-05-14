import { describe, expect, test } from "bun:test";
import { AGENTSYNC_HOME_PLACEHOLDER } from "../../../core/path-portability";
import {
  sanitizeClaudeHooks,
  sanitizeClaudeMcp,
  sanitizeClaudePluginManifest,
  sanitizeClaudePluginMcp,
} from "../sanitize";

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

  test("sanitizeClaudePluginManifest rewrites home-prefixed paths to placeholder", () => {
    const home = "/Users/alpha";
    const raw = JSON.stringify({
      name: "lefthook",
      installPath: `${home}/.claude/plugins/lefthook`,
    });
    const out = JSON.parse(sanitizeClaudePluginManifest(raw, home).value) as {
      installPath: string;
      name: string;
    };
    expect(out.installPath).toBe(`${AGENTSYNC_HOME_PLACEHOLDER}/.claude/plugins/lefthook`);
    expect(out.name).toBe("lefthook");
  });

  test("sanitizeClaudePluginMcp rewrites home-prefixed paths to placeholder", () => {
    const home = "/Users/alpha";
    const raw = JSON.stringify({
      command: "node",
      args: [`${home}/.claude/plugins/x/srv.js`, "--root=/etc/hosts"],
    });
    const out = JSON.parse(sanitizeClaudePluginMcp(raw, home).value) as { args: string[] };
    expect(out.args[0]).toBe(`${AGENTSYNC_HOME_PLACEHOLDER}/.claude/plugins/x/srv.js`);
    expect(out.args[1]).toBe("--root=/etc/hosts");
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
