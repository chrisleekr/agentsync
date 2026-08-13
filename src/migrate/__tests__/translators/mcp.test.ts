import { describe, expect, test } from "bun:test";
import { translateMcp } from "../../translators/mcp";

function vsCodeVariable(name: string): string {
  return `\${${name}}`;
}

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

const FIXTURE_TOML = `[mcp_servers.github]
command = "gh-mcp"
args = ["serve"]

[mcp_servers.github.env]
GITHUB_TOKEN = "test"

[mcp_servers.slack]
command = "slack-mcp"
args = []

[mcp_servers.slack.env]
`;

const FIXTURE_VSCODE_OFFICIAL = JSON.stringify(
  {
    inputs: [{ id: "gh_token", type: "promptString", description: "GitHub token", password: true }],
    sandbox: { networking: false },
    servers: {
      github: {
        type: "stdio",
        command: "gh-mcp",
        args: ["serve"],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: VS Code input variable syntax
        env: { GITHUB_TOKEN: "${input:gh_token}" },
        envFile: ".env.local",
        sandboxEnabled: false,
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

const FIXTURE_VSCODE_REMOTE = JSON.stringify({
  inputs: [{ id: "token", type: "promptString", password: true }],
  servers: {
    remote: {
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer test" },
    },
    sse: { type: "sse", url: "https://example.com/sse" },
  },
});

describe("MCP translators", () => {
  test("empty mcpServers returns null", () => {
    expect(translateMcp.claudeToCursor('{"mcpServers":{}}')).toBeNull();
  });

  test("invalid JSON returns null", () => {
    expect(translateMcp.claudeToCursor("not json")).toBeNull();
  });

  test.each([
    ["Claude", translateMcp.claudeToOpenCode, "mcpServers", {}],
    ["Cursor", translateMcp.cursorToOpenCode, "mcpServers", {}],
    ["Copilot", translateMcp.copilotToOpenCode, "mcpServers", { tools: ["*"] }],
    ["legacy VS Code", translateMcp.vsCodeToOpenCode, "mcpServers", {}],
  ])("%s mixed valid and invalid servers fail before partial migration", (_name, translator, rootKey, fields) => {
    const result = translator(
      JSON.stringify({
        [rootKey]: {
          valid: { command: "node", ...fields },
          malformed: { command: 42, ...fields },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "malformed"');
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
    expect(result?.content).toContain("[mcp_servers.github]");
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
  test.each([
    ["null", null],
    ["array", []],
    ["string", "invalid"],
    ["number", 42],
  ])("malformed canonical servers (%s) fails closed without legacy fallback", (_name, servers) => {
    const result = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers,
        mcpServers: { legacy: { command: "node" } },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("VS Code servers must be an object");
  });

  test("VS Code remote transports survive the representable Codex round-trip", () => {
    const codex = translateMcp.vsCodeToCodex(FIXTURE_VSCODE_REMOTE) as {
      content: string;
      warnings?: string[];
    };
    const result = translateMcp.codexToVsCode(codex.content);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result?.content as string) as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(parsed.servers.remote.type).toBe("http");
    expect(parsed.servers.remote.url).toBe("https://example.com/mcp");
    expect((parsed.servers.remote.headers as Record<string, string>).Authorization).toBe(
      "Bearer test",
    );
    expect(parsed.servers.sse.type).toBe("http");
    expect(parsed.servers.sse.url).toBe("https://example.com/sse");
    expect((codex.warnings ?? []).join("\n")).toContain("transport=sse");
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

  test("vscode → codex preserves verified HTTP fields under [mcp_servers]", () => {
    const result = translateMcp.vsCodeToCodex(FIXTURE_VSCODE_OFFICIAL);
    expect(result).not.toBeNull();
    expect(result?.content).toContain("[mcp_servers.remote]");
    expect(result?.content).not.toContain('type = "http"');
    expect(result?.content).toContain('url = "https://example.com/mcp"');
    expect(result?.content).toContain("[mcp_servers.remote.http_headers]");
    expect(result?.content).toContain('Authorization = "Bearer test"');
  });

  test("vscode → codex warns about top-level inputs being dropped", () => {
    const result = translateMcp.vsCodeToCodex(FIXTURE_VSCODE_OFFICIAL);
    expect((result?.warnings ?? []).some((warning) => warning.includes("inputs"))).toBe(true);
  });

  test("every VS Code source route names a dropped top-level sandbox policy", () => {
    for (const translator of [
      translateMcp.vsCodeToClaude,
      translateMcp.vsCodeToCursor,
      translateMcp.vsCodeToCodex,
      translateMcp.vsCodeToCopilot,
    ]) {
      const result = translator(FIXTURE_VSCODE_OFFICIAL);
      expect(result?.warnings?.join("\n")).toContain('top-level "sandbox" policy');
    }
  });

  test("VS Code top-level sandbox metadata is named when no active server sandbox is dropped", () => {
    const result = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        sandbox: { networking: false },
        servers: { local: { type: "stdio", command: "node" } },
      }),
    );
    expect(result?.skipWrite).toBeUndefined();
    expect(result?.warnings?.join("\n")).toContain('top-level "sandbox" policy');
  });

  test("VS Code numeric env values convert to strings and null fails closed by key", () => {
    const numeric = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers: { local: { type: "stdio", command: "server", env: { PORT: 3000 } } },
      }),
    );
    expect(JSON.parse(numeric?.content ?? "{}").mcp.local.environment.PORT).toBe("3000");
    expect(numeric?.warnings?.join("\n")).toContain("env.PORT");

    const nullable = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers: { local: { type: "stdio", command: "server", env: { TOKEN: null } } },
      }),
    );
    expect(nullable?.skipWrite).toBe(true);
    expect(nullable?.errors?.join("\n")).toContain('Server "local"');
    expect(nullable?.errors?.join("\n")).toContain("env.TOKEN");
  });

  test("vscode (legacy mcpServers shape) still parses for round-trip", () => {
    const result = translateMcp.vsCodeToClaude(FIXTURE_VSCODE_LEGACY);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result?.content as string) as Record<string, unknown>;
    const servers = parsed.mcpServers as Record<string, { command: string }>;
    expect(servers.github.command).toBe("gh-mcp");
  });

  test("a remote-only Codex round-trip remains writable after VS Code inputs are dropped", () => {
    const vsToCodex = translateMcp.vsCodeToCodex(FIXTURE_VSCODE_REMOTE);
    const back = translateMcp.codexToVsCode((vsToCodex as { content: string }).content);
    expect(back).not.toBeNull();
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

  test("vscode → codex names and drops fields outside the verified Codex schema", () => {
    const withCustom = JSON.stringify({
      servers: {
        github: { type: "stdio", command: "gh-mcp", customMeta: { tier: "gold" } },
      },
    });
    const result = translateMcp.vsCodeToCodex(withCustom);
    expect(result?.content).not.toContain("customMeta");
    expect((result?.warnings ?? []).join("\n")).toContain('Server "github"');
    expect((result?.warnings ?? []).join("\n")).toContain("customMeta");
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
    // These legacy cross-target routes share the common mcpServers subset.
    // The source-aware OpenCode route covers Copilot's additional fields below.
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

    test("copilot → codex: emits TOML [mcp_servers]", () => {
      const result = translateMcp.copilotToCodex(COPILOT_FIXTURE);
      expect(result).not.toBeNull();
      expect(result?.content).toContain("[mcp_servers.playwright]");
    });
  });
});

describe("verified OpenCode, Codex, and VS Code MCP contracts", () => {
  test("OpenCode and Codex map only official fields with exact timeout units", () => {
    const openCode = JSON.stringify({
      mcp: {
        local: {
          type: "local",
          command: ["bunx", "server"],
          cwd: "/workspace",
          environment: { MODE: "test" },
          enabled: false,
          timeout: 1500,
        },
        remote: {
          type: "remote",
          url: "https://example.test/mcp",
          headers: { "X-Trace": "on" },
          enabled: true,
          timeout: 2000,
          oauth: { clientId: "public-client", scope: "read", callbackPort: 19876 },
        },
      },
    });

    const codex = translateMcp.openCodeToCodex(openCode);
    expect(codex?.content).toContain("[mcp_servers.local]");
    expect(codex?.content).toContain('cwd = "/workspace"');
    expect(codex?.content).toContain("tool_timeout_sec = 1.5");
    expect(codex?.content).toContain("[mcp_servers.remote.http_headers]");
    expect(codex?.content).toContain("[mcp_servers.remote.oauth]");
    expect(codex?.content).toContain('client_id = "public-client"');
    expect(codex?.content).toContain('scopes = [ "read" ]');
    expect((codex?.warnings ?? []).join("\n")).toContain('Server "remote"');
    expect((codex?.warnings ?? []).join("\n")).toContain("callbackPort");

    const roundTrip = translateMcp.codexToOpenCode(codex?.content ?? "");
    expect(roundTrip?.skipWrite).toBe(true);
    expect(roundTrip?.errors?.join("\n")).toContain("stdio environment isolation");
  });

  test("Codex remote source reads the official mcp_servers table", () => {
    const source = `[mcp_servers.remote]\nurl = "https://example.test/mcp"\nenabled = true\ntool_timeout_sec = 3\nbearer_token_env_var = "BEARER_TOKEN"\nscopes = ["read", "write"]\n\n[mcp_servers.remote.http_headers]\nX-Trace = "on"\n\n[mcp_servers.remote.env_http_headers]\nX-Token = "MCP_TOKEN"\n\n[mcp_servers.remote.oauth]\nclient_id = "public-client"\n`;
    const result = translateMcp.codexToOpenCode(source);
    const parsed = JSON.parse(result?.content ?? "{}") as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp.remote).toMatchObject({
      type: "remote",
      url: "https://example.test/mcp",
      headers: {
        "X-Trace": "on",
        "X-Token": "{env:MCP_TOKEN}",
        Authorization: "Bearer {env:BEARER_TOKEN}",
      },
      oauth: { clientId: "public-client", scope: "read write" },
      enabled: true,
      timeout: 3000,
    });
    expect(result?.warnings?.join("\n")).toContain("missing or empty variables");
  });

  test("Codex stdio servers fail closed because OpenCode inherits the full host environment", () => {
    const result = translateMcp.codexToOpenCode(
      '[mcp_servers.local]\ncommand = "node"\nargs = ["server.js"]\n',
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "local"');
    expect(result?.errors?.join("\n")).toContain("stdio environment isolation");
  });

  test.each([
    ["enabled_tools", 'enabled_tools = ["read"]'],
    ["disabled_tools", 'disabled_tools = ["delete"]'],
    ["default_tools_approval_mode", 'default_tools_approval_mode = "prompt"'],
    ["tools", '[mcp_servers.remote.tools.delete]\napproval_mode = "prompt"'],
    ["omit_tools_from", 'omit_tools_from = ["direct", "deferred", "code_mode"]'],
    ["auth", 'auth = "chatgpt"'],
    ["environment_id", 'environment_id = "executor-prod"'],
    ["oauth_resource", 'oauth_resource = "https://resource.example"'],
  ])("Codex MCP authority field %s fails closed for OpenCode", (field, authority) => {
    const result = translateMcp.codexToOpenCode(
      `[mcp_servers.remote]\nurl = "https://example.test/mcp"\n${authority}\n`,
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "remote"');
    expect(result?.errors?.join("\n")).toContain(field);
  });

  test.each([
    ["enabled_tools", 'enabled_tools = ["read"]'],
    ["disabled_tools", 'disabled_tools = ["delete"]'],
    ["default_tools_approval_mode", 'default_tools_approval_mode = "prompt"'],
    ["tools", '[mcp_servers.remote.tools.delete]\napproval_mode = "prompt"'],
    ["omit_tools_from", 'omit_tools_from = ["direct", "deferred", "code_mode"]'],
    ["auth", 'auth = "chatgpt"'],
    ["oauth_resource", 'oauth_resource = "https://resource.example"'],
    ["scopes", 'scopes = ["read"]'],
  ])("Codex MCP authority field %s fails closed for VS Code", (field, authority) => {
    const result = translateMcp.codexToVsCode(
      `[mcp_servers.remote]\nurl = "https://example.test/mcp"\n${authority}\n`,
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "remote"');
    expect(result?.errors?.join("\n")).toContain(field);
  });

  test.each([
    ["OpenCode", translateMcp.codexToOpenCode],
    ["VS Code", translateMcp.codexToVsCode],
  ])("explicit empty Codex OAuth scopes fail closed for %s", (_target, translator) => {
    const result = translator(
      '[mcp_servers.remote]\nurl = "https://example.test/mcp"\nscopes = []\n',
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("scopes");
  });

  test("Codex execution-environment boundaries fail closed for VS Code", () => {
    const stdio = translateMcp.codexToVsCode(
      '[mcp_servers.local]\ncommand = "node"\nargs = ["server.js"]\n',
    );
    expect(stdio?.skipWrite).toBe(true);
    expect(stdio?.errors?.join("\n")).toContain("stdio environment isolation");

    const remote = translateMcp.codexToVsCode(
      '[mcp_servers.remote]\nurl = "https://example.test/mcp"\nenvironment_id = "executor-prod"\n',
    );
    expect(remote?.skipWrite).toBe(true);
    expect(remote?.errors?.join("\n")).toContain("environment_id");
  });

  test("Codex local environment_id is representable in OpenCode", () => {
    const source =
      '[mcp_servers.remote]\nurl = "https://example.test/mcp"\nenvironment_id = "local"\n';
    const result = translateMcp.codexToOpenCode(source);
    expect(result?.errors).toBeUndefined();
    expect(JSON.parse(result?.content ?? "{}").mcp.remote.url).toBe("https://example.test/mcp");
    expect(translateMcp.codexToVsCode(source)?.warnings?.join("\n")).toContain("environment_id");
  });

  test("OpenCode environment-backed headers map to Codex native fields", () => {
    const result = translateMcp.openCodeToCodex(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: {
              "X-Trace": "on",
              "X-Token": "{env:MCP_TOKEN}",
              Authorization: "Bearer {env:BEARER_TOKEN}",
            },
          },
        },
      }),
    );

    expect(result?.content).toContain('bearer_token_env_var = "BEARER_TOKEN"');
    expect(result?.content).toContain("[mcp_servers.remote.http_headers]");
    expect(result?.content).toContain('X-Trace = "on"');
    expect(result?.content).toContain("[mcp_servers.remote.env_http_headers]");
    expect(result?.content).toContain('X-Token = "MCP_TOKEN"');
    expect(result?.content).not.toContain("{env:");
    expect(result?.warnings?.join("\n")).toContain("missing or empty variables");
  });

  test.each([
    ["file header", { headers: { "X-Token": "{file:token.txt}" } }],
    ["composite header", { headers: { "X-Token": "prefix {env:TOKEN}" } }],
    ["URL", { url: "https://example.test/{env:TOKEN}" }],
    ["OAuth clientId", { oauth: { clientId: "{env:CLIENT_ID}" } }],
  ])("OpenCode %s reference fails closed for Codex", (_field, override) => {
    const result = translateMcp.openCodeToCodex(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            ...override,
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("configuration-reference syntax");
  });

  test("OpenCode local field references fail closed for Codex", () => {
    const result = translateMcp.openCodeToCodex(
      JSON.stringify({
        mcp: { local: { type: "local", command: ["node", "{env:SCRIPT}"] } },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.errors?.join("\n")).toContain("configuration-reference syntax");
  });

  test("OpenCode environment references use VS Code variable syntax", () => {
    const result = translateMcp.openCodeToVsCode(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { "X-Token": "{env:MCP_TOKEN}" },
          },
        },
      }),
    );
    const parsed = JSON.parse(result?.content ?? "{}") as {
      servers: Record<string, { headers: Record<string, string> }>;
    };
    expect(parsed.servers.remote?.headers["X-Token"]).toBe("$" + "{env:MCP_TOKEN}");
  });

  test("OpenCode file references fail closed for VS Code", () => {
    const result = translateMcp.openCodeToVsCode(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { "X-Token": "{file:token.txt}" },
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.errors?.join("\n")).toContain("file-reference syntax");
  });

  test("VS Code JSONC comments and trailing commas migrate to OpenCode", () => {
    const result = translateMcp.vsCodeToOpenCode(`{
      // VS Code accepts JSONC here.
      "servers": {
        "local": { "type": "stdio", "command": "node", },
      },
    }`);
    expect(result?.errors).toBeUndefined();
    expect(JSON.parse(result?.content ?? "{}").mcp.local.command).toEqual(["node"]);
  });

  test.each([
    ["Claude", translateMcp.openCodeToClaude],
    ["Cursor", translateMcp.openCodeToCursor],
    ["Copilot", translateMcp.openCodeToCopilot],
    ["VS Code", translateMcp.openCodeToVsCode],
  ])("OpenCode disabled servers fail closed for %s", (_target, translator) => {
    const result = translator(
      JSON.stringify({
        mcp: { local: { type: "local", command: ["node", "server.js"], enabled: false } },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "local" is disabled');
    expect(result?.errors?.join("\n")).toContain("no verified disabled equivalent");
  });

  test("VS Code uses oauth and maps only compatible OAuth fields", () => {
    const source = JSON.stringify({
      servers: {
        remote: {
          type: "http",
          url: "https://example.test/mcp",
          oauth: { clientId: "public-client", enterpriseManaged: false },
        },
      },
    });
    const openCode = translateMcp.vsCodeToOpenCode(source);
    const parsed = JSON.parse(openCode?.content ?? "{}") as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp.remote.oauth).toEqual({ clientId: "public-client" });
    expect((openCode?.warnings ?? []).join("\n")).toContain("enterpriseManaged");

    const back = translateMcp.openCodeToVsCode(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            oauth: { clientId: "public-client", scope: "read", callbackPort: 19876 },
          },
        },
      }),
    );
    const vscode = JSON.parse(back?.content ?? "{}") as {
      servers: Record<string, Record<string, unknown>>;
    };
    expect(vscode.servers.remote.oauth).toEqual({ clientId: "public-client" });
    expect(vscode.servers.remote.auth).toBeUndefined();
    expect((back?.warnings ?? []).join("\n")).toContain("scope");
    expect((back?.warnings ?? []).join("\n")).toContain("callbackPort");
  });

  test.each([
    ["Codex", translateMcp.vsCodeToCodex],
    ["OpenCode", translateMcp.vsCodeToOpenCode],
  ])("VS Code enterprise-managed OAuth fails closed for %s", (_target, translator) => {
    const result = translator(
      JSON.stringify({
        servers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            oauth: { clientId: "public-client", enterpriseManaged: true },
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("enterprise-managed OAuth");
  });

  test.each([
    "scope",
    "clientSecret",
    "callbackPort",
    "redirectUri",
  ])("VS Code OAuth field %s fails closed instead of becoming active in OpenCode", (field) => {
    const result = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            oauth: { clientId: "public-client", [field]: field === "callbackPort" ? 19876 : "x" },
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "remote"');
    expect(result?.errors?.join("\n")).toContain(field);
  });

  test("VS Code sandboxed local servers fail closed for OpenCode", () => {
    const result = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers: {
          local: { type: "stdio", command: "node", sandboxEnabled: true },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "local"');
    expect(result?.errors?.join("\n")).toContain("requires a sandbox");
  });

  test("VS Code sandboxed local servers fail closed for Codex", () => {
    const result = translateMcp.vsCodeToCodex(
      JSON.stringify({
        servers: {
          local: { type: "stdio", command: "node", sandboxEnabled: true },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "local"');
    expect(result?.errors?.join("\n")).toContain("requires a sandbox");
  });

  test("VS Code environment variables map to OpenCode references in supported fields", () => {
    const result = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers: {
          local: {
            type: "stdio",
            command: vsCodeVariable("env:MCP_COMMAND"),
            args: [`--token=${vsCodeVariable("env:MCP_TOKEN")}`],
            cwd: `${vsCodeVariable("env:MCP_ROOT")}/server`,
            env: { TOKEN: vsCodeVariable("env:MCP_TOKEN") },
          },
          remote: {
            type: "http",
            url: vsCodeVariable("env:MCP_URL"),
            headers: { Authorization: `Bearer ${vsCodeVariable("env:MCP_TOKEN")}` },
          },
        },
      }),
    );
    const parsed = JSON.parse(result?.content ?? "{}") as {
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(parsed.mcp.local).toMatchObject({
      command: ["{env:MCP_COMMAND}", "--token={env:MCP_TOKEN}"],
      cwd: "{env:MCP_ROOT}/server",
      environment: { TOKEN: "{env:MCP_TOKEN}" },
    });
    expect(parsed.mcp.remote).toMatchObject({
      url: "{env:MCP_URL}",
      headers: { Authorization: "Bearer {env:MCP_TOKEN}" },
    });
  });

  test.each([
    ["cwd", { type: "stdio", command: "node", cwd: vsCodeVariable("workspaceFolder") }],
    ["env", { type: "stdio", command: "node", env: { TOKEN: vsCodeVariable("input:token") } }],
    [
      "headers",
      {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: `Bearer ${vsCodeVariable("command:secret")}` },
      },
    ],
    [
      "header key",
      {
        type: "http",
        url: "https://example.test/mcp",
        headers: { [vsCodeVariable("env:HEADER_NAME")]: "present" },
      },
    ],
  ])("unsupported VS Code variable in %s fails closed for OpenCode", (_field, server) => {
    const result = translateMcp.vsCodeToOpenCode(
      JSON.stringify({ servers: { configured: server } }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "configured"');
    expect(result?.errors?.join("\n")).toContain("no verified OpenCode equivalent");
  });

  test("canonical Copilot MCP fields are parsed before OpenCode authority checks", () => {
    const local = translateMcp.copilotToOpenCode(
      JSON.stringify({
        mcpServers: {
          local: { type: "local", command: "node", tools: ["*"], timeout: 3000 },
        },
      }),
    );
    expect(local?.skipWrite).toBe(true);
    expect(local?.errors?.join("\n")).toContain("Copilot stdio environment isolation");

    for (const type of ["http", "streamable-http"]) {
      const remote = translateMcp.copilotToOpenCode(
        JSON.stringify({
          mcpServers: {
            remote: {
              type,
              url: "https://example.test/mcp",
              tools: ["*"],
              timeout: 3000,
            },
          },
        }),
      );
      expect(JSON.parse(remote?.content ?? "{}").mcp.remote).toMatchObject({
        type: "remote",
        url: "https://example.test/mcp",
        timeout: 3000,
      });
    }

    for (const tools of [undefined, [], ["read"], "*"]) {
      const restricted = translateMcp.copilotToOpenCode(
        JSON.stringify({
          mcpServers: {
            remote: { type: "http", url: "https://example.test/mcp", tools },
          },
        }),
      );
      expect(restricted?.skipWrite).toBe(true);
      expect(restricted?.errors?.join("\n")).toContain("tools");
    }
  });

  test("Copilot remote header variables map to OpenCode environment references", () => {
    const result = translateMcp.copilotToOpenCode(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: {
              Authorization: "Bearer $COPILOT_TOKEN",
              "X-Account": ["$", "{COPILOT_ACCOUNT}"].join(""),
            },
            tools: ["*"],
          },
        },
      }),
    );
    expect(JSON.parse(result?.content ?? "{}").mcp.remote.headers).toEqual({
      Authorization: "Bearer {env:COPILOT_TOKEN}",
      "X-Account": "{env:COPILOT_ACCOUNT}",
    });
  });

  test("Copilot remote header defaults fail closed for OpenCode", () => {
    const result = translateMcp.copilotToOpenCode(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { Authorization: ["Bearer $", "{COPILOT_TOKEN:-fallback}"].join("") },
            tools: ["*"],
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("environment default");
  });

  test.each([
    ["implicit defaults", {}],
    [
      "explicit defaults",
      {
        oauthPublicClient: true,
        oauthGrantType: "authorization_code",
        oidc: false,
      },
    ],
  ])("Copilot public authorization-code OAuth with %s maps to OpenCode", (_name, defaults) => {
    const result = translateMcp.copilotToOpenCode(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            tools: ["*"],
            oauthClientId: "public-client",
            ...defaults,
          },
        },
      }),
    );
    expect(result?.errors).toBeUndefined();
    expect(JSON.parse(result?.content ?? "{}").mcp.remote.oauth).toEqual({
      clientId: "public-client",
    });
    expect(result?.warnings?.join("\n") ?? "").not.toContain("oauthClientId");
  });

  test.each([
    ["oauthPublicClient", false],
    ["oauthGrantType", "client_credentials"],
    ["oidc", true],
  ])("Copilot remote authority field %s fails closed for OpenCode", (field, value) => {
    const result = translateMcp.copilotToOpenCode(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            tools: ["*"],
            [field]: value,
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.errors?.join("\n")).toContain(field);
  });

  test.each([
    ["oauthClientId", ""],
    ["oauthPublicClient", "true"],
    ["oauthGrantType", "invalid"],
    ["oidc", "false"],
    ["oauth", { clientId: "inert-copilot-field" }],
  ])("invalid Copilot OAuth field %s cannot become active in OpenCode", (field, value) => {
    const result = translateMcp.copilotToOpenCode(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            tools: ["*"],
            [field]: value,
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.errors?.join("\n")).toContain(field);
  });

  test.each([
    [
      "command",
      translateMcp.claudeToOpenCode,
      { mcpServers: { local: { command: "{env:TOP_SECRET}" } } },
    ],
    [
      "server name",
      translateMcp.claudeToOpenCode,
      { mcpServers: { "{env:TOP_SECRET}": { command: "node" } } },
    ],
    [
      "argument",
      translateMcp.claudeToOpenCode,
      { mcpServers: { local: { command: "node", args: ["{env:TOP_SECRET}"] } } },
    ],
    [
      "cwd",
      translateMcp.claudeToOpenCode,
      { mcpServers: { local: { command: "node", cwd: "{file:TOP_SECRET}" } } },
    ],
    [
      "environment",
      translateMcp.claudeToOpenCode,
      { mcpServers: { local: { command: "node", env: { TOKEN: "{file:TOP_SECRET}" } } } },
    ],
    [
      "environment name",
      translateMcp.claudeToOpenCode,
      { mcpServers: { local: { command: "node", env: { "{env:TOP_SECRET}": "present" } } } },
    ],
    [
      "URL",
      translateMcp.vsCodeToOpenCode,
      { servers: { remote: { type: "http", url: "https://example.test/{env:TOP_SECRET}" } } },
    ],
    [
      "header",
      translateMcp.vsCodeToOpenCode,
      {
        servers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { "X-Token": "{file:TOP_SECRET}" },
          },
        },
      },
    ],
    [
      "header name",
      translateMcp.vsCodeToOpenCode,
      {
        servers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: { "{file:TOP_SECRET}": "present" },
          },
        },
      },
    ],
  ])("non-OpenCode %s references cannot become active OpenCode substitutions", (_field, translator, source) => {
    const result = translator(JSON.stringify(source));
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("configuration-reference syntax");
    expect(result?.errors?.join("\n")).not.toContain("TOP_SECRET");
  });

  test.each([
    "{env:HEADER_NAME}",
    "{file:../../private-key}",
  ])("Codex dynamic header key %s cannot activate OpenCode substitution", (headerName) => {
    const result = translateMcp.codexToOpenCode(`[mcp_servers.remote]
url = "https://example.test/mcp"

[mcp_servers.remote.env_http_headers]
"${headerName}" = "TOKEN"
`);
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("configuration-reference syntax");
    expect(result?.errors?.join("\n")).not.toContain(headerName);
  });

  test.each([
    ["Codex", translateMcp.openCodeToCodex],
    ["Copilot", translateMcp.openCodeToCopilot],
    ["VS Code", translateMcp.openCodeToVsCode],
  ])("OpenCode referenced header names fail closed for %s", (_target, translator) => {
    const result = translator(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { "{env:HEADER_NAME}": "present" },
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("configuration-reference syntax");
  });

  test("OpenCode remote servers map to canonical Copilot MCP fields", () => {
    const result = translateMcp.openCodeToCopilot(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { "X-Token": "Bearer {env:MCP_TOKEN}" },
            oauth: { clientId: "public-client" },
            enabled: true,
            timeout: 3000,
          },
        },
      }),
    );
    expect(result?.errors).toBeUndefined();
    expect(JSON.parse(result?.content ?? "{}").mcpServers.remote).toEqual({
      type: "http",
      url: "https://example.test/mcp",
      headers: { "X-Token": ["Bearer $", "{MCP_TOKEN}"].join("") },
      tools: ["*"],
      timeout: 3000,
      oauthClientId: "public-client",
    });
    expect(result?.warnings?.join("\n")).toContain("enabled");
    expect(result?.warnings?.join("\n")).toContain("HTTP-to-SSE fallback");
  });

  test("OpenCode local servers fail closed for Copilot environment isolation", () => {
    const result = translateMcp.openCodeToCopilot(
      JSON.stringify({
        mcp: { local: { type: "local", command: ["node"] } },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("stdio environment inheritance");
  });

  test.each([
    ["file reference", "Bearer {file:token.txt}"],
    ["inert Copilot variable", "Bearer $COPILOT_TOKEN"],
  ])("OpenCode header %s fails closed for Copilot", (_caseName, value) => {
    const result = translateMcp.openCodeToCopilot(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            headers: { Authorization: value },
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).not.toContain(value);
  });

  test("OpenCode OAuth fields without a Copilot equivalent fail closed", () => {
    const result = translateMcp.openCodeToCopilot(
      JSON.stringify({
        mcp: {
          remote: {
            type: "remote",
            url: "https://example.test/mcp",
            oauth: { clientId: "public-client", scope: "read" },
          },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain("scope");
  });

  test.each([
    ["Codex", translateMcp.openCodeToCodex],
    ["Copilot", translateMcp.openCodeToCopilot],
  ])("OpenCode oauth false fails closed for %s", (_target, translator) => {
    const result = translator(
      JSON.stringify({
        mcp: {
          remote: { type: "remote", url: "https://example.test/mcp", oauth: false },
        },
      }),
    );
    expect(result?.skipWrite).toBe(true);
    expect(result?.content).toBe("");
    expect(result?.errors?.join("\n")).toContain('Server "remote"');
    expect(result?.errors?.join("\n")).toContain("no verified no-OAuth equivalent");
  });

  test("oauth false is preserved for OpenCode and fails closed for VS Code", () => {
    const vscode = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers: {
          remote: {
            type: "http",
            url: "https://example.test/mcp",
            oauth: { clientId: "public-client" },
          },
        },
      }),
    );
    expect(JSON.parse(vscode?.content ?? "{}").mcp.remote.oauth).toEqual({
      clientId: "public-client",
    });

    const openCode = translateMcp.openCodeToVsCode(
      JSON.stringify({
        mcp: {
          remote: { type: "remote", url: "https://example.test/mcp", oauth: false },
        },
      }),
    );
    expect(openCode?.skipWrite).toBe(true);
    expect(openCode?.content).toBe("");
    expect(openCode?.errors?.join("\n")).toContain("no verified no-OAuth equivalent");
  });

  test.each([
    ["bad-local", { type: "local", command: [] }, "requires a non-empty executable"],
    ["bad-remote", { type: "remote", url: 42 }, "remote url must be a non-empty string"],
    ["bad-timeout", { type: "local", command: ["node"], timeout: 0 }, "positive integer"],
    [
      "bad-oauth-type",
      { type: "remote", url: "https://example.test", oauth: true },
      "oauth must be false or an object",
    ],
    [
      "bad-oauth-port",
      {
        type: "remote",
        url: "https://example.test",
        oauth: { callbackPort: 65536 },
      },
      "oauth.callbackPort must be an integer from 1 to 65535",
    ],
    ["enabled-only", { enabled: false }, "enabled-only OpenCode MCP entry"],
    ["unknown-type", { type: "socket" }, 'type must be "local" or "remote"'],
  ])("malformed OpenCode server %s fails closed with its name", (name, server, message) => {
    const result = translateMcp.openCodeToCodex(JSON.stringify({ mcp: { [name]: server } }));
    expect(result?.skipWrite).toBe(true);
    expect(result?.errors?.join("\n")).toContain(`Server "${name}"`);
    expect(result?.errors?.join("\n")).toContain(message);
  });

  test("OpenCode local MCP preserves an empty argument", () => {
    const result = translateMcp.openCodeToCodex(
      JSON.stringify({ mcp: { local: { type: "local", command: ["node", ""] } } }),
    );
    expect(result?.errors).toBeUndefined();
    expect(result?.content).toMatch(/args = \[\s*""\s*\]/);
  });

  test("invalid target timeout and OAuth fail closed with the server name", () => {
    const timeout = translateMcp.claudeToOpenCode(
      JSON.stringify({ mcpServers: { bad: { command: "node", timeout: 1.5 } } }),
    );
    expect(timeout?.errors?.join("\n")).toContain('Server "bad"');
    expect(timeout?.errors?.join("\n")).toContain("positive integer");

    const oauth = translateMcp.vsCodeToOpenCode(
      JSON.stringify({
        servers: {
          bad: {
            type: "http",
            url: "https://example.test",
            oauth: { clientId: "public-client", enterpriseManaged: "yes" },
          },
        },
      }),
    );
    expect(oauth?.errors?.join("\n")).toContain('Server "bad"');
    expect(oauth?.errors?.join("\n")).toContain("enterpriseManaged must be a boolean");
  });
});
