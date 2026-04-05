import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { type AgentDefinition, type AgentName, Agents } from "../agents/registry";
import { loadConfig, resolveConfigPath } from "../config/loader";
import { encryptString } from "../core/encryptor";
import { GitClient } from "../core/git";
import { shouldNeverSync } from "../core/sanitizer";
import { resolveRuntimeContext } from "./shared";

let agentDefinitions: AgentDefinition[] = Agents;

export function __setPushAgentsForTesting(agents: AgentDefinition[] | null): void {
  agentDefinitions = agents ?? Agents;
}

/**
 * Snapshot local agent state, encrypt it, and publish the resulting vault changes.
 * @param options Optional agent filter, dry-run flag, and commit message override.
 * @returns The number of written artifacts, collected errors, and whether the run failed fatally.
 */
export async function performPush(
  options: { agent?: string; dryRun?: boolean; message?: string } = {},
): Promise<{ pushed: number; errors: string[]; fatal: boolean }> {
  const errors: string[] = [];
  let pushed = 0;
  let fatal = false;

  const runtime = await resolveRuntimeContext();
  const config = await loadConfig(resolveConfigPath(runtime.vaultDir));
  const recipients = Object.values(config.recipients);

  if (recipients.length === 0) {
    errors.push("No recipients found in agentsync.toml. Run `agentsync init` first.");
    return { pushed, errors, fatal: true };
  }

  const requestedAgent = options.agent as AgentName | undefined;
  const agentsToSync = agentDefinitions.filter((a) => {
    if (requestedAgent) return a.name === requestedAgent;
    return config.agents[a.name] === true;
  });

  if (agentsToSync.length === 0) {
    return { pushed, errors, fatal };
  }

  const git = new GitClient(runtime.vaultDir);
  const reconciliation = !options.dryRun
    ? await git
        .reconcileWithRemote({
          remote: "origin",
          branch: config.remote.branch,
          allowMissingRemote: true,
        })
        .catch((err) => {
          errors.push(err instanceof Error ? err.message : String(err));
          fatal = true;
          return null;
        })
    : null;

  if (fatal) {
    return { pushed, errors, fatal };
  }

  // Phase 1: collect all snapshots and abort early if any artifact contains a
  // redacted secret literal — we must never encrypt and push plaintext secrets.
  type AgentWithSnapshot = {
    agent: (typeof agentsToSync)[number];
    snapshot: Awaited<ReturnType<(typeof agentsToSync)[number]["snapshot"]>>;
  };
  const allSnapshots: AgentWithSnapshot[] = [];
  const secretErrors: string[] = [];

  for (const agent of agentsToSync) {
    const snapshot = await agent.snapshot();
    allSnapshots.push({ agent, snapshot });
    for (const artifact of snapshot.artifacts) {
      for (const w of artifact.warnings) {
        if (w.startsWith("Redacted literal secret")) {
          secretErrors.push(`[${agent.name}] ${w}`);
        }
      }
    }
  }

  if (secretErrors.length > 0) {
    return {
      pushed: 0,
      fatal: true,
      errors: [
        `Push aborted: ${secretErrors.length} secret(s) detected in agent configs. Remove literal API keys before pushing.`,
        ...secretErrors,
      ],
    };
  }

  // Phase 2: encrypt and write — only reached when no secrets were detected.
  const allWarnings: string[] = [];

  for (const { agent, snapshot } of allSnapshots) {
    if (snapshot.artifacts.length === 0) {
      continue;
    }

    for (const artifact of snapshot.artifacts) {
      // Guard: never sync files matching global never-sync patterns
      if (shouldNeverSync(artifact.sourcePath)) {
        allWarnings.push(
          `[${agent.name}] Skipped ${artifact.sourcePath} — matches never-sync pattern`,
        );
        continue;
      }

      const target = join(runtime.vaultDir, artifact.vaultPath);

      if (options.dryRun) {
        continue;
      }

      await mkdir(dirname(target), { recursive: true });
      const encrypted = await encryptString(artifact.plaintext, recipients);
      await writeFile(target, encrypted, "utf8");
      pushed++;
    }

    allWarnings.push(...snapshot.warnings);
  }

  if (options.dryRun) {
    return { pushed, errors: [...errors, ...allWarnings], fatal };
  }

  if (pushed === 0) {
    return { pushed, errors, fatal };
  }

  const timestamp = new Date().toISOString();
  const agentLabel = requestedAgent ?? "all";
  const commitMessage =
    options.message ?? `sync(${agentLabel}): ${runtime.machineName} ${timestamp}`;

  const committed = await git.commit({ message: commitMessage });
  if (committed) {
    try {
      await git.push(
        "origin",
        config.remote.branch,
        reconciliation?.status === "remote-missing" ? ["--set-upstream"] : [],
      );
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      fatal = true;
    }
  }

  return { pushed, errors: [...errors, ...allWarnings], fatal };
}

/** CLI wrapper around the push pipeline with dry-run and commit-message controls. */
export const pushCommand = defineCommand({
  meta: {
    name: "push",
    description: "Encrypt and push local configs to the vault",
  },
  args: {
    agent: {
      type: "string",
      description: "Specific agent to sync (cursor|claude|codex|copilot)",
    },
    message: { type: "string", description: "Custom commit message" },
    dryRun: {
      type: "boolean",
      description: "Show actions without writing",
      default: false,
    },
  },
  async run({ args }) {
    const requestedAgent = args.agent as string | undefined;

    if (args.dryRun) {
      // Collect dry-run output manually for display
      const runtime = await resolveRuntimeContext();
      const config = await loadConfig(resolveConfigPath(runtime.vaultDir));
      const agentsToSync = agentDefinitions.filter((a) => {
        if (requestedAgent) return a.name === requestedAgent;
        return config.agents[a.name] === true;
      });
      for (const agent of agentsToSync) {
        const snapshot = await agent.snapshot();
        for (const artifact of snapshot.artifacts) {
          if (shouldNeverSync(artifact.sourcePath)) {
            log.warn(`[dry-run] [${agent.name}] SKIP ${artifact.sourcePath} — never-sync`);
            continue;
          }
          const target = join(runtime.vaultDir, artifact.vaultPath);
          log.info(`[dry-run] [${agent.name}] ${artifact.sourcePath} → ${target}`);
        }
      }
      return;
    }

    const result = await performPush({
      agent: requestedAgent,
      dryRun: false,
      message: args.message as string | undefined,
    });

    for (const err of result.errors) {
      if (result.fatal) {
        log.error(err);
      } else {
        log.warn(err);
      }
    }

    if (result.fatal) {
      process.exitCode = 1;
      return;
    }

    if (result.pushed === 0) {
      log.info("Nothing to push.");
    } else {
      log.success(`Pushed ${result.pushed} encrypted artifact(s).`);
    }
  },
});
