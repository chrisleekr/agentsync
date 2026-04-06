import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { type AgentDefinition, type AgentName, Agents } from "../agents/registry";
import { loadConfig, resolveConfigPath } from "../config/loader";
import { GitClient } from "../core/git";
import { loadPrivateKey, resolveRuntimeContext } from "./shared";

let agentDefinitions: AgentDefinition[] = Agents;

export function __setPullAgentsForTesting(agents: AgentDefinition[] | null): void {
  agentDefinitions = agents ?? Agents;
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
  try {
    const runtime = await resolveRuntimeContext();
    const config = await loadConfig(resolveConfigPath(runtime.vaultDir));
    const key = await loadPrivateKey(runtime.privateKeyPath);

    const git = new GitClient(runtime.vaultDir);
    await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      force: options.force,
    });

    const requestedAgent = options.agent as AgentName | undefined;
    const agentsToSync = agentDefinitions.filter((a) => {
      if (requestedAgent) return a.name === requestedAgent;
      return config.agents[a.name as keyof typeof config.agents] === true;
    });

    for (const agent of agentsToSync) {
      await agent.apply(runtime.vaultDir, key, options.dryRun ?? false);
      applied++;
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    fatal = true;
  }
  return { applied, errors, fatal };
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
