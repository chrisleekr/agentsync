import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { applyClaudeVault, type ClaudeSyncOptions, snapshotClaude } from "../agents/claude";
import { type AgentDefinition, type AgentName, Agents } from "../agents/registry";
import { identityToRecipient } from "../core/encryptor";
import { GitClient } from "../core/git";
import { loadPrivateKey, loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

const AGE_NO_IDENTITY_MARKER = "no identity matched any of the file's recipients";

let agentDefinitions: AgentDefinition[] = Agents;

export function __setPullAgentsForTesting(agents: AgentDefinition[] | null): void {
  agentDefinitions = agents ?? Agents;
}

const REGISTRY_CLAUDE = Agents.find((a) => a.name === "claude");

/**
 * Inject the Claude plugin/marketplace opt-in flag into the registry's claude
 * entry. Test fakes installed via `__setPullAgentsForTesting` are different
 * object references and pass through unchanged.
 */
function withClaudeOptions(agent: AgentDefinition, claudeOpts: ClaudeSyncOptions): AgentDefinition {
  if (agent !== REGISTRY_CLAUDE) return agent;
  return {
    ...agent,
    snapshot: () => snapshotClaude(claudeOpts),
    apply: (vaultDir, key, dryRun) => applyClaudeVault(vaultDir, key, dryRun, claudeOpts),
  };
}

/**
 * Pull the vault, decrypt enabled agent artifacts, and apply them locally.
 * @param options Optional agent filter, dry-run mode, and force flag to skip conflict prompts.
 * @returns The number of applied agents, collected errors, and whether the run failed fatally.
 */
export async function performPull(
  options: { agent?: string; dryRun?: boolean; force?: boolean } = {},
): Promise<{ applied: number; errors: string[]; fatal: boolean }> {
  const errors: string[] = [];
  let applied = 0;
  let fatal = false;
  // Keep runtime + config resolution inside the outer try so non-ENOENT
  // failures (zod schema errors, mkdir EACCES, etc.) become a friendly
  // errors[] row instead of bubbling out as a Node stack trace.
  // loadVaultConfigOrExit's process.exit(1) for ENOENT terminates before
  // any catch runs, so the missing-vault path is unaffected.
  try {
    const runtime = await resolveRuntimeContext();
    const config = await loadVaultConfigOrExit(runtime.vaultDir);
    const key = await loadPrivateKey(runtime.privateKeyPath);

    const git = new GitClient(runtime.vaultDir);
    await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      force: options.dryRun ? false : options.force,
    });

    const requestedAgent = options.agent as AgentName | undefined;
    const claudeOpts: ClaudeSyncOptions = {
      syncMarketplace: config.claudePlugins?.syncMarketplace ?? false,
    };
    const agentsToSync = agentDefinitions
      .filter((a) => {
        if (requestedAgent) return a.name === requestedAgent;
        return config.agents[a.name as keyof typeof config.agents] === true;
      })
      .map((a) => withClaudeOptions(a, claudeOpts));

    for (const agent of agentsToSync) {
      try {
        await agent.apply(runtime.vaultDir, key, options.dryRun ?? false);
        applied++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes(AGE_NO_IDENTITY_MARKER)) {
          errors.push(await buildRecipientHandoffHint(runtime.machineName, key));
          fatal = true;
          return { applied, errors, fatal };
        }
        throw err;
      }
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    fatal = true;
  }
  return { applied, errors, fatal };
}

/**
 * The vault was decryptable by another machine but not by us. Translate the
 * raw age library error into the missing-handoff guidance: this machine's
 * pubkey isn't in the recipient set yet, so an existing recipient must run
 * `agentsync key add <name> <pubkey>` to re-encrypt the vault for us.
 */
async function buildRecipientHandoffHint(machineName: string, identity: string): Promise<string> {
  let pubkeyLine = "(unable to derive local pubkey — re-run after `agentsync init`)";
  try {
    const recipient = await identityToRecipient(identity);
    pubkeyLine = recipient;
  } catch {
    // identity unreadable — fall back to generic guidance below.
  }
  return [
    "Cannot decrypt vault: this machine's age key is not in the recipient set.",
    "An existing machine that can decrypt the vault must add this machine as a recipient:",
    `  agentsync key add ${machineName} ${pubkeyLine}`,
    "Until then, `pull` will fail.",
  ].join("\n");
}

/** CLI wrapper around the pull pipeline with optional agent filtering and dry-run output. */
export const pullCommand = defineCommand({
  meta: {
    name: "pull",
    description: "Pull and apply vault configs locally",
  },
  args: {
    agent: { type: "string", description: "Specific agent to sync (cursor|claude|codex|copilot)" },
    dryRun: { type: "boolean", description: "Show actions without applying", default: false },
    force: {
      type: "boolean",
      description: "Force remote apply without conflict prompts",
      default: false,
    },
  },
  async run({ args }) {
    const result = await performPull({
      agent: args.agent as string | undefined,
      dryRun: args.dryRun,
      force: args.force,
    });
    for (const err of result.errors) {
      log.error(err);
    }
    if (result.fatal) {
      process.exitCode = 1;
      return;
    }
    if (!args.dryRun) {
      log.success(`Pull completed: ${result.applied} agent(s) synced.`);
    }
  },
});
