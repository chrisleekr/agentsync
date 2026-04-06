/**
 * Tests for src/migrate/migrate.ts — the migration orchestrator.
 * Uses temp directories with mocked AgentPaths to test reading,
 * translation, secret detection, and write behaviour.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { performMigrate, readSourceArtefacts } from "../migrate";

// ── Mutable path references for testing ──────────────────────────────────────

type MutablePaths<K extends keyof typeof AgentPaths> = {
  -readonly [P in keyof (typeof AgentPaths)[K]]: (typeof AgentPaths)[K][P];
};

const testClaude = AgentPaths.claude as MutablePaths<"claude">;
const testCursor = AgentPaths.cursor as MutablePaths<"cursor">;
const testCodex = AgentPaths.codex as MutablePaths<"codex">;
const testCopilot = AgentPaths.copilot as MutablePaths<"copilot">;
const testVscode = AgentPaths.vscode as MutablePaths<"vscode">;

let tmpDir: string;
let origClaude: typeof AgentPaths.claude;
let origCursor: typeof AgentPaths.cursor;
let origCodex: typeof AgentPaths.codex;
let origCopilot: typeof AgentPaths.copilot;
let origVscode: typeof AgentPaths.vscode;

beforeEach(() => {
  tmpDir = join(tmpdir(), `migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });

  // Save originals
  origClaude = { ...AgentPaths.claude };
  origCursor = { ...AgentPaths.cursor };
  origCodex = { ...AgentPaths.codex };
  origCopilot = { ...AgentPaths.copilot };
  origVscode = { ...AgentPaths.vscode };

  // Redirect all agent paths to temp directory
  testClaude.claudeMd = join(tmpDir, "claude", "CLAUDE.md");
  testClaude.mcpJson = join(tmpDir, "claude", ".claude.json");
  testClaude.commandsDir = join(tmpDir, "claude", "commands");
  testClaude.settingsJson = join(tmpDir, "claude", "settings.json");

  testCursor.settingsJson = join(tmpDir, "cursor", "settings.json");
  testCursor.mcpGlobal = join(tmpDir, "cursor", "mcp.json");
  testCursor.commandsDir = join(tmpDir, "cursor", "commands");

  testCodex.agentsMd = join(tmpDir, "codex", "AGENTS.md");
  testCodex.configToml = join(tmpDir, "codex", "config.toml");
  testCodex.rulesDir = join(tmpDir, "codex", "rules");

  testCopilot.instructionsFile = join(tmpDir, "copilot", "instructions");
  testCopilot.promptsDir = join(tmpDir, "copilot", "prompts");

  testVscode.mcpJson = join(tmpDir, "vscode", "mcp.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  // Restore originals
  Object.assign(testClaude, origClaude);
  Object.assign(testCursor, origCursor);
  Object.assign(testCodex, origCodex);
  Object.assign(testCopilot, origCopilot);
  Object.assign(testVscode, origVscode);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeFixture(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
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

  test("returns empty for missing source files (FR-013)", async () => {
    const result = await readSourceArtefacts("claude", "global-rules");
    expect(result).toHaveLength(0);
  });

  test("returns empty for vscode global-rules (unsupported)", async () => {
    const result = await readSourceArtefacts("vscode", "global-rules");
    expect(result).toHaveLength(0);
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

    // Claude has global-rules translators to cursor, codex, copilot (not vscode)
    const migratedTargets = result.migrated.map((m) => m.description);
    expect(migratedTargets.some((d) => d.includes("cursor"))).toBe(true);
    expect(migratedTargets.some((d) => d.includes("codex"))).toBe(true);
    expect(migratedTargets.some((d) => d.includes("copilot"))).toBe(true);
    // vscode should be skipped
    const vsSkip = result.skipped.find(
      (s) => s.pair.to === "vscode" && s.pair.type === "global-rules",
    );
    expect(vsSkip).toBeDefined();
  });

  test("aborts on detected secret in MCP content (FR-011)", async () => {
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

  test("Codex TOML merge preserves non-MCP sections", async () => {
    writeFixture(
      testClaude.mcpJson,
      JSON.stringify({
        mcpServers: { gh: { command: "gh-mcp", args: [], env: {} } },
      }),
    );
    // Existing codex config has auth section + existing MCP server
    writeFixture(
      testCodex.configToml,
      '[auth]\ntoken = "abc"\n\n[mcp.servers.slack]\ncommand = "slack-mcp"\nargs = []\n\n[mcp.servers.slack.env]\n',
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
    // Auth section preserved
    expect(written).toContain("token");
    // Both MCP servers present (merged)
    expect(written).toContain("gh");
    expect(written).toContain("slack");
  });

  test("reports skip for missing source files (FR-013)", async () => {
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
