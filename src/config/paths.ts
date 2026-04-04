import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const PLATFORM = process.platform;

export const AgentPaths = {
  cursor: {
    mcpGlobal: join(HOME, ".cursor", "mcp.json"),
    commandsDir: join(HOME, ".cursor", "commands"),
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
  },
  codex: {
    root: process.env.CODEX_HOME ?? join(HOME, ".codex"),
    agentsMd: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "AGENTS.md"),
    configToml: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "config.toml"),
    rulesDir: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "rules"),
    authJson: join(process.env.CODEX_HOME ?? join(HOME, ".codex"), "auth.json"),
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

export function resolveAgentSyncHome(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? HOME, "agentsync");
  }
  return join(HOME, ".config", "agentsync");
}

export function resolveDaemonSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\agentsync";
  }
  return join(resolveAgentSyncHome(), "daemon.sock");
}
