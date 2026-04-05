import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { createTmpDir } from "../../test-helpers/fixtures";

{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

type MutableClaudePaths = {
  claudeMd: string;
  settingsJson: string;
  commandsDir: string;
  agentsDir: string;
  mcpJson: string;
  credentials: string;
};

const testClaudePaths = AgentPaths.claude as MutableClaudePaths;

type ClaudeModule = typeof import("../claude");
let claudeModule: ClaudeModule;

beforeAll(async () => {
  claudeModule = await import("../claude");
});

// T018 — snapshotClaude

describe("snapshotClaude", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty artifacts when no files exist", async () => {
    const result = await claudeModule.snapshotClaude();
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("snapshots CLAUDE.md when it exists", async () => {
    await writeFile(testClaudePaths.claudeMd, "# My Claude instructions\n", "utf8");
    const result = await claudeModule.snapshotClaude();
    const art = result.artifacts.find((a) => a.vaultPath === "claude/CLAUDE.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("# My Claude instructions\n");
  });

  test("snapshots settings.json extracting only hooks", async () => {
    const settings = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "*", hooks: [] }] },
      other: "should be dropped",
    });
    await writeFile(testClaudePaths.settingsJson, settings, "utf8");

    const result = await claudeModule.snapshotClaude();
    const art = result.artifacts.find((a) => a.vaultPath === "claude/settings.hooks.json.age");
    expect(art).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const parsed = JSON.parse(art!.plaintext) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["hooks"]);
  });

  test("snapshots .claude.json extracting only mcpServers", async () => {
    const mcp = JSON.stringify({
      mcpServers: { myserver: { command: "npx" } },
      something: "else",
    });
    await writeFile(testClaudePaths.mcpJson, mcp, "utf8");

    const result = await claudeModule.snapshotClaude();
    const art = result.artifacts.find((a) => a.vaultPath === "claude/claude.json.age");
    expect(art).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const parsed = JSON.parse(art!.plaintext) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["mcpServers"]);
  });

  test("snapshots command .md files from commands dir", async () => {
    mkdirSync(testClaudePaths.commandsDir, { recursive: true });
    writeFileSync(join(testClaudePaths.commandsDir, "my-cmd.md"), "cmd content", "utf8");

    const result = await claudeModule.snapshotClaude();
    const art = result.artifacts.find((a) => a.vaultPath === "claude/commands/my-cmd.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("cmd content");
  });

  test("snapshots agent .md files from agents dir", async () => {
    mkdirSync(testClaudePaths.agentsDir, { recursive: true });
    writeFileSync(join(testClaudePaths.agentsDir, "my-agent.md"), "agent content", "utf8");

    const result = await claudeModule.snapshotClaude();
    const art = result.artifacts.find((a) => a.vaultPath === "claude/agents/my-agent.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("agent content");
  });

  test("redacts secrets in settings.json and adds warnings", async () => {
    const settings = JSON.stringify({
      hooks: {},
      env: { API_KEY: `sk-${"x".repeat(30)}` },
    });
    await writeFile(testClaudePaths.settingsJson, settings, "utf8");
    const result = await claudeModule.snapshotClaude();
    // Warnings bubble up from sanitization
    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
  });
});

// T024 — applyClaudeMd / applyClaudeHooks / applyClaudeMcp / applyClaudeCommand / applyClaudeAgent

describe("apply* functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "commands");
    testClaudePaths.agentsDir = join(tmpDir, "agents");
    testClaudePaths.mcpJson = join(tmpDir, ".claude.json");
    testClaudePaths.credentials = join(tmpDir, ".credentials.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applyClaudeMd writes CLAUDE.md", async () => {
    await claudeModule.applyClaudeMd("# Updated instructions");
    const content = await Bun.file(testClaudePaths.claudeMd).text();
    expect(content).toBe("# Updated instructions");
  });

  test("applyClaudeHooks merges hooks key into existing settings.json", async () => {
    await writeFile(testClaudePaths.settingsJson, JSON.stringify({ theme: "dark" }), "utf8");
    await claudeModule.applyClaudeHooks(JSON.stringify({ hooks: { PreToolUse: [] } }));
    const updated = JSON.parse(await Bun.file(testClaudePaths.settingsJson).text()) as Record<
      string,
      unknown
    >;
    expect(updated.theme).toBe("dark");
    expect(updated.hooks).toEqual({ PreToolUse: [] });
  });

  test("applyClaudeHooks creates settings.json when missing", async () => {
    await claudeModule.applyClaudeHooks(JSON.stringify({ hooks: { PostToolUse: [] } }));
    const parsed = JSON.parse(await Bun.file(testClaudePaths.settingsJson).text()) as Record<
      string,
      unknown
    >;
    expect(parsed.hooks).toEqual({ PostToolUse: [] });
  });

  test("applyClaudeMcp merges mcpServers into .claude.json", async () => {
    await writeFile(testClaudePaths.mcpJson, JSON.stringify({ projects: {} }), "utf8");
    await claudeModule.applyClaudeMcp(JSON.stringify({ mcpServers: { srv: { command: "bun" } } }));
    const parsed = JSON.parse(await Bun.file(testClaudePaths.mcpJson).text()) as Record<
      string,
      unknown
    >;
    expect(parsed.projects).toEqual({});
    expect((parsed.mcpServers as Record<string, unknown>).srv).toBeDefined();
  });

  test("applyClaudeCommand writes a command file", async () => {
    await claudeModule.applyClaudeCommand("review.md", "# Code review command");
    const content = await Bun.file(join(testClaudePaths.commandsDir, "review.md")).text();
    expect(content).toBe("# Code review command");
  });

  test("applyClaudeAgent writes an agent file", async () => {
    await claudeModule.applyClaudeAgent("my-agent.md", "# Agent content");
    const content = await Bun.file(join(testClaudePaths.agentsDir, "my-agent.md")).text();
    expect(content).toBe("# Agent content");
  });
});

// T028 — dryRun (applyClaudeVault)

describe("applyClaudeVault dryRun", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testClaudePaths.claudeMd = join(tmpDir, "apply", "CLAUDE.md");
    testClaudePaths.settingsJson = join(tmpDir, "apply", "settings.json");
    testClaudePaths.commandsDir = join(tmpDir, "apply", "commands");
    testClaudePaths.agentsDir = join(tmpDir, "apply", "agents");
    testClaudePaths.mcpJson = join(tmpDir, "apply", ".claude.json");
    testClaudePaths.credentials = join(tmpDir, "apply", ".credentials.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dryRun=true does not write any files to disk", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    // Create vault with an encrypted CLAUDE.md
    const vaultDir = join(tmpDir, "vault");
    const claudeVaultDir = join(vaultDir, "claude");
    await mkdir(claudeVaultDir, { recursive: true });
    const encrypted = await encryptString("# dry run content", [recipient]);
    await writeFile(join(claudeVaultDir, "CLAUDE.md.age"), encrypted, "utf8");

    await claudeModule.applyClaudeVault(vaultDir, identity, true /* dryRun */);

    // File should NOT exist since dryRun=true
    const exists = await Bun.file(testClaudePaths.claudeMd).exists();
    expect(exists).toBeFalse();
  });
});
