import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentPaths, resolveAgentSyncHome, resolveDaemonSocketPath } from "../paths";

// T015 — AgentPaths shape validation (non-mutable, import-time baked paths)

describe("paths", () => {
  const HOME = homedir();
  const PLATFORM = process.platform;

  test("AgentPaths.claude.claudeMd is under HOME/.claude/", () => {
    expect(AgentPaths.claude.claudeMd).toBe(join(HOME, ".claude", "CLAUDE.md"));
  });

  test("AgentPaths.claude.mcpJson is ~/.claude.json", () => {
    expect(AgentPaths.claude.mcpJson).toBe(join(HOME, ".claude.json"));
  });

  test("AgentPaths.claude.credentials is under ~/.claude/", () => {
    expect(AgentPaths.claude.credentials).toBe(join(HOME, ".claude", ".credentials.json"));
  });

  test("AgentPaths.cursor has mcpGlobal, commandsDir, settingsJson", () => {
    expect(AgentPaths.cursor.mcpGlobal).toBe(join(HOME, ".cursor", "mcp.json"));
    expect(AgentPaths.cursor.commandsDir).toBe(join(HOME, ".cursor", "commands"));
    expect(typeof AgentPaths.cursor.settingsJson).toBe("string");
    expect(AgentPaths.cursor.settingsJson.length).toBeGreaterThan(0);
  });

  test("AgentPaths.codex falls back to ~/.codex when CODEX_HOME is unset", () => {
    // The actual value depends on whether CODEX_HOME is set at import time.
    // We just verify the shape — it must be a non-empty string.
    expect(typeof AgentPaths.codex.root).toBe("string");
    expect(AgentPaths.codex.root.length).toBeGreaterThan(0);
    expect(AgentPaths.codex.agentsMd).toContain("AGENTS.md");
    expect(AgentPaths.codex.authJson).toContain("auth.json");
  });

  test("AgentPaths.copilot has instructionsFile, skillsDir, promptsDir, agentsDir", () => {
    expect(AgentPaths.copilot.instructionsFile).toContain(".copilot");
    expect(AgentPaths.copilot.skillsDir).toContain("skills");
    expect(AgentPaths.copilot.promptsDir).toContain("prompts");
    expect(AgentPaths.copilot.agentsDir).toContain("agents");
  });

  // T003 — skillsDir entries for the three newly skill-bearing agents (FR-001, FR-010)

  test("AgentPaths.claude.skillsDir is ~/.claude/skills/", () => {
    expect(AgentPaths.claude.skillsDir).toBe(join(HOME, ".claude", "skills"));
  });

  test("AgentPaths.cursor.skillsDir is ~/.cursor/skills/ (FR-010 canonical path)", () => {
    expect(AgentPaths.cursor.skillsDir).toBe(join(HOME, ".cursor", "skills"));
    // FR-010 forbids reading ~/.cursor/skills-cursor/. The path entry must NOT
    // resolve to that location regardless of platform.
    expect(AgentPaths.cursor.skillsDir).not.toContain("skills-cursor");
  });

  test("AgentPaths.codex.skillsDir is under the Codex root", () => {
    expect(AgentPaths.codex.skillsDir).toContain("skills");
    expect(AgentPaths.codex.skillsDir.startsWith(AgentPaths.codex.root)).toBe(true);
  });

  test("AgentPaths.vscode does NOT have a skillsDir (regression)", () => {
    // VS Code is not a skill-bearing agent for this feature. A future
    // accidental addition would silently grow the surface — fail loudly.
    expect((AgentPaths.vscode as Record<string, unknown>).skillsDir).toBeUndefined();
  });

  test("AgentPaths.vscode.mcpJson is a non-empty string", () => {
    expect(typeof AgentPaths.vscode.mcpJson).toBe("string");
    expect(AgentPaths.vscode.mcpJson.length).toBeGreaterThan(0);
  });

  // T016 — resolveAgentSyncHome / resolveDaemonSocketPath

  test("resolveAgentSyncHome returns a non-empty string", () => {
    const result = resolveAgentSyncHome();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("resolveAgentSyncHome contains 'agentsync'", () => {
    expect(resolveAgentSyncHome()).toContain("agentsync");
  });

  test("resolveDaemonSocketPath ends with daemon.sock on non-Windows", () => {
    if (PLATFORM !== "win32") {
      expect(resolveDaemonSocketPath()).toEndWith("daemon.sock");
    }
  });

  test("resolveDaemonSocketPath on Windows returns a named pipe", () => {
    if (PLATFORM === "win32") {
      expect(resolveDaemonSocketPath()).toStartWith("\\\\.\\pipe\\");
    }
  });

  test("resolveDaemonSocketPath is inside resolveAgentSyncHome on non-Windows", () => {
    if (PLATFORM !== "win32") {
      expect(resolveDaemonSocketPath()).toStartWith(resolveAgentSyncHome());
    }
  });
});
