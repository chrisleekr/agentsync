import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const PLATFORM = process.platform;

/** Platform-aware locations for the agent files that AgentSync snapshots and restores. */
export const AgentPaths = {
  cursor: {
    mcpGlobal: join(HOME, ".cursor", "mcp.json"),
    commandsDir: join(HOME, ".cursor", "commands"),
    skillsDir: join(HOME, ".cursor", "skills"),
    settingsJson: (() => {
      if (PLATFORM === "darwin") {
        return join(HOME, "Library", "Application Support", "Cursor", "User", "settings.json");
      }
      if (PLATFORM === "win32") {
        return join(process.env.APPDATA ?? "", "Cursor", "User", "settings.json");
      }
      return join(HOME, ".config", "Cursor", "User", "settings.json");
    })(),
  },
  claude: {
    claudeMd: join(HOME, ".claude", "CLAUDE.md"),
    settingsJson: join(HOME, ".claude", "settings.json"),
    commandsDir: join(HOME, ".claude", "commands"),
    agentsDir: join(HOME, ".claude", "agents"),
    mcpJson: join(HOME, ".claude.json"),
    credentials: join(HOME, ".claude", ".credentials.json"),
    skillsDir: join(HOME, ".claude", "skills"),
    // Claude Code plugin layout (upstream: anthropics/claude-code).
    // Plugins live under ~/.claude/plugins/<name>/ and each carries a
    // .claude-plugin/plugin.json manifest plus optional commands/, agents/,
    // hooks/, skills/, and .mcp.json siblings. The marketplace catalog at
    // ~/.claude/.claude-plugin/marketplace.json is opt-in via config.
    pluginsDir: join(HOME, ".claude", "plugins"),
    marketplaceJson: join(HOME, ".claude", ".claude-plugin", "marketplace.json"),
  },
  codex: {
    root: process.env.CODEX_HOME ?? join(HOME, ".codex"),
    agentsMd: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "AGENTS.md"),
    configToml: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "config.toml"),
    rulesDir: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "rules"),
    authJson: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "auth.json"),
    skillsDir: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "skills"),
  },
  copilot: {
    instructionsFile: join(HOME, ".copilot", "instructions"),
    instructionsDir: join(HOME, ".copilot", "instructions"),
    skillsDir: join(HOME, ".copilot", "skills"),
    promptsDir: join(HOME, ".copilot", "prompts"),
    agentsDir: join(HOME, ".copilot", "agents"),
    vscodeMcpInSettings: (() => {
      if (PLATFORM === "darwin") {
        return join(HOME, "Library", "Application Support", "Code", "User", "settings.json");
      }
      if (PLATFORM === "win32") {
        return join(process.env.APPDATA ?? "", "Code", "User", "settings.json");
      }
      return join(HOME, ".config", "Code", "User", "settings.json");
    })(),
  },
  vscode: {
    mcpJson: (() => {
      if (PLATFORM === "darwin") {
        return join(HOME, "Library", "Application Support", "Code", "User", "mcp.json");
      }
      if (PLATFORM === "win32") {
        return join(process.env.APPDATA ?? "", "Code", "User", "mcp.json");
      }
      return join(HOME, ".config", "Code", "User", "mcp.json");
    })(),
  },
} as const;

/**
 * Resolve the canonical sub-paths for a single Claude Code plugin given its root
 * directory (typically `<pluginsDir>/<plugin-name>`). The shape mirrors the
 * primary surfaces a plugin can expose: a `.claude-plugin/plugin.json`
 * manifest plus optional `commands/`, `agents/`, `hooks/`, `skills/`, and
 * `.mcp.json` siblings.
 */
export function resolveClaudePluginPaths(pluginRoot: string): {
  root: string;
  manifest: string;
  commandsDir: string;
  agentsDir: string;
  hooksDir: string;
  mcpJson: string;
  skillsDir: string;
} {
  return {
    root: pluginRoot,
    manifest: join(pluginRoot, ".claude-plugin", "plugin.json"),
    commandsDir: join(pluginRoot, "commands"),
    agentsDir: join(pluginRoot, "agents"),
    hooksDir: join(pluginRoot, "hooks"),
    mcpJson: join(pluginRoot, ".mcp.json"),
    skillsDir: join(pluginRoot, "skills"),
  };
}

/** Resolve the OS-specific base directory used for AgentSync state. */
export function resolveAgentSyncHome(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? HOME, "agentsync");
  }
  return join(HOME, ".config", "agentsync");
}

/** Resolve the local IPC endpoint used by the background daemon. */
export function resolveDaemonSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\agentsync";
  }
  return join(resolveAgentSyncHome(), "daemon.sock");
}
