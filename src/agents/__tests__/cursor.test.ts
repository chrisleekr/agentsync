import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgeIdentity, createTmpDir } from "../../test-helpers/fixtures";

// ─── Mock AgentPaths before any dynamic import of cursor ─────────────────────
// bun:test mock.module() is NOT hoisted — call synchronously before dynamic import.

const mockCursorPaths = {
  mcpGlobal: "",
  commandsDir: "",
  settingsJson: "",
};

mock.module("../../config/paths", () => ({
  AgentPaths: {
    claude: {
      claudeMd: "",
      settingsJson: "",
      commandsDir: "",
      agentsDir: "",
      mcpJson: "",
      credentials: "",
    },
    cursor: mockCursorPaths,
    codex: {
      root: "",
      agentsMd: "",
      configToml: "",
      rulesDir: "",
      authJson: "",
    },
    copilot: {
      instructionsFile: "",
      instructionsDir: "",
      skillsDir: "",
      promptsDir: "",
      agentsDir: "",
      vscodeMcpInSettings: "",
    },
    vscode: { mcpJson: "" },
  },
  resolveAgentSyncHome: () => "/tmp/agentsync",
  resolveDaemonSocketPath: () => "/tmp/agentsync/daemon.sock",
}));

type CursorModule = typeof import("../cursor");
let cursorModule: CursorModule;

beforeAll(async () => {
  cursorModule = await import("../cursor");
});

// ── T021 — snapshotCursor ─────────────────────────────────────────────────────

describe("snapshotCursor", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    mockCursorPaths.settingsJson = join(tmpDir, "settings.json");
    mockCursorPaths.mcpGlobal = join(tmpDir, "mcp.json");
    mockCursorPaths.commandsDir = join(tmpDir, "commands");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty when no files exist", async () => {
    const { snapshotCursor } = cursorModule;
    const result = await snapshotCursor();
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("captures rules string from settings.json as cursor/user-rules.md.age", async () => {
    const { snapshotCursor } = cursorModule;
    const settings = {
      rules: "Always write tests\n- prefer TDD",
      theme: "dark",
    };
    await writeFile(mockCursorPaths.settingsJson, JSON.stringify(settings), "utf8");

    const result = await snapshotCursor();
    const artifact = result.artifacts.find((a) => a.vaultPath === "cursor/user-rules.md.age");
    expect(artifact).toBeDefined();
    expect(artifact?.plaintext).toBe(settings.rules);
    expect(artifact?.sourcePath).toBe(mockCursorPaths.settingsJson);
  });

  test("skips rules when settings.json has no rules field", async () => {
    const { snapshotCursor } = cursorModule;
    await writeFile(
      mockCursorPaths.settingsJson,
      JSON.stringify({ theme: "light", fontSize: 14 }),
      "utf8",
    );
    const result = await snapshotCursor();
    expect(result.artifacts.find((a) => a.vaultPath.includes("user-rules"))).toBeUndefined();
  });

  test("skips rules when rules field is not a string", async () => {
    const { snapshotCursor } = cursorModule;
    await writeFile(
      mockCursorPaths.settingsJson,
      JSON.stringify({ rules: ["array", "of", "rules"] }),
      "utf8",
    );
    const result = await snapshotCursor();
    expect(result.artifacts.find((a) => a.vaultPath.includes("user-rules"))).toBeUndefined();
  });

  test("captures mcp.json as cursor/mcp.json.age", async () => {
    const { snapshotCursor } = cursorModule;
    const mcp = {
      mcpServers: { "my-server": { command: "node", args: ["server.js"] } },
    };
    await writeFile(mockCursorPaths.mcpGlobal, JSON.stringify(mcp), "utf8");

    const result = await snapshotCursor();
    const artifact = result.artifacts.find((a) => a.vaultPath === "cursor/mcp.json.age");
    expect(artifact).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const parsed = JSON.parse(artifact!.plaintext.trim()) as Record<string, unknown>;
    expect((parsed.mcpServers as Record<string, { command: string }>)["my-server"].command).toBe(
      "node",
    );
  });

  test("captures command .md files as cursor/commands/<name>.age", async () => {
    const { snapshotCursor } = cursorModule;
    mkdirSync(mockCursorPaths.commandsDir, { recursive: true });
    writeFileSync(join(mockCursorPaths.commandsDir, "fix.md"), "# Fix\nFix the bug.", "utf8");
    writeFileSync(join(mockCursorPaths.commandsDir, "explain.md"), "# Explain\nExplain.", "utf8");

    const result = await snapshotCursor();
    const commands = result.artifacts.filter((a) => a.vaultPath.startsWith("cursor/commands/"));
    expect(commands).toHaveLength(2);
    expect(commands.some((a) => a.vaultPath === "cursor/commands/fix.md.age")).toBe(true);
    expect(commands.some((a) => a.vaultPath === "cursor/commands/explain.md.age")).toBe(true);
  });
});

// ── T027 — cursor apply functions ─────────────────────────────────────────────

describe("cursor apply functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    mockCursorPaths.settingsJson = join(tmpDir, "settings.json");
    mockCursorPaths.mcpGlobal = join(tmpDir, "mcp.json");
    mockCursorPaths.commandsDir = join(tmpDir, "commands");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applyCursorRules merges rules into existing settings.json, preserving other keys", async () => {
    const { applyCursorRules } = cursorModule;
    await writeFile(
      mockCursorPaths.settingsJson,
      JSON.stringify({ theme: "dark", fontSize: 14 }),
      "utf8",
    );

    await applyCursorRules("Always write tests");

    const written = JSON.parse(await Bun.file(mockCursorPaths.settingsJson).text()) as Record<
      string,
      unknown
    >;
    expect(written.rules).toBe("Always write tests");
    expect(written.theme).toBe("dark");
    expect(written.fontSize).toBe(14);
  });

  test("applyCursorRules creates new settings.json when file does not exist", async () => {
    const { applyCursorRules } = cursorModule;
    await applyCursorRules("My new rules");

    const written = JSON.parse(await Bun.file(mockCursorPaths.settingsJson).text()) as Record<
      string,
      unknown
    >;
    expect(written.rules).toBe("My new rules");
  });

  test("applyCursorMcp writes content to mcpGlobal path", async () => {
    const { applyCursorMcp } = cursorModule;
    const content = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
    await applyCursorMcp(content);
    expect(await Bun.file(mockCursorPaths.mcpGlobal).text()).toBe(content);
  });

  test("applyCursorCommand writes named command file under commandsDir", async () => {
    const { applyCursorCommand } = cursorModule;
    await applyCursorCommand("my-cmd.md", "# My Cmd\nDo things.");

    const target = join(mockCursorPaths.commandsDir, "my-cmd.md");
    expect(await Bun.file(target).text()).toBe("# My Cmd\nDo things.");
  });
});

// ── T028 — dryRun vault apply ─────────────────────────────────────────────────

describe("applyCursorVault dryRun", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    mockCursorPaths.settingsJson = join(tmpDir, "settings.json");
    mockCursorPaths.mcpGlobal = join(tmpDir, "mcp.json");
    mockCursorPaths.commandsDir = join(tmpDir, "commands");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dryRun=true does not write any local files", async () => {
    const { applyCursorVault } = cursorModule;
    const { encryptString } = await import("../../core/encryptor");
    const { identity, recipient } = await createAgeIdentity();

    const vaultDir = join(tmpDir, "vault");
    const cursorVaultDir = join(vaultDir, "cursor");
    await mkdir(cursorVaultDir, { recursive: true });

    const encrypted = await encryptString("Always use TDD", [recipient]);
    await writeFile(join(cursorVaultDir, "user-rules.md.age"), encrypted, "utf8");

    await applyCursorVault(vaultDir, identity, true);

    // settings.json must NOT be created on dryRun
    expect(await Bun.file(mockCursorPaths.settingsJson).exists()).toBe(false);
  });
});
