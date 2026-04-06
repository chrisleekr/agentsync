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
