/**
 * Tests for src/migrate/migrate.ts — the migration orchestrator.
 * Uses temp directories with mocked AgentPaths to test reading,
 * translation, secret detection, and write behaviour.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import * as TOML from "@iarna/toml";
import { AgentPaths } from "../../config/paths";
import { applyMigrated, performMigrate, readSourceArtefacts } from "../migrate";

// Re-install the real node:fs/promises in bun's module cache. Several test
// files (claude.test.ts, packaging.test.ts, status.test.ts and friends) stub
// fs/promises at top level and bun's `mock.restore()` is a no-op for
// `mock.module()`, so their stubs leak into every later file in the same bun
// test run. This block is the defensive undo, ordering-independent so a
// readdir order that runs a stubbing file before this one cannot break it.
{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => ({ ...realFsPromises, default: realFsPromises }));
}

// ── Mutable path references for testing ──────────────────────────────────────

type MutablePaths<K extends keyof typeof AgentPaths> = {
  -readonly [P in keyof (typeof AgentPaths)[K]]: (typeof AgentPaths)[K][P];
};

const testClaude = AgentPaths.claude as MutablePaths<"claude">;
const testCursor = AgentPaths.cursor as MutablePaths<"cursor">;
const testCodex = AgentPaths.codex as MutablePaths<"codex">;
const testCopilot = AgentPaths.copilot as MutablePaths<"copilot">;
const testVscode = AgentPaths.vscode as MutablePaths<"vscode">;
const testOpenCode = AgentPaths.opencode as MutablePaths<"opencode">;
const OPEN_CODE_ENV_KEYS = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DISABLE_EXTERNAL_SKILLS",
  "OPENCODE_DISABLE_CLAUDE_CODE",
  "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
] as const;

let tmpDir: string;
let origClaude: typeof AgentPaths.claude;
let origCursor: typeof AgentPaths.cursor;
let origCodex: typeof AgentPaths.codex;
let origCopilot: typeof AgentPaths.copilot;
let origVscode: typeof AgentPaths.vscode;
let origOpenCode: typeof AgentPaths.opencode;
let origOpenCodeEnvironment: Record<string, string | undefined>;
let cursorAgentsDir: string;
let codexAgentsDir: string;
let sharedAgentsDir: string;
let openCodeAgentsDir: string;

beforeEach(() => {
  tmpDir = join(
    realpathSync(tmpdir()),
    `migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpDir, { recursive: true });

  // Save originals
  origClaude = { ...AgentPaths.claude };
  origCursor = { ...AgentPaths.cursor };
  origCodex = { ...AgentPaths.codex };
  origCopilot = { ...AgentPaths.copilot };
  origVscode = { ...AgentPaths.vscode };
  origOpenCode = { ...AgentPaths.opencode };
  origOpenCodeEnvironment = Object.fromEntries(
    OPEN_CODE_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of OPEN_CODE_ENV_KEYS) delete process.env[key];

  // Redirect all agent paths to temp directory
  testClaude.claudeMd = join(tmpDir, "claude", "CLAUDE.md");
  testClaude.mcpJson = join(tmpDir, "claude", ".claude.json");
  testClaude.commandsDir = join(tmpDir, "claude", "commands");
  testClaude.agentsDir = join(tmpDir, "claude", "agents");
  testClaude.settingsJson = join(tmpDir, "claude", "settings.json");
  testClaude.skillsDir = join(tmpDir, "claude", "skills");
  testClaude.rulesDir = join(tmpDir, "claude", "rules");

  testCursor.settingsJson = join(tmpDir, "cursor", "settings.json");
  testCursor.mcpGlobal = join(tmpDir, "cursor", "mcp.json");
  testCursor.commandsDir = join(tmpDir, "cursor", "commands");
  testCursor.skillsDir = join(tmpDir, "cursor", "skills");
  testCursor.rulesDir = join(tmpDir, "cursor", "rules");
  cursorAgentsDir = join(tmpDir, "cursor", "agents");
  testCursor.agentsDir = cursorAgentsDir;

  testCodex.agentsMd = join(tmpDir, "codex", "AGENTS.md");
  testCodex.configToml = join(tmpDir, "codex", "config.toml");
  testCodex.rulesDir = join(tmpDir, "codex", "rules");
  testCodex.skillsDir = join(tmpDir, "codex", "skills");
  testCodex.userSkillsDir = join(tmpDir, "agents", "skills");
  codexAgentsDir = join(tmpDir, "codex", "agents");
  testCodex.agentsDir = codexAgentsDir;

  testCopilot.instructionsFile = join(tmpDir, "copilot", "instructions");
  testCopilot.promptsDir = join(tmpDir, "copilot", "prompts");
  testCopilot.skillsDir = join(tmpDir, "copilot", "skills");
  testCopilot.mcpConfigJson = join(tmpDir, "copilot", "mcp-config.json");
  sharedAgentsDir = join(tmpDir, "copilot", "agents");
  testCopilot.agentsDir = sharedAgentsDir;

  testVscode.mcpJson = join(tmpDir, "vscode", "mcp.json");
  testVscode.agentsDir = sharedAgentsDir;

  const openCodeDefaultDir = join(tmpDir, "opencode-default");
  const openCodeOverrideDir = join(tmpDir, "opencode-override");
  testOpenCode.configDir = openCodeDefaultDir;
  process.env.OPENCODE_CONFIG_DIR = openCodeOverrideDir;
  openCodeAgentsDir = join(openCodeOverrideDir, "agents");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  // Restore originals
  Object.assign(testClaude, origClaude);
  Object.assign(testCursor, origCursor);
  Object.assign(testCodex, origCodex);
  Object.assign(testCopilot, origCopilot);
  Object.assign(testVscode, origVscode);
  Object.assign(testOpenCode, origOpenCode);
  for (const key of OPEN_CODE_ENV_KEYS) {
    const value = origOpenCodeEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeFixture(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function claudeAgent(name: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: Reviews code${extra}\n---\n\nReview code.`;
}

function cursorAgent(name?: string): string {
  const nameField = name ? `name: ${name}\n` : "";
  return `---\n${nameField}description: Reviews code\n---\n\nReview code.`;
}

function codexAgent(name: string): string {
  return `name = ${JSON.stringify(name)}\ndescription = "Reviews code"\ndeveloper_instructions = "Review code."`;
}

function sharedAgent(name: string, target?: "vscode" | "github-copilot"): string {
  const targetField = target ? `target: ${target}\n` : "";
  return `---\nname: ${name}\ndescription: Reviews code\n${targetField}---\n\nReview code.`;
}

function agentFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  expect(match).not.toBeNull();
  return Bun.YAML.parse(match?.[1] ?? "") as Record<string, unknown>;
}

// ── readSourceArtefacts ──────────────────────────────────────────────────────

describe("readSourceArtefacts", () => {
  test("reads claude global-rules from CLAUDE.md", async () => {
    writeFixture(testClaude.claudeMd, "# My Rules");
    const result = await readSourceArtefacts("claude", "global-rules");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("# My Rules");
  });

  test("reads cursor global-rules from settings.json inline", async () => {
    writeFixture(testCursor.settingsJson, JSON.stringify({ rules: "Be helpful.", other: true }));
    const result = await readSourceArtefacts("cursor", "global-rules");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Be helpful.");
    expect(result[0].name).toBe("__cursor_rules__");
  });

  test("reads claude MCP from .claude.json", async () => {
    writeFixture(testClaude.mcpJson, JSON.stringify({ mcpServers: { gh: { command: "gh-mcp" } } }));
    const result = await readSourceArtefacts("claude", "mcp");
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain("gh-mcp");
  });

  test("reads commands from directory", async () => {
    mkdirSync(testClaude.commandsDir, { recursive: true });
    writeFileSync(join(testClaude.commandsDir, "review.md"), "# Review");
    writeFileSync(join(testClaude.commandsDir, "lint.md"), "# Lint");
    const result = await readSourceArtefacts("claude", "commands");
    expect(result).toHaveLength(2);
  });

  test("filterName restricts to single command", async () => {
    mkdirSync(testClaude.commandsDir, { recursive: true });
    writeFileSync(join(testClaude.commandsDir, "review.md"), "# Review");
    writeFileSync(join(testClaude.commandsDir, "lint.md"), "# Lint");
    const result = await readSourceArtefacts("claude", "commands", "review.md");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("review.md");
  });

  test("returns empty for missing source files", async () => {
    const result = await readSourceArtefacts("claude", "global-rules");
    expect(result).toHaveLength(0);
  });

  test("returns empty for vscode global-rules (unsupported)", async () => {
    const result = await readSourceArtefacts("vscode", "global-rules");
    expect(result).toHaveLength(0);
  });

  test("C2 recursively reads Claude agents by source-relative filename", async () => {
    writeFixture(join(testClaude.agentsDir, "root.md"), claudeAgent("root"));
    writeFixture(
      join(testClaude.agentsDir, "teams", "security-reviewer.md"),
      claudeAgent("security-reviewer"),
    );

    const result = await readSourceArtefacts("claude", "agents");
    expect(result.map(({ name }) => name).sort()).toEqual([
      "root.md",
      "teams/security-reviewer.md",
    ]);
    expect(result.find(({ name }) => name.includes("security"))?.sourcePath).toBe(
      join(testClaude.agentsDir, "teams", "security-reviewer.md"),
    );
  });

  test("C2 keeps exact source-relative --name matching for nested Claude agents", async () => {
    writeFixture(join(testClaude.agentsDir, "reviewer.md"), claudeAgent("root-reviewer"));
    writeFixture(join(testClaude.agentsDir, "teams", "reviewer.md"), claudeAgent("team-reviewer"));

    const result = await readSourceArtefacts("claude", "agents", "teams/reviewer.md");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("teams/reviewer.md");
    expect(result[0]?.content).toContain("name: team-reviewer");
  });

  test("C2 reads only documented direct-child extensions outside Claude", async () => {
    writeFixture(join(cursorAgentsDir, "cursor-reviewer.md"), cursorAgent());
    writeFixture(join(cursorAgentsDir, "nested", "ignored.md"), cursorAgent());
    writeFixture(join(cursorAgentsDir, "ignored.txt"), "ignore");

    writeFixture(join(codexAgentsDir, "codex-reviewer.toml"), codexAgent("codex_reviewer"));
    writeFixture(join(codexAgentsDir, "nested", "ignored.toml"), codexAgent("ignored"));
    writeFixture(join(codexAgentsDir, "ignored.md"), "ignore");

    writeFixture(join(sharedAgentsDir, "shared-reviewer.agent.md"), sharedAgent("shared-reviewer"));
    writeFixture(join(sharedAgentsDir, "nested", "ignored.agent.md"), sharedAgent("ignored"));
    writeFixture(join(sharedAgentsDir, "ignored.md"), "ignore");

    expect((await readSourceArtefacts("cursor", "agents")).map(({ name }) => name)).toEqual([
      "cursor-reviewer.md",
    ]);
    expect((await readSourceArtefacts("codex", "agents")).map(({ name }) => name)).toEqual([
      "codex-reviewer.toml",
    ]);
    expect((await readSourceArtefacts("copilot", "agents")).map(({ name }) => name)).toEqual([
      "shared-reviewer.agent.md",
    ]);
  });

  test("C2 excludes hidden segments, symlinks, and non-files", async () => {
    const validPath = join(testClaude.agentsDir, "valid.md");
    writeFixture(validPath, claudeAgent("valid"));
    writeFixture(join(testClaude.agentsDir, ".hidden.md"), claudeAgent("hidden"));
    writeFixture(join(testClaude.agentsDir, ".private", "hidden.md"), claudeAgent("hidden"));
    mkdirSync(join(testClaude.agentsDir, "directory.md"), { recursive: true });
    symlinkSync(validPath, join(testClaude.agentsDir, "linked.md"));

    const result = await readSourceArtefacts("claude", "agents");
    expect(result.map(({ name }) => name)).toEqual(["valid.md"]);
  });

  test("C2 and C6 filter the shared store by logical target", async () => {
    writeFixture(join(sharedAgentsDir, "both.agent.md"), sharedAgent("both"));
    writeFixture(join(sharedAgentsDir, "cli.agent.md"), sharedAgent("cli", "github-copilot"));
    writeFixture(join(sharedAgentsDir, "ide.agent.md"), sharedAgent("ide", "vscode"));

    expect((await readSourceArtefacts("copilot", "agents")).map(({ name }) => name).sort()).toEqual(
      ["both.agent.md", "cli.agent.md"],
    );
    expect((await readSourceArtefacts("vscode", "agents")).map(({ name }) => name).sort()).toEqual([
      "both.agent.md",
      "ide.agent.md",
    ]);
  });
});

// ── performMigrate ───────────────────────────────────────────────────────────

describe("performMigrate", () => {
  test("migrates claude global-rules to cursor", async () => {
    writeFixture(testClaude.claudeMd, "# My Rules\n\nBe concise.");
    writeFixture(testCursor.settingsJson, JSON.stringify({}));

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "global-rules",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].targetPath).toBe(testCursor.settingsJson);
  });

  test("migrates cursor global-rules to claude (writes CLAUDE.md, leaves source untouched)", async () => {
    const cursorRulesBody = "Be concise.\nNo emojis.";
    writeFixture(
      testCursor.settingsJson,
      JSON.stringify({ rules: cursorRulesBody, otherSetting: "keep-me" }),
    );

    const result = await performMigrate({
      from: "cursor",
      to: "claude",
      type: "global-rules",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].targetPath).toBe(testClaude.claudeMd);

    const { readIfExists } = await import("../../agents/_utils");
    const claudeMd = await readIfExists(testClaude.claudeMd);
    expect(claudeMd).toContain("migrated from Cursor");
    expect(claudeMd).toContain(cursorRulesBody);

    // Regression guard: prior version routed this migration back to
    // cursor's settings.json. The `rules` field and sibling settings
    // must both be preserved exactly.
    const cursorRaw = await readIfExists(testCursor.settingsJson);
    expect(cursorRaw).not.toBeNull();
    const cursor = JSON.parse(cursorRaw as string);
    expect(cursor.rules).toBe(cursorRulesBody);
    expect(cursor.otherSetting).toBe("keep-me");
  });

  test("applyMigrated ignores cursor-rules sentinel when target is not cursor", async () => {
    // Defense in depth: even if a translator returns the sentinel for a
    // non-cursor target, applyMigrated must route the write to the declared
    // target agent's file, not cursor's settings.json.
    writeFixture(testCursor.settingsJson, JSON.stringify({ rules: "untouched-cursor-rules" }));

    const artifact = await applyMigrated(
      "claude",
      "global-rules",
      "__cursor_rules__",
      "# Rules\n\nbody\n",
      false,
    );

    expect(artifact).not.toBeNull();
    expect(artifact?.targetPath).toBe(testClaude.claudeMd);

    const { readIfExists } = await import("../../agents/_utils");
    const claudeMd = await readIfExists(testClaude.claudeMd);
    expect(claudeMd).toContain("body");

    const cursorRaw = await readIfExists(testCursor.settingsJson);
    const cursor = JSON.parse(cursorRaw as string);
    expect(cursor.rules).toBe("untouched-cursor-rules");
  });

  test("migrates claude MCP to codex (JSON → TOML)", async () => {
    writeFixture(
      testClaude.mcpJson,
      JSON.stringify({
        mcpServers: { gh: { command: "gh-mcp", args: [], env: {} } },
      }),
    );

    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].targetPath).toBe(testCodex.configToml);
  });

  test("dry-run does not write files", async () => {
    writeFixture(testClaude.claudeMd, "# Rules");

    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "global-rules",
      dryRun: true,
    });

    expect(result.migrated).toHaveLength(1);
    // Target file should NOT exist
    const { readIfExists } = await import("../../agents/_utils");
    const written = await readIfExists(testCodex.agentsMd);
    expect(written).toBeNull();
  });

  test("type filtering only migrates specified type", async () => {
    writeFixture(testClaude.claudeMd, "# Rules");
    writeFixture(testClaude.mcpJson, JSON.stringify({ mcpServers: { gh: { command: "gh" } } }));

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "mcp",
      dryRun: true,
    });

    // Should only have MCP artefact, not global-rules
    for (const m of result.migrated) {
      expect(m.description).toContain("MCP");
    }
  });

  test("--to all expands to all agents except source", async () => {
    writeFixture(testClaude.claudeMd, "# Rules");

    const result = await performMigrate({
      from: "claude",
      to: "all",
      type: "global-rules",
      dryRun: true,
    });

    // Claude has global-rules translators to cursor, codex, copilot, and OpenCode.
    const migratedTargets = result.migrated.map((m) => m.description);
    expect(migratedTargets.some((d) => d.includes("cursor"))).toBe(true);
    expect(migratedTargets.some((d) => d.includes("codex"))).toBe(true);
    expect(migratedTargets.some((d) => d.includes("copilot"))).toBe(true);
    expect(migratedTargets.some((d) => d.includes("opencode"))).toBe(true);
    // vscode should be skipped
    const vsSkip = result.skipped.find(
      (s) => s.pair.to === "vscode" && s.pair.type === "global-rules",
    );
    expect(vsSkip).toBeDefined();
  });

  test("aborts on detected secret in MCP content", async () => {
    writeFixture(
      testClaude.mcpJson,
      JSON.stringify({
        mcpServers: {
          gh: {
            command: "gh-mcp",
            args: [],
            env: { TOKEN: "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" },
          },
        },
      }),
    );

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("aborted for security");
    expect(result.migrated).toHaveLength(0);
  });

  test("MCP per-server merge preserves target-only servers", async () => {
    writeFixture(
      testClaude.mcpJson,
      JSON.stringify({
        mcpServers: { gh: { command: "gh-mcp", args: [], env: {} } },
      }),
    );
    writeFixture(
      testCursor.mcpGlobal,
      JSON.stringify({
        mcpServers: { slack: { command: "slack-mcp", args: [], env: {} } },
      }),
    );

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    const { readIfExists } = await import("../../agents/_utils");
    const written = await readIfExists(testCursor.mcpGlobal);
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written as string);
    expect(parsed.mcpServers.gh).toBeDefined();
    expect(parsed.mcpServers.slack).toBeDefined();
  });

  test("Codex MCP merge preserves unrelated TOML and target-only servers", async () => {
    writeFixture(
      testClaude.mcpJson,
      JSON.stringify({
        mcpServers: {
          gh: { command: "new-gh-mcp", args: ["serve"], env: { SOURCE: "incoming" } },
        },
      }),
    );
    writeFixture(
      testCodex.configToml,
      [
        "[features]",
        "experimental = true",
        "",
        "[mcp_servers.slack]",
        'command = "slack-mcp"',
        "",
        "[mcp_servers.gh]",
        'command = "old-gh-mcp"',
        "",
      ].join("\n"),
    );

    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    const { readIfExists } = await import("../../agents/_utils");
    const written = await readIfExists(testCodex.configToml);
    expect(written).not.toBeNull();
    const parsed = TOML.parse(written as string) as TOML.JsonMap;
    expect((parsed.features as TOML.JsonMap).experimental).toBe(true);
    const servers = parsed.mcp_servers as TOML.JsonMap;
    expect((servers.slack as TOML.JsonMap).command).toBe("slack-mcp");
    expect((servers.gh as TOML.JsonMap).command).toBe("new-gh-mcp");
    expect((servers.gh as TOML.JsonMap).args).toEqual(["serve"]);
    expect((servers.gh as TOML.JsonMap).env).toEqual({ SOURCE: "incoming" });
  });

  test("MCP merge preserves JSONC comments and unrelated state in ~/.claude.json", async () => {
    // Source brings one server in.
    writeFixture(
      testCursor.mcpGlobal,
      JSON.stringify({ mcpServers: { slack: { command: "slack-mcp", args: [], env: {} } } }),
    );
    // Target ~/.claude.json carries a comment, a trailing comma, and
    // system-managed state Claude Code owns. A strict JSON.parse throws on the
    // comment; the old bare catch then overwrote the whole file with just
    // mcpServers, destroying trackedFileBackups/projects silently.
    writeFixture(
      testClaude.mcpJson,
      `{
  // user comment that strict JSON.parse rejects
  "trackedFileBackups": { "a.txt": "deadbeef" },
  "projects": { "/home/u/proj": { "lastUsed": 1 } },
  "mcpServers": { "gh": { "command": "gh-mcp", "args": [], "env": {} } },
}`,
    );

    const result = await performMigrate({
      from: "cursor",
      to: "claude",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    const { readIfExists } = await import("../../agents/_utils");
    const written = (await readIfExists(testClaude.mcpJson)) as string;
    // Unrelated state and the user's comment must survive the in-place edit.
    expect(written).toContain("trackedFileBackups");
    expect(written).toContain("projects");
    expect(written).toContain("user comment");
    // Servers merged: source slack added, existing gh kept.
    const { parse: parseJsonc } = await import("jsonc-parser");
    const parsed = parseJsonc(written, [], { allowTrailingComma: true }) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.gh).toBeDefined();
    expect(parsed.mcpServers.slack).toBeDefined();
  });

  test("MCP merge preserves JSONC comments and existing inputs in VS Code mcp.json", async () => {
    writeFixture(
      testClaude.mcpJson,
      JSON.stringify({ mcpServers: { slack: { command: "slack-mcp", args: [], env: {} } } }),
    );
    // VS Code mcp.json is settings-style JSONC: comment + an existing input.
    writeFixture(
      testVscode.mcpJson,
      `{
  // vscode user comment
  "servers": { "gh": { "command": "gh-mcp" } },
  "inputs": [{ "id": "token", "type": "promptString" }],
}`,
    );

    const result = await performMigrate({
      from: "claude",
      to: "vscode",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    const { readIfExists } = await import("../../agents/_utils");
    const written = (await readIfExists(testVscode.mcpJson)) as string;
    expect(written).toContain("vscode user comment");
    const { parse: parseJsonc } = await import("jsonc-parser");
    const parsed = parseJsonc(written, [], { allowTrailingComma: true }) as {
      servers: Record<string, unknown>;
      inputs: Array<{ id?: string }>;
    };
    expect(parsed.servers.gh).toBeDefined();
    expect(parsed.servers.slack).toBeDefined();
    // The existing input must not be dropped.
    expect(parsed.inputs.some((i) => i.id === "token")).toBeTrue();
  });

  test("reports skip for missing source files", async () => {
    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "global-rules",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0].reason).toContain("No source");
  });

  test("--name filters to single command artefact", async () => {
    mkdirSync(testClaude.commandsDir, { recursive: true });
    writeFileSync(join(testClaude.commandsDir, "review.md"), "# Review");
    writeFileSync(join(testClaude.commandsDir, "lint.md"), "# Lint");

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "commands",
      name: "review.md",
      dryRun: true,
    });

    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].targetPath).toContain("review.md");
  });

  test("vscode → claude writes under mcpServers (not servers)", async () => {
    writeFixture(
      testVscode.mcpJson,
      JSON.stringify({
        servers: {
          gh: { type: "stdio", command: "gh-mcp", args: [], env: {} },
        },
      }),
    );

    const result = await performMigrate({
      from: "vscode",
      to: "claude",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.migrated).toHaveLength(1);
    const { readIfExists } = await import("../../agents/_utils");
    const written = await readIfExists(testClaude.mcpJson);
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written as string) as Record<string, unknown>;
    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.servers).toBeUndefined();
    expect((parsed.mcpServers as Record<string, unknown>).gh).toBeDefined();
  });

  test("claude → vscode writes under top-level servers (no nested mcpServers.servers)", async () => {
    writeFixture(
      testClaude.mcpJson,
      JSON.stringify({
        mcpServers: { gh: { command: "gh-mcp", args: [], env: {} } },
      }),
    );

    const result = await performMigrate({
      from: "claude",
      to: "vscode",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.migrated).toHaveLength(1);
    const { readIfExists } = await import("../../agents/_utils");
    const written = await readIfExists(testVscode.mcpJson);
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written as string) as Record<string, unknown>;
    expect(parsed.servers).toBeDefined();
    // Critically, the legacy mcpServers key must NOT appear on the VS Code target.
    expect(parsed.mcpServers).toBeUndefined();
    const servers = parsed.servers as Record<string, Record<string, unknown>>;
    expect(servers.gh.type).toBe("stdio");
    expect(servers.gh.command).toBe("gh-mcp");
    // And there must be no double-nesting like servers.gh.servers or
    // mcpServers.servers anywhere.
    expect((servers.gh as { servers?: unknown }).servers).toBeUndefined();
  });

  test("vscode → claude HTTP transport produces translator warnings on result", async () => {
    writeFixture(
      testVscode.mcpJson,
      JSON.stringify({
        servers: {
          remote: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { "X-Trace": "on" },
          },
          gh: { type: "stdio", command: "gh-mcp" },
        },
      }),
    );

    const result = await performMigrate({
      from: "vscode",
      to: "claude",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    // Translator warnings about dropped HTTP transport should surface
    expect(result.warnings.length).toBeGreaterThan(0);
    const joined = result.warnings.join("\n");
    expect(joined).toContain("remote");
    expect(joined).toContain("http");
  });

  test("vscode existing inputs preserved during vscode-target merge", async () => {
    // Existing VS Code file with both servers and inputs
    writeFixture(
      testVscode.mcpJson,
      JSON.stringify({
        servers: { existing: { type: "stdio", command: "old" } },
        inputs: [{ id: "existing_token", type: "promptString", password: true }],
      }),
    );
    writeFixture(testClaude.mcpJson, JSON.stringify({ mcpServers: { gh: { command: "gh-mcp" } } }));

    const result = await performMigrate({
      from: "claude",
      to: "vscode",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    const { readIfExists } = await import("../../agents/_utils");
    const written = await readIfExists(testVscode.mcpJson);
    const parsed = JSON.parse(written as string) as {
      servers: Record<string, unknown>;
      inputs?: unknown[];
    };
    // Incoming server merged, existing server preserved
    expect(parsed.servers.gh).toBeDefined();
    expect(parsed.servers.existing).toBeDefined();
    // Existing inputs preserved
    expect(Array.isArray(parsed.inputs)).toBe(true);
    expect((parsed.inputs as Array<{ id: string }>)[0].id).toBe("existing_token");
  });

  test("applyMigrated vscode inputs collision: source value wins on shared id", async () => {
    // Exercises the inputs-dedup branch in applyMigrated. No registered
    // translator pair currently produces inputs into a vscode target that
    // already has inputs, but the dedup contract is still load-bearing
    // defensive code — pin "source wins on collision" so it matches the
    // sibling servers merge and docs/migrate.md.
    writeFixture(
      testVscode.mcpJson,
      JSON.stringify({
        servers: { existing: { type: "stdio", command: "old" } },
        inputs: [{ id: "tok", type: "promptString", description: "OLD" }],
      }),
    );
    const incoming = `${JSON.stringify(
      {
        servers: { gh: { type: "stdio", command: "gh-mcp" } },
        inputs: [{ id: "tok", type: "promptString", description: "NEW" }],
      },
      null,
      2,
    )}\n`;

    const artifact = await applyMigrated("vscode", "mcp", "mcp.json", incoming, false);
    expect(artifact).not.toBeNull();
    const { readIfExists } = await import("../../agents/_utils");
    const written = await readIfExists(testVscode.mcpJson);
    const parsed = JSON.parse(written as string) as {
      servers: Record<string, unknown>;
      inputs?: Array<{ id: string; description?: string }>;
    };
    // Source wins for the collision
    expect(parsed.inputs?.find((i) => i.id === "tok")?.description).toBe("NEW");
    // No duplicate entries — dedup still works
    expect((parsed.inputs ?? []).filter((i) => i.id === "tok")).toHaveLength(1);
    // Both servers present after merge
    expect(parsed.servers.existing).toBeDefined();
    expect(parsed.servers.gh).toBeDefined();
  });

  test("vscode → claude with only http servers does not create empty mcpServers file", async () => {
    writeFixture(
      testVscode.mcpJson,
      JSON.stringify({
        servers: {
          remote: { type: "http", url: "https://example.com/mcp" },
        },
      }),
    );

    const result = await performMigrate({
      from: "vscode",
      to: "claude",
      type: "mcp",
      dryRun: false,
    });

    expect(result.errors).toHaveLength(0);
    // Translator warned, but no file was written.
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.migrated).toHaveLength(0);
    const { readIfExists } = await import("../../agents/_utils");
    const written = await readIfExists(testClaude.mcpJson);
    expect(written).toBeNull();
  });

  test("partial write failure continues remaining artefacts", async () => {
    mkdirSync(testClaude.commandsDir, { recursive: true });
    writeFileSync(join(testClaude.commandsDir, "review.md"), "# Review");
    writeFileSync(join(testClaude.commandsDir, "lint.md"), "# Lint");

    // Make cursor commands dir read-only to force write failures
    mkdirSync(testCursor.commandsDir, { recursive: true });
    chmodSync(testCursor.commandsDir, 0o444);

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "commands",
      dryRun: false,
    });

    // Write failures should be recorded in errors, not thrown
    expect(result.errors.length).toBeGreaterThan(0);

    // Restore permissions for cleanup
    chmodSync(testCursor.commandsDir, 0o755);
  });
});

// ── Skills (NEW) ─────────────────────────────────────────────────────────────

describe("performMigrate skills", () => {
  test("claude → cursor copies SKILL.md and supporting files byte-for-byte", async () => {
    const skillDir = join(testClaude.skillsDir, "lint");
    writeFixture(
      join(skillDir, "SKILL.md"),
      "---\nname: lint\ndescription: Lint things\n---\n\nLint the project.",
    );
    writeFixture(join(skillDir, "reference.md"), "# Reference\n\nDetails.");
    writeFixture(join(skillDir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "skills",
      dryRun: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated.length).toBeGreaterThan(0);
    const skillMd = await Bun.file(join(testCursor.skillsDir, "lint", "SKILL.md")).text();
    expect(skillMd).toContain("name: lint");
    const ref = await Bun.file(join(testCursor.skillsDir, "lint", "reference.md")).text();
    expect(ref).toBe("# Reference\n\nDetails.");
    const scriptPath = join(testCursor.skillsDir, "lint", "scripts", "run.sh");
    const script = await Bun.file(scriptPath).text();
    expect(script).toBe("#!/bin/sh\necho hi\n");
  });

  test("claude → codex writes to userSkillsDir (~/.agents/skills)", async () => {
    const skillDir = join(testClaude.skillsDir, "lint");
    writeFixture(join(skillDir, "SKILL.md"), "---\nname: lint\ndescription: Lint\n---\n\nbody");
    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "skills",
      dryRun: false,
    });
    expect(result.migrated[0]?.targetPath).toContain(testCodex.userSkillsDir);
  });

  test("claude → copilot emits best-effort warning", async () => {
    writeFixture(
      join(testClaude.skillsDir, "lint", "SKILL.md"),
      "---\nname: lint\ndescription: Lint\n---\n\nbody",
    );
    const result = await performMigrate({
      from: "claude",
      to: "copilot",
      type: "skills",
      dryRun: false,
    });
    expect(result.warnings.join("\n")).toContain("Copilot CLI has no documented SKILL.md loader");
  });

  test("vscode source returns no skills (no SKILL.md surface)", async () => {
    const result = await performMigrate({
      from: "vscode",
      to: "claude",
      type: "skills",
      dryRun: false,
    });
    // Either skipped (no source) or no translator registered. No errors.
    expect(result.errors).toEqual([]);
    expect(result.migrated).toEqual([]);
  });

  test("dry-run reports artefacts without writing", async () => {
    writeFixture(
      join(testClaude.skillsDir, "lint", "SKILL.md"),
      "---\nname: lint\ndescription: Lint\n---\n\nbody",
    );
    writeFixture(join(testClaude.skillsDir, "lint", "reference.md"), "ref");
    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "skills",
      dryRun: true,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated[0]?.description).toContain("supporting files");
    // Confirm nothing was written.
    expect(await Bun.file(join(testCursor.skillsDir, "lint", "SKILL.md")).exists()).toBe(false);
  });
});

// ── Rules (NEW) ──────────────────────────────────────────────────────────────

describe("performMigrate rules", () => {
  test("claude → codex byte-equal markdown passthrough", async () => {
    writeFixture(join(testClaude.rulesDir, "mermaid.md"), "Use classDef.");
    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "rules",
      dryRun: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated.length).toBe(1);
    const written = await Bun.file(join(testCodex.rulesDir, "mermaid.md")).text();
    expect(written.trim()).toBe("Use classDef.");
  });

  test("cursor → claude strips .mdc frontmatter and rewrites filename", async () => {
    writeFixture(
      join(testCursor.rulesDir, "x.mdc"),
      "---\ndescription: x\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\nbody",
    );
    const result = await performMigrate({
      from: "cursor",
      to: "claude",
      type: "rules",
      dryRun: false,
    });
    expect(result.warnings.join("\n")).toContain("description, globs, alwaysApply");
    const written = await Bun.file(join(testClaude.rulesDir, "x.md")).text();
    expect(written.trim()).toBe("body");
    expect(written).not.toContain("globs:");
  });

  test("copilot → cursor: registry returns null (workspace-only), recorded as skip", async () => {
    // Source has nothing — exercises the "no translator registered" path
    // for the unregistered direction.
    const result = await performMigrate({
      from: "copilot",
      to: "cursor",
      type: "rules",
      dryRun: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});

// ── Copilot MCP (NEW endpoint) ───────────────────────────────────────────────

describe("performMigrate copilot mcp endpoint", () => {
  test("claude → copilot writes mcp-config.json with mcpServers", async () => {
    writeFixture(
      testClaude.mcpJson,
      JSON.stringify({ mcpServers: { local: { command: "npx", args: ["foo"] } } }),
    );
    const result = await performMigrate({
      from: "claude",
      to: "copilot",
      type: "mcp",
      dryRun: false,
    });
    expect(result.errors).toEqual([]);
    expect(result.migrated[0]?.targetPath).toBe(testCopilot.mcpConfigJson);
    const written = JSON.parse(await Bun.file(testCopilot.mcpConfigJson).text()) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(written.mcpServers?.local).toBeDefined();
  });

  test("copilot → claude round-trips a stdio server", async () => {
    writeFixture(
      testCopilot.mcpConfigJson,
      JSON.stringify({ mcpServers: { local: { command: "npx", args: ["foo"] } } }),
    );
    const result = await performMigrate({
      from: "copilot",
      to: "claude",
      type: "mcp",
      dryRun: false,
    });
    expect(result.errors).toEqual([]);
    const written = JSON.parse(await Bun.file(testClaude.mcpJson).text()) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(written.mcpServers?.local).toBeDefined();
  });
});

// ── Commands → Codex skill wrap (BEHAVIOUR CHANGE) ───────────────────────────

describe("performMigrate commands → codex (wraps as SKILL.md)", () => {
  test("writes <basename>/SKILL.md under userSkillsDir, not legacy rulesDir", async () => {
    mkdirSync(testClaude.commandsDir, { recursive: true });
    writeFileSync(join(testClaude.commandsDir, "lint.md"), "# Lint\n\nDo lint things.");
    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "commands",
      dryRun: false,
    });
    expect(result.errors).toEqual([]);
    const skillMdPath = join(testCodex.userSkillsDir, "lint", "SKILL.md");
    expect(await Bun.file(skillMdPath).exists()).toBe(true);
    const skillMd = await Bun.file(skillMdPath).text();
    expect(skillMd).toContain("name: lint");
    expect(skillMd).toContain("description:");
    expect(skillMd).toContain("Do lint things.");
    // Did NOT write to legacy rulesDir.
    expect(await Bun.file(join(testCodex.rulesDir, "lint.md")).exists()).toBe(false);
  });

  test("OpenCode command authority aborts the target batch before writing", async () => {
    const sourceRoot = join(process.env.OPENCODE_CONFIG_DIR as string, "commands");
    writeFixture(join(sourceRoot, "agent.md"), "---\nagent: plan\n---\n\nPlan.");
    writeFixture(join(sourceRoot, "subtask.md"), "---\nsubtask: true\n---\n\nDelegate.");
    writeFixture(join(sourceRoot, "safe.md"), "Review safely.");

    const result = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "commands",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("field 'agent'");
    expect(result.errors.join("\n")).toContain("field 'subtask'");
    expect(await Bun.file(join(testClaude.commandsDir, "agent.md")).exists()).toBe(false);
    expect(await Bun.file(join(testClaude.commandsDir, "subtask.md")).exists()).toBe(false);
    expect(await Bun.file(join(testClaude.commandsDir, "safe.md")).exists()).toBe(false);
  });

  test("OpenCode command interpolation mismatch aborts safe siblings before writing", async () => {
    const sourceRoot = join(process.env.OPENCODE_CONFIG_DIR as string, "commands");
    writeFixture(join(sourceRoot, "unsafe.md"), "```!\ntouch /tmp/proof\n```");
    writeFixture(join(sourceRoot, "safe.md"), "Review safely.");

    const result = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "commands",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("different Claude semantics");
    expect(await Bun.file(join(testClaude.commandsDir, "unsafe.md")).exists()).toBe(false);
    expect(await Bun.file(join(testClaude.commandsDir, "safe.md")).exists()).toBe(false);
  });

  test("flattened OpenCode command paths collide before any Codex skill write", async () => {
    const sourceRoot = join(process.env.OPENCODE_CONFIG_DIR as string, "commands");
    writeFixture(join(sourceRoot, "a", "b.md"), "Nested command.");
    writeFixture(join(sourceRoot, "a-b.md"), "Flat command.");

    const result = await performMigrate({
      from: "opencode",
      to: "codex",
      type: "commands",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("Command target path collision");
    expect(await Bun.file(join(testCodex.userSkillsDir, "a-b", "SKILL.md")).exists()).toBe(false);
  });

  test("unsafe OpenCode command name is reported by the combined Codex preflight", async () => {
    const sourceRoot = join(process.env.OPENCODE_CONFIG_DIR as string, "commands");
    writeFixture(join(sourceRoot, "bad:name.md"), "Unsafe command.");

    const result = await performMigrate({
      from: "opencode",
      to: "codex",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("Windows-reserved character");
    expect(await Bun.file(join(testCodex.userSkillsDir, "bad:name", "SKILL.md")).exists()).toBe(
      false,
    );
  });

  test("unsafe source-derived command path aborts safe siblings before writing", async () => {
    const sourceRoot = join(process.env.OPENCODE_CONFIG_DIR as string, "commands");
    writeFixture(join(sourceRoot, "bad:name.md"), "Unsafe command.");
    writeFixture(join(sourceRoot, "safe.md"), "Safe command.");

    const result = await performMigrate({
      from: "opencode",
      to: "claude",
      type: "commands",
      dryRun: false,
    });

    expect(result.migrated).toEqual([]);
    expect(result.errors.join("\n")).toContain("Windows-reserved character");
    expect(await Bun.file(join(testClaude.commandsDir, "bad:name.md")).exists()).toBe(false);
    expect(await Bun.file(join(testClaude.commandsDir, "safe.md")).exists()).toBe(false);
  });
});

// ── Hard-error name-miss (BEHAVIOUR CHANGE) ──────────────────────────────────

describe("performMigrate --name miss is a hard error", () => {
  test("named artefact not found returns error and aborts", async () => {
    mkdirSync(testClaude.commandsDir, { recursive: true });
    // Don't create the file.
    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "commands",
      name: "does-not-exist.md",
      dryRun: false,
    });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("does-not-exist.md");
    expect(result.migrated).toEqual([]);
  });
});

describe("performMigrate agents acceptance", () => {
  test("C1 includes agents when type is omitted and deduplicates shared --to all output", async () => {
    writeFixture(join(testClaude.agentsDir, "reviewer.md"), claudeAgent("reviewer"));

    const result = await performMigrate({
      from: "claude",
      to: "all",
      dryRun: true,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated.map(({ targetPath }) => targetPath).sort()).toEqual(
      [
        join(cursorAgentsDir, "reviewer.md"),
        join(codexAgentsDir, "reviewer.toml"),
        join(sharedAgentsDir, "reviewer.agent.md"),
        join(openCodeAgentsDir, "reviewer.md"),
      ].sort(),
    );
    expect(new Set(result.migrated.map(({ targetPath }) => targetPath)).size).toBe(4);
    expect(
      result.migrated.every(({ targetPath }) => targetPath.startsWith(`${tmpDir}${sep}`)),
    ).toBe(true);
  });

  test("C3 writes valid Codex TOML to the documented agent directory", async () => {
    writeFixture(join(testClaude.agentsDir, "reviewer.md"), claudeAgent("reviewer"));

    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "agents",
      dryRun: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0]?.targetPath).toBe(join(codexAgentsDir, "reviewer.toml"));
    const parsed = TOML.parse(await Bun.file(join(codexAgentsDir, "reviewer.toml")).text()) as {
      name?: string;
      description?: string;
      developer_instructions?: string;
    };
    expect(parsed).toMatchObject({
      name: "reviewer",
      description: "Reviews code",
      developer_instructions: "Review code.",
    });
  });

  test("C4 records an unmappable authority field and writes no target", async () => {
    writeFixture(
      join(testClaude.agentsDir, "planner.md"),
      claudeAgent("planner", "\npermissionMode: plan"),
    );

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });

    expect(result.errors.join("\n")).toContain("permissionMode");
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(join(cursorAgentsDir, "planner.md")).exists()).toBe(false);
  });

  test("C4 and C8 surface named non-authority loss warnings with a successful write", async () => {
    writeFixture(
      join(testClaude.agentsDir, "reviewer.md"),
      claudeAgent("reviewer", "\nmodel: sonnet"),
    );

    const result = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("model");
    expect(await Bun.file(join(cursorAgentsDir, "reviewer.md")).exists()).toBe(true);
  });

  test("C5 rejects unsafe target paths before filesystem writes", async () => {
    await expect(
      applyMigrated("cursor", "agents", "../escape.md", cursorAgent("escape"), false),
    ).rejects.toThrow(/path|unsafe|traversal/i);
    expect(await Bun.file(join(cursorAgentsDir, "..", "escape.md")).exists()).toBe(false);
  });

  test("C6 emits explicit direct targets and an omitted shared --to all target", async () => {
    writeFixture(join(testClaude.agentsDir, "reviewer.md"), claudeAgent("reviewer"));

    const cli = await performMigrate({
      from: "claude",
      to: "copilot",
      type: "agents",
      dryRun: true,
    });
    const vscode = await performMigrate({
      from: "claude",
      to: "vscode",
      type: "agents",
      dryRun: true,
    });
    const all = await performMigrate({
      from: "claude",
      to: "all",
      type: "agents",
      dryRun: true,
    });

    expect(agentFrontmatter(cli.migrated[0]?.content ?? "").target).toBe("github-copilot");
    expect(agentFrontmatter(vscode.migrated[0]?.content ?? "").target).toBe("vscode");
    const shared = all.migrated.find(
      ({ targetPath }) => targetPath === join(sharedAgentsDir, "reviewer.agent.md"),
    );
    expect(shared).toBeDefined();
    expect(agentFrontmatter(shared?.content ?? "").target).toBeUndefined();
    expect(all.migrated.filter(({ targetPath }) => targetPath === shared?.targetPath)).toHaveLength(
      1,
    );
  });

  test("C7 rejects duplicate logical identities before any batch write", async () => {
    writeFixture(join(codexAgentsDir, "one.toml"), codexAgent("reviewer"));
    writeFixture(join(codexAgentsDir, "two.toml"), codexAgent("reviewer"));
    writeFixture(join(codexAgentsDir, "unique.toml"), codexAgent("unique_agent"));

    const result = await performMigrate({
      from: "codex",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });

    expect(result.errors.join("\n")).toMatch(/duplicate.*reviewer/i);
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(join(cursorAgentsDir, "unique-agent.md")).exists()).toBe(false);
  });

  test("C7 rejects normalized and case-equivalent target paths before any batch write", async () => {
    writeFixture(join(codexAgentsDir, "one.toml"), codexAgent("Review_Agent"));
    writeFixture(join(codexAgentsDir, "two.toml"), codexAgent("review-agent"));
    writeFixture(join(codexAgentsDir, "unique.toml"), codexAgent("unique_agent"));

    const result = await performMigrate({
      from: "codex",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });

    expect(result.errors.join("\n")).toMatch(/target.*collision/i);
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(join(cursorAgentsDir, "unique-agent.md")).exists()).toBe(false);
  });

  test("C8 dry-run reports the output without overwriting an existing target", async () => {
    writeFixture(join(testClaude.agentsDir, "source.md"), claudeAgent("reviewer"));
    const targetPath = join(cursorAgentsDir, "reviewer.md");
    writeFixture(targetPath, "existing target");

    const preview = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: true,
    });
    expect(preview.errors).toEqual([]);
    expect(preview.migrated[0]?.targetPath).toBe(targetPath);
    expect(await Bun.file(targetPath).text()).toBe("existing target");

    const applied = await performMigrate({
      from: "claude",
      to: "cursor",
      type: "agents",
      dryRun: false,
    });
    expect(applied.errors).toEqual([]);
    expect(await Bun.file(targetPath).text()).toContain("Review code.");
  });

  test("C8 preserves exact nested --name selection through migration", async () => {
    writeFixture(join(testClaude.agentsDir, "reviewer.md"), claudeAgent("root-reviewer"));
    writeFixture(join(testClaude.agentsDir, "teams", "reviewer.md"), claudeAgent("team-reviewer"));

    const result = await performMigrate({
      from: "claude",
      to: "codex",
      type: "agents",
      name: "teams/reviewer.md",
      dryRun: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0]?.sourcePath).toBe(join(testClaude.agentsDir, "teams", "reviewer.md"));
    expect(await Bun.file(join(codexAgentsDir, "team-reviewer.toml")).exists()).toBe(true);
    expect(await Bun.file(join(codexAgentsDir, "root-reviewer.toml")).exists()).toBe(false);
  });

  test("C8 rejects direct Copilot to VS Code migration before touching the shared store", async () => {
    const sourcePath = join(sharedAgentsDir, "reviewer.agent.md");
    const source = sharedAgent("reviewer");
    writeFixture(sourcePath, source);

    const result = await performMigrate({
      from: "copilot",
      to: "vscode",
      type: "agents",
      dryRun: false,
    });

    expect(result.errors.join("\n")).toContain("same physical store");
    expect(result.migrated).toEqual([]);
    expect(await Bun.file(sourcePath).text()).toBe(source);
  });

  test("C8 skips only agents for an unfiltered direct shared-store migration", async () => {
    writeFixture(
      testCopilot.mcpConfigJson,
      JSON.stringify({ mcpServers: { local: { command: "local-mcp" } } }),
    );

    const result = await performMigrate({
      from: "copilot",
      to: "vscode",
      dryRun: false,
    });

    expect(result.errors).toEqual(["Copilot and VS Code agents use the same physical store"]);
    expect(result.migrated.some(({ targetPath }) => targetPath === testVscode.mcpJson)).toBe(true);
    const written = JSON.parse(await Bun.file(testVscode.mcpJson).text()) as {
      servers?: Record<string, unknown>;
    };
    expect(written.servers?.local).toBeDefined();
  });
});
