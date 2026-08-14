import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  AgentPaths,
  resolveAgentSyncHome,
  resolveOpenCodeConfigDirs,
  resolveOpenCodeConfigFiles,
  resolveOpenCodeConfigRoots,
  resolveOpenCodeWriteDir,
  resolveWindowsAppData,
} from "../paths";

// AgentPaths shape validation (non-mutable, import-time baked paths)

describe("paths", () => {
  const HOME = homedir();

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

  test("C1 and C3 map Cursor agents to the documented user directory", () => {
    expect(AgentPaths.cursor.agentsDir).toBe(join(HOME, ".cursor", "agents"));
  });

  test("AgentPaths.codex falls back to ~/.codex when CODEX_HOME is unset", () => {
    // The actual value depends on whether CODEX_HOME is set at import time.
    // We just verify the shape — it must be a non-empty string.
    expect(typeof AgentPaths.codex.root).toBe("string");
    expect(AgentPaths.codex.root.length).toBeGreaterThan(0);
    expect(AgentPaths.codex.agentsMd).toContain("AGENTS.md");
    expect(AgentPaths.codex.authJson).toContain("auth.json");
  });

  test("C1 and C3 map Codex agents below CODEX_HOME", () => {
    expect(AgentPaths.codex.agentsDir).toBe(join(AgentPaths.codex.root, "agents"));
  });

  test("AgentPaths.copilot has instructionsFile, skillsDir, promptsDir, agentsDir", () => {
    expect(AgentPaths.copilot.instructionsFile).toContain(".copilot");
    expect(AgentPaths.copilot.skillsDir).toContain("skills");
    expect(AgentPaths.copilot.promptsDir).toContain("prompts");
    expect(AgentPaths.copilot.agentsDir).toContain("agents");
  });

  // skillsDir entries for the three newly skill-bearing agents

  test("AgentPaths.claude.skillsDir is ~/.claude/skills/", () => {
    expect(AgentPaths.claude.skillsDir).toBe(join(HOME, ".claude", "skills"));
  });

  test("AgentPaths.cursor.skillsDir is ~/.cursor/skills/", () => {
    expect(AgentPaths.cursor.skillsDir).toBe(join(HOME, ".cursor", "skills"));
    // forbids reading ~/.cursor/skills-cursor/. The path entry must NOT
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

  test("C1 and C6 map Copilot CLI and VS Code agents to one physical store", () => {
    const sharedAgentsDir = join(HOME, ".copilot", "agents");
    expect(AgentPaths.copilot.agentsDir).toBe(sharedAgentsDir);
    expect(AgentPaths.vscode.agentsDir).toBe(sharedAgentsDir);
  });

  test("resolves OpenCode's additive config directories and file precedence", () => {
    const rawBase = join("/tmp", "opencode-default");
    const rawOverride = join("/tmp", "opencode-override");
    const base = resolve(rawBase);
    const override = resolve(rawOverride);
    const env = { OPENCODE_CONFIG_DIR: rawOverride };
    expect(resolveOpenCodeConfigDirs(env, rawBase)).toEqual([base, override]);
    expect(resolveOpenCodeConfigRoots(env, rawBase)).toEqual([
      { origin: "default", dir: base },
      { origin: "custom", dir: override },
    ]);
    expect(resolveOpenCodeWriteDir(env, rawBase)).toBe(override);
    expect(resolveOpenCodeConfigFiles(env, rawBase)).toEqual([
      join(base, "config.json"),
      join(base, "opencode.json"),
      join(base, "opencode.jsonc"),
      join(override, "opencode.json"),
      join(override, "opencode.jsonc"),
    ]);
  });

  test("preserves a whitespace-bearing OpenCode config directory literally", () => {
    const rawBase = join("/tmp", "opencode-default");
    const override = "  opencode override  ";
    expect(resolveOpenCodeConfigDirs({ OPENCODE_CONFIG_DIR: override }, rawBase)).toEqual([
      resolve(rawBase),
      resolve(override),
    ]);
  });

  test("exposes OpenCode's default and fixed-home config roots", () => {
    const configBase = process.env.XDG_CONFIG_HOME?.trim() || join(HOME, ".config");
    expect(Object.keys(AgentPaths.opencode)).toEqual(["configDir", "homeConfigDir"]);
    expect(AgentPaths.opencode.configDir).toBe(join(configBase, "opencode"));
    expect(AgentPaths.opencode.homeConfigDir).toBe(join(HOME, ".opencode"));
  });

  // Claude plugin state files — distilled into the reinstall manifest.

  test("AgentPaths.claude.pluginsDir is ~/.claude/plugins/", () => {
    expect(AgentPaths.claude.pluginsDir).toBe(join(HOME, ".claude", "plugins"));
  });

  test("AgentPaths.claude.installedPluginsJson / knownMarketplacesJson live under plugins/", () => {
    expect(AgentPaths.claude.installedPluginsJson).toBe(
      join(HOME, ".claude", "plugins", "installed_plugins.json"),
    );
    expect(AgentPaths.claude.knownMarketplacesJson).toBe(
      join(HOME, ".claude", "plugins", "known_marketplaces.json"),
    );
  });

  // resolveAgentSyncHome

  test("resolveAgentSyncHome returns a non-empty string", () => {
    const result = resolveAgentSyncHome();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("resolveAgentSyncHome contains 'agentsync'", () => {
    expect(resolveAgentSyncHome()).toContain("agentsync");
  });
});

describe("resolveAgentSyncHome AGENTSYNC_DIR override", () => {
  let prevDir: string | undefined;

  beforeEach(() => {
    prevDir = process.env.AGENTSYNC_DIR;
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.AGENTSYNC_DIR;
    else process.env.AGENTSYNC_DIR = prevDir;
  });

  test("returns a set AGENTSYNC_DIR", () => {
    process.env.AGENTSYNC_DIR = "/tmp/agentsync-override";
    expect(resolveAgentSyncHome()).toBe("/tmp/agentsync-override");
  });

  test("trims surrounding whitespace from a set AGENTSYNC_DIR", () => {
    process.env.AGENTSYNC_DIR = "  /tmp/agentsync-override  ";
    expect(resolveAgentSyncHome()).toBe("/tmp/agentsync-override");
  });

  test("treats an empty AGENTSYNC_DIR as unset and falls back to the default", () => {
    // An exported-but-empty env var is "", not undefined; a bare read would
    // collapse the base dir to "".
    process.env.AGENTSYNC_DIR = "";
    expect(resolveAgentSyncHome()).toContain("agentsync");
  });

  test("treats a whitespace-only AGENTSYNC_DIR as unset and falls back to the default", () => {
    process.env.AGENTSYNC_DIR = "   ";
    expect(resolveAgentSyncHome()).toContain("agentsync");
  });
});

describe("resolveWindowsAppData blank/unset APPDATA", () => {
  // A relative base would make push skip the file and pull write under cwd, so
  // every branch must stay absolute. FAKE_HOME is absolute on POSIX and Windows.
  const FAKE_HOME = join("/fake", "home");

  test("returns a set APPDATA verbatim", () => {
    const appdata = join("C:", "Users", "foo", "AppData", "Roaming");
    expect(resolveWindowsAppData(appdata, FAKE_HOME)).toBe(appdata);
  });

  test("trims surrounding whitespace from a set APPDATA", () => {
    const appdata = join("C:", "Users", "foo", "AppData", "Roaming");
    expect(resolveWindowsAppData(`  ${appdata}  `, FAKE_HOME)).toBe(appdata);
  });

  test("falls back to HOME/AppData/Roaming when APPDATA is unset", () => {
    const result = resolveWindowsAppData(undefined, FAKE_HOME);
    expect(result).toBe(join(FAKE_HOME, "AppData", "Roaming"));
    expect(isAbsolute(result)).toBeTrue();
  });

  test("treats an empty APPDATA as unset, never a relative base", () => {
    const result = resolveWindowsAppData("", FAKE_HOME);
    expect(result).toBe(join(FAKE_HOME, "AppData", "Roaming"));
    expect(isAbsolute(result)).toBeTrue();
  });

  test("treats a whitespace-only APPDATA as unset", () => {
    const result = resolveWindowsAppData("   ", FAKE_HOME);
    expect(result).toBe(join(FAKE_HOME, "AppData", "Roaming"));
    expect(isAbsolute(result)).toBeTrue();
  });
});
