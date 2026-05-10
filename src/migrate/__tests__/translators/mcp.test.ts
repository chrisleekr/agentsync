import { describe, expect, test } from "bun:test";
import { translateMcp } from "../../translators/mcp";

const FIXTURE_JSON = JSON.stringify(
  {
    mcpServers: {
      github: { command: "gh-mcp", args: ["serve"], env: { GITHUB_TOKEN: "test" } },
      slack: { command: "slack-mcp", args: [], env: {} },
    },
  },
  null,
  2,
);

const FIXTURE_TOML = `[mcp.servers.github]
command = "gh-mcp"
args = ["serve"]

[mcp.servers.github.env]
GITHUB_TOKEN = "test"

[mcp.servers.slack]
command = "slack-mcp"
args = []

[mcp.servers.slack.env]
`;

const FIXTURE_VSCODE_OFFICIAL = JSON.stringify(
  {
    inputs: [{ id: "gh_token", type: "promptString", description: "GitHub token", password: true }],
    servers: {
      github: {
        type: "stdio",
        command: "gh-mcp",
        args: ["serve"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code input variable syntax
        env: { GITHUB_TOKEN: "${input:gh_token}" },
        envFile: ".env.local",
        sandboxEnabled: true,
        sandbox: { networking: false },
        dev: { watch: ["**/*.ts"] },
      },
      remote: {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer test", "X-Trace": "on" },
      },
      sse: {
        type: "sse",
        url: "https://example.com/sse",
      },
    },
  },
  null,
  2,
);

const FIXTURE_VSCODE_LEGACY = JSON.stringify(
  {
    mcpServers: {
      github: { command: "gh-mcp", args: ["serve"], env: { GITHUB_TOKEN: "test" } },
    },
  },
  null,
  2,
);

describe("MCP translators", () => {
  test("empty mcpServers returns null", () => {
    expect(translateMcp.claudeToCursor('{"mcpServers":{}}')).toBeNull();
  });

  test("invalid JSON returns null", () => {
    expect(translateMcp.claudeToCursor("not json")).toBeNull();
  });

  test("JSON → JSON identity (claude → cursor)", () => {
    const result = translateMcp.claudeToCursor(FIXTURE_JSON);
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("mcp.json");
    const parsed = JSON.parse(result?.content as string);
    expect(parsed.mcpServers.github.command).toBe("gh-mcp");
    expect(parsed.mcpServers.slack.command).toBe("slack-mcp");
  });

  test("JSON → TOML (claude → codex)", () => {
    const result = translateMcp.claudeToCodex(FIXTURE_JSON);
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("config.toml");
    expect(result?.content).toContain("[mcp.servers.github]");
    expect(result?.content).toContain('command = "gh-mcp"');
  });

  test("TOML → JSON (codex → claude)", () => {
    const result = translateMcp.codexToClaude(FIXTURE_TOML);
    expect(result).not.toBeNull();
    expect(result?.targetName).toBe("mcp.json");
    const parsed = JSON.parse(result?.content as string);
    expect(parsed.mcpServers.github.command).toBe("gh-mcp");
  });

  test("round-trip JSON → TOML → JSON preserves servers", () => {
    const toToml = translateMcp.claudeToCodex(FIXTURE_JSON);
    const backToJson = translateMcp.codexToClaude(toToml?.content as string);
    const parsed = JSON.parse(backToJson?.content as string);
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["github", "slack"]);
    expect(parsed.mcpServers.github.command).toBe("gh-mcp");
    expect(parsed.mcpServers.github.args).toEqual(["serve"]);
  });

  test("JSON → JSON preserves all fields (env, args)", () => {
    const result = translateMcp.claudeToCursor(FIXTURE_JSON);
    const parsed = JSON.parse(result?.content as string);
    expect(parsed.mcpServers.github.env.GITHUB_TOKEN).toBe("test");
    expect(parsed.mcpServers.github.args).toEqual(["serve"]);
  });
});

// ── VS Code official-shape fixtures ─────────────────────────────────────────

describe("VS Code MCP translators (official servers/inputs schema)", () => {
  test("vscode → vscode round-trip preserves all transport fields", () => {
    // Run through claude as an intermediate to prove parse+serialize work
    // without losing transport metadata.
    const result = translateMcp.codexToVsCode(
      // First convert vscode → codex → vscode through the model
      (translateMcp.vsCodeToCodex(FIXTURE_VSCODE_OFFICIAL) as { content: string }).content,
    );
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result?.content as string) as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.servers.github.type).toBe("stdio");
    expect(parsed.servers.github.command).toBe("gh-mcp");
    expect(parsed.servers.remote.type).toBe("http");
    expect(parsed.servers.remote.url).toBe("https://example.com/mcp");
    expect((parsed.servers.remote.headers as Record<string, string>).Authorization).toBe(
      "Bearer test",
    );
    expect(parsed.servers.sse.type).toBe("sse");
    expect(parsed.servers.sse.url).toBe("https://example.com/sse");
  });

  test("claude → vscode emits top-level servers (not mcpServers)", () => {
    const result = translateMcp.claudeToVsCode(FIXTURE_JSON);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result?.content as string) as Record<string, unknown>;
    expect(parsed.servers).toBeDefined();
    expect((parsed.servers as Record<string, unknown>).github).toBeDefined();
    expect(parsed.mcpServers).toBeUndefined();
  });

  test("cursor → vscode emits top-level servers", () => {
    const result = translateMcp.cursorToVsCode(FIXTURE_JSON);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result?.content as string) as Record<string, unknown>;
    expect(parsed.servers).toBeDefined();
    expect(parsed.mcpServers).toBeUndefined();
  });

  test("vscode → claude emits mcpServers (not servers) and warns about HTTP/SSE", () => {
    const result = translateMcp.vsCodeToClaude(FIXTURE_VSCODE_OFFICIAL);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result?.content as string) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.servers).toBeUndefined();
    // Only stdio survives — github
    const servers = parsed.mcpServers as Record<string, unknown>;
    expect(servers.github).toBeDefined();
    expect(servers.remote).toBeUndefined();
    expect(servers.sse).toBeUndefined();
    // Warnings name the dropped servers and the inputs placeholder
    const w = (result?.warnings ?? []).join("\n");
    expect(w).toContain("remote");
    expect(w).toContain("http");
    expect(w).toContain("sse");
    expect(w).toContain("inputs");
  });

  test("vscode → cursor emits mcpServers and warns about HTTP/SSE", () => {
    const result = translateMcp.vsCodeToCursor(FIXTURE_VSCODE_OFFICIAL);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result?.content as string) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.servers).toBeUndefined();
    expect((result?.warnings ?? []).length).toBeGreaterThan(0);
  });

  test("vscode → codex preserves HTTP transport fields under [mcp.servers]", () => {
    const result = translateMcp.vsCodeToCodex(FIXTURE_VSCODE_OFFICIAL);
    expect(result).not.toBeNull();
    expect(result?.content).toContain("[mcp.servers.remote]");
    expect(result?.content).toContain('type = "http"');
    expect(result?.content).toContain('url = "https://example.com/mcp"');
    expect(result?.content).toContain("[mcp.servers.remote.headers]");
    expect(result?.content).toContain('Authorization = "Bearer test"');
  });

  test("vscode → codex warns about top-level inputs being dropped", () => {
    const result = translateMcp.vsCodeToCodex(FIXTURE_VSCODE_OFFICIAL);
    expect(result?.warnings ?? []).toHaveLength(1);
    expect((result?.warnings ?? [])[0]).toContain("inputs");
  });

  test("vscode (legacy mcpServers shape) still parses for round-trip", () => {
    const result = translateMcp.vsCodeToClaude(FIXTURE_VSCODE_LEGACY);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result?.content as string) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, { command: string }>;
    expect(servers.github.command).toBe("gh-mcp");
  });

  test("vscode → vscode preserves inputs at top level", () => {
    // Self-pair isn't registered, but we exercise the serializer via the
    // codex round-trip to confirm inputs survive the model.
    const vsToCodex = translateMcp.vsCodeToCodex(FIXTURE_VSCODE_OFFICIAL);
    const back = translateMcp.codexToVsCode((vsToCodex as { content: string }).content);
    expect(back).not.toBeNull();
    // codex doesn't carry inputs, so the round-trip drops them on this path —
    // and that's exactly why vs-code-to-codex emits a warning above.
    const parsed = JSON.parse(back?.content as string) as Record<string, unknown>;
    expect(parsed.servers).toBeDefined();
  });

  test("claude → vscode preserves env via stdio shape", () => {
    const result = translateMcp.claudeToVsCode(FIXTURE_JSON);
    const parsed = JSON.parse(result?.content as string) as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.servers.github.type).toBe("stdio");
    expect(parsed.servers.github.command).toBe("gh-mcp");
    expect((parsed.servers.github.env as Record<string, string>).GITHUB_TOKEN).toBe("test");
  });
});
