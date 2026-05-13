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
    // User-customary rules folder (~/.claude/rules/*.md). Not part of the
    // Anthropic settings schema, but widely used to keep cross-project
    // guidance alongside CLAUDE.md.
    rulesDir: join(HOME, ".claude", "rules"),
    // Claude Code plugin layout (upstream: anthropics/claude-code).
    // Plugins live under ~/.claude/plugins/<name>/ and each carries a
    // .claude-plugin/plugin.json manifest plus optional commands/, agents/,
    // hooks/, skills/, and .mcp.json siblings. The marketplace catalog at
    // ~/.claude/.claude-plugin/marketplace.json is opt-in via config.
    pluginsDir: join(HOME, ".claude", "plugins"),
    marketplaceJson: join(HOME, ".claude", ".claude-plugin", "marketplace.json"),
  },
  codex: (() => {
    const CODEX_HOME = process.env.CODEX_HOME ?? join(HOME, ".codex");
    return {
      root: CODEX_HOME,
      agentsMd: join(CODEX_HOME, "AGENTS.md"),
      // Per docs: AGENTS.override.md wins over AGENTS.md when both exist.
      agentsOverrideMd: join(CODEX_HOME, "AGENTS.override.md"),
      configToml: join(CODEX_HOME, "config.toml"),
      // agentsync convention, not in the official codex config reference.
      // Kept for back-compat with existing users.
      rulesDir: join(CODEX_HOME, "rules"),
      authJson: join(CODEX_HOME, "auth.json"),
      // Skill-dir precedence on read: userSkillsDir wins, skillsDir is
      // legacy fallback for installs predating the ~/.agents/skills move.
      skillsDir: join(CODEX_HOME, "skills"),
      userSkillsDir: join(HOME, ".agents", "skills"),
    };
  })(),
  copilot: {
    // Canonical filename per GitHub Copilot CLI docs is
    // $HOME/.copilot/copilot-instructions.md, not bare "instructions".
    instructionsFile: join(HOME, ".copilot", "copilot-instructions.md"),
    instructionsDir: join(HOME, ".copilot", "instructions"),
    skillsDir: join(HOME, ".copilot", "skills"),
    promptsDir: join(HOME, ".copilot", "prompts"),
    // Copilot agents live as single ~/.copilot/agents/<name>.agent.md files,
    // not per-agent directories.
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
