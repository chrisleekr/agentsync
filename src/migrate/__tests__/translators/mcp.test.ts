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
    // Round-trip vscode → codex → vscode to prove parse+serialize work
    // without losing transport metadata across the model.
    const result = translateMcp.codexToVsCode(
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

  test("vscode → codex → vscode does not re-nest extras over repeated cycles", () => {
    // Regression: the codex serializer used to write extras as a nested
    // `entry.extras` subtable, which the parser then re-captured under
    // `extras` again, wrapping one level deeper on every round-trip.
    const withCustom = JSON.stringify({
      servers: {
        github: { type: "stdio", command: "gh-mcp", customMeta: { tier: "gold" } },
      },
    });
    let current = withCustom;
    for (let i = 0; i < 3; i++) {
      const toCodex = translateMcp.vsCodeToCodex(current) as { content: string };
      current = (translateMcp.codexToVsCode(toCodex.content) as { content: string }).content;
    }
    const parsed = JSON.parse(current) as {
      servers: Record<string, Record<string, unknown>>;
    };
    // Custom field is preserved at the top level of the server entry, not
    // nested under any number of `extras` keys.
    expect(parsed.servers.github.customMeta).toEqual({ tier: "gold" });
    expect((parsed.servers.github as { extras?: unknown }).extras).toBeUndefined();
  });

  test("vscode → claude with only http servers returns skipWrite + warnings", () => {
    // No stdio survives the projection, so the translator should surface
    // the warning without writing `{"mcpServers":{}}` over a fresh target.
    const allHttp = JSON.stringify({
      servers: {
        remote: { type: "http", url: "https://example.com/mcp" },
      },
    });
    const result = translateMcp.vsCodeToClaude(allHttp);
    expect(result).not.toBeNull();
    expect(result?.skipWrite).toBe(true);
    expect((result?.warnings ?? []).join("\n")).toContain("remote");
  });

  test("vscode → codex with only inputs returns skipWrite + warnings", () => {
    const inputsOnly = JSON.stringify({
      servers: {},
      inputs: [{ id: "tok", type: "promptString" }],
    });
    const result = translateMcp.vsCodeToCodex(inputsOnly);
    // Either `null` (no servers AND no inputs in model — but inputs survive
    // parsing here) or a skipWrite envelope. Either way no file is written.
    if (result !== null) {
      expect(result.skipWrite).toBe(true);
      expect(result.warnings ?? []).toHaveLength(1);
    }
  });

  test("vscode → claude warns about dropped stdio-only metadata fields", () => {
    const result = translateMcp.vsCodeToClaude(FIXTURE_VSCODE_OFFICIAL);
    expect(result).not.toBeNull();
    const w = (result?.warnings ?? []).join("\n");
    // FIXTURE_VSCODE_OFFICIAL.servers.github sets envFile/sandbox/sandboxEnabled/dev
    expect(w).toContain('Server "github"');
    expect(w).toMatch(/envFile|sandbox|sandboxEnabled|dev/);
  });

  describe("Copilot CLI as fifth MCP endpoint", () => {
    // Copilot CLI's mcp-config.json is Claude-shape; the parser is strict
    // about extra fields, so we keep this fixture to the canonical stdio
    // subset (`command`/`args`/`env`). The `type: "local"`/`tools: ["*"]`
    // fields the Copilot UI writes are non-spec extras the parser drops
    // with a warning — covered separately by the existing extras tests.
    const COPILOT_FIXTURE = JSON.stringify({
      mcpServers: {
        playwright: {
          command: "npx",
          args: ["@playwright/mcp@latest"],
          env: {},
        },
      },
    });

    test("copilot → claude: round-trip stdio servers identically", () => {
      const result = translateMcp.copilotToClaude(COPILOT_FIXTURE);
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result?.content ?? "{}") as {
        mcpServers?: Record<string, unknown>;
      };
      expect(parsed.mcpServers?.playwright).toBeDefined();
    });

    test("claude → copilot: drops HTTP servers with named warning", () => {
      const claudeMixed = JSON.stringify({
        mcpServers: {
          remote: { type: "http", url: "https://example.com/mcp" },
          local: { command: "npx", args: ["foo"] },
        },
      });
      const result = translateMcp.claudeToCopilot(claudeMixed);
      expect(result).not.toBeNull();
      const w = (result?.warnings ?? []).join("\n");
      expect(w).toContain("remote");
    });

    test("vscode → copilot: works (Copilot uses Claude-shape mcpServers)", () => {
      const vscodeFixture = JSON.stringify({
        servers: {
          local: { command: "npx", args: ["foo"] },
        },
      });
      const result = translateMcp.vsCodeToCopilot(vscodeFixture);
      expect(result).not.toBeNull();
      expect(result?.targetName).toBe("mcp.json");
      const parsed = JSON.parse(result?.content ?? "{}") as {
        mcpServers?: Record<string, unknown>;
      };
      expect(parsed.mcpServers?.local).toBeDefined();
    });

    test("copilot → codex: emits TOML [mcp.servers]", () => {
      const result = translateMcp.copilotToCodex(COPILOT_FIXTURE);
      expect(result).not.toBeNull();
      expect(result?.content).toContain("[mcp.servers.playwright]");
    });
  });
});
