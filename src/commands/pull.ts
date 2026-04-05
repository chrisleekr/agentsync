import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { type AgentName, Agents } from "../agents/registry";
import { loadConfig, resolveConfigPath } from "../config/loader";
import { GitClient } from "../core/git";
import { loadPrivateKey, resolveRuntimeContext } from "./shared";

/** Pull the vault, decrypt enabled agent artifacts, and apply them locally. */
export async function performPull(
  options: { agent?: string; dryRun?: boolean } = {},
): Promise<{ applied: number; errors: string[] }> {
  const errors: string[] = [];
  let applied = 0;
  try {
    const runtime = await resolveRuntimeContext();
    const config = await loadConfig(resolveConfigPath(runtime.vaultDir));
    const key = await loadPrivateKey(runtime.privateKeyPath);

    const git = new GitClient(runtime.vaultDir);
    await git.pull("origin", config.remote.branch);

    const requestedAgent = options.agent as AgentName | undefined;
    const agentsToSync = Agents.filter((a) => {
      if (requestedAgent) return a.name === requestedAgent;
      return config.agents[a.name as keyof typeof config.agents] === true;
    });

    for (const agent of agentsToSync) {
      await agent.apply(runtime.vaultDir, key, options.dryRun ?? false);
      applied++;
    }
  } catch (err) {
    errors.push(String(err));
  }
  return { applied, errors };
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
    });
    for (const err of result.errors) {
      log.error(err);
    }
    if (!args.dryRun) {
      log.success(`Pull completed: ${result.applied} agent(s) synced.`);
    }
  },
});
