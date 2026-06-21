import { homedir } from "node:os";
import { join } from "node:path";
import { nonBlank } from "../lib/env";

const HOME = homedir();
const PLATFORM = process.platform;

/**
 * Root of one machine's namespace inside the vault: `<vaultDir>/machines/<name>`.
 * Vault format v2 stores every artifact under this prefix so each machine backs
 * up into its own directory and never overwrites another's. The single
 * chokepoint for the per-machine layout — push writes here, and pull/status read
 * from here by passing this as the "vault dir" to the apply/scan layer.
 */
export function machineVaultRoot(vaultDir: string, machineName: string): string {
  return join(vaultDir, "machines", machineName);
}

/**
 * Resolve the Windows %APPDATA% base (= %USERPROFILE%\AppData\Roaming).
 *
 * nonBlank collapses an exported-but-empty APPDATA to undefined so the result
 * stays absolute. A bare `?? ""` left an unset or blank var as a relative base,
 * which push silently skipped (the file reads as "not found") and pull misplaced
 * under process.cwd() instead of restoring it. This mirrors how CODEX_HOME and
 * resolveAgentSyncHome already handle the same blank-env case. Parameterized so
 * the blank/unset behaviour is testable on any platform.
 */
export function resolveWindowsAppData(
  appdata: string | undefined = process.env.APPDATA,
  home: string = HOME,
): string {
  return nonBlank(appdata) ?? join(home, "AppData", "Roaming");
}

/** Platform-aware locations for the agent files that AgentSync snapshots and restores. */
export const AgentPaths = {
  cursor: {
    mcpGlobal: join(HOME, ".cursor", "mcp.json"),
    commandsDir: join(HOME, ".cursor", "commands"),
    skillsDir: join(HOME, ".cursor", "skills"),
    // ~/.cursor/rules/*.{md,mdc} — global rules folder (companion to Cursor's
    // workspace-relative .cursor/rules/*.mdc Project Rules). Used by the
    // migrate `rules` ConfigType for cross-agent passthrough.
    rulesDir: join(HOME, ".cursor", "rules"),
    settingsJson: (() => {
      if (PLATFORM === "darwin") {
        return join(HOME, "Library", "Application Support", "Cursor", "User", "settings.json");
      }
      if (PLATFORM === "win32") {
        return join(resolveWindowsAppData(), "Cursor", "User", "settings.json");
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
    // Claude Code plugin state (upstream: anthropics/claude-code). We no longer
    // encrypt the plugin tree; instead we distil these two state files into a
    // reinstall manifest (see agents/claude/plugin-manifest.ts).
    pluginsDir: join(HOME, ".claude", "plugins"),
    installedPluginsJson: join(HOME, ".claude", "plugins", "installed_plugins.json"),
    knownMarketplacesJson: join(HOME, ".claude", "plugins", "known_marketplaces.json"),
  },
  codex: (() => {
    const CODEX_HOME = nonBlank(process.env.CODEX_HOME) ?? join(HOME, ".codex");
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
    // GitHub Copilot CLI MCP config. Same `mcpServers{}` JSON shape as Claude.
    // Managed via `/mcp add|edit|delete` in interactive Copilot CLI mode.
    // https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
    mcpConfigJson: join(HOME, ".copilot", "mcp-config.json"),
    // Copilot agents live as single ~/.copilot/agents/<name>.agent.md files,
    // not per-agent directories.
    agentsDir: join(HOME, ".copilot", "agents"),
    vscodeMcpInSettings: (() => {
      if (PLATFORM === "darwin") {
        return join(HOME, "Library", "Application Support", "Code", "User", "settings.json");
      }
      if (PLATFORM === "win32") {
        return join(resolveWindowsAppData(), "Code", "User", "settings.json");
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
        return join(resolveWindowsAppData(), "Code", "User", "mcp.json");
      }
      return join(HOME, ".config", "Code", "User", "mcp.json");
    })(),
  },
} as const;

/**
 * Resolve the OS-specific base directory used for AgentSync state — the single
 * root under which the vault clone, private key, and update-check cache live.
 *
 * `AGENTSYNC_DIR` overrides the default location (read at call time so tests
 * and wrapper scripts can redirect it). A blank value is treated as unset, so
 * an exported-but-empty `AGENTSYNC_DIR=` does not collapse the base dir to "".
 * The override is intentionally not named `AGENTSYNC_HOME`: `${AGENTSYNC_HOME}`
 * is already the vault path-portability placeholder for the user's OS home
 * directory, a different path.
 */
export function resolveAgentSyncHome(): string {
  const override = nonBlank(process.env.AGENTSYNC_DIR);
  if (override) {
    return override;
  }
  if (process.platform === "win32") {
    return join(nonBlank(process.env.APPDATA) ?? HOME, "agentsync");
  }
  return join(HOME, ".config", "agentsync");
}
