import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { applyClaudeVault, type ClaudeSyncOptions, snapshotClaude } from "../agents/claude";
import { type AgentDefinition, type AgentName, Agents } from "../agents/registry";
import { encryptString } from "../core/encryptor";
import { GitClient } from "../core/git";
import { scanForSecrets, shouldNeverSync } from "../core/sanitizer";
import { loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

let agentDefinitions: AgentDefinition[] = Agents;

export function __setPushAgentsForTesting(agents: AgentDefinition[] | null): void {
  agentDefinitions = agents ?? Agents;
}

const REGISTRY_CLAUDE = Agents.find((a) => a.name === "claude");

/**
 * Replace the registry's default Claude entry with one that knows about the
 * Claude plugin/marketplace opt-in flag from agentsync.toml. Test fakes
 * installed via `__setPushAgentsForTesting` are different object references
 * and pass through unchanged so the registry contract stays narrow.
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
  const config = await loadVaultConfigOrExit(runtime.vaultDir);
  const recipients = Object.values(config.recipients);

  if (recipients.length === 0) {
    errors.push("No recipients found in agentsync.toml. Run `agentsync init` first.");
    return { pushed, errors, fatal: true };
  }

  const requestedAgent = options.agent as AgentName | undefined;
  const claudeOpts: ClaudeSyncOptions = {
    syncMarketplace: config.claudePlugins?.syncMarketplace ?? false,
  };
  const agentsToSync = agentDefinitions
    .filter((a) => {
      if (requestedAgent) return a.name === requestedAgent;
      return config.agents[a.name] === true;
    })
    .map((a) => withClaudeOptions(a, claudeOpts));

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
        if (w.startsWith("Detected literal secret")) {
          secretErrors.push(`[${agent.name}] ${w}`);
        }
      }
      // Defense-in-depth chokepoint: scan the raw plaintext that is about to
      // be encrypted for credentials the adapter-level sanitizer never saw —
      // markdown bodies, prompts, and prose-style JSON values. A future agent
      // adapter cannot bypass this by forgetting to call a helper; every byte
      // heading for encryptString flows through here.
      //
      // Skill/agent bundles are base64-encoded tars. Their alphabet
      // statistically overlaps with `AKIA…` and `AIza…` credentials, so
      // scanning the encoded form would false-positive without reliably
      // catching credentials *inside* the bundle (encoding scrambles
      // prefixes). The encoded surface is intentionally skipped here.
      // Bundle internals are covered separately at the walker layer:
      // `collectInteriorViolations` in `src/agents/skills-walker.ts` scans
      // each readable interior file body with `scanForSecrets` before the
      // tar buffer is built, and the Copilot agents walk in
      // `src/agents/copilot.ts` invokes the same helper. Both surface
      // `Detected literal secret …` warnings on the snapshot, which the
      // walker-warning loop below escalates to a fatal abort.
      if (artifact.vaultPath.endsWith(".tar.age")) {
        continue;
      }
      for (const w of scanForSecrets(artifact.plaintext, artifact.sourcePath)) {
        secretErrors.push(`[${agent.name}] ${w}`);
      }
    }
    // Walker-level warnings are emitted on the top-level snapshot.warnings
    // array (not per-artifact, since the offending bundle is dropped before
    // any artifact is built). Two prefixes escalate to a fatal abort:
    //   - `never-sync inside skill: <path>` — a path-pattern hit inside a
    //     skill, so the bundle would have contained a hard never-sync file.
    //   - `Detected literal secret …` — a credential found inside an
    //     interior file body during the walker's per-file scan. The central
    //     scan a few lines above skips `.tar.age` artifacts, so this is the
    //     only layer that catches a key pasted into `SKILL.md`, READMEs, or
    //     any other file inside a skill/agent bundle.
    for (const w of snapshot.warnings) {
      if (w.startsWith("never-sync inside skill: ") || w.startsWith("Detected literal secret")) {
        secretErrors.push(`[${agent.name}] ${w}`);
      }
    }
  }

  if (secretErrors.length > 0) {
    return {
      pushed: 0,
      fatal: true,
      errors: [
        `Push aborted: ${secretErrors.length} security issue(s) detected. Remove literal secrets and never-sync files inside skill directories before pushing.`,
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
      const config = await loadVaultConfigOrExit(runtime.vaultDir);
      const claudeOpts: ClaudeSyncOptions = {
        syncMarketplace: config.claudePlugins?.syncMarketplace ?? false,
      };
      const agentsToSync = agentDefinitions
        .filter((a) => {
          if (requestedAgent) return a.name === requestedAgent;
          return config.agents[a.name] === true;
        })
        .map((a) => withClaudeOptions(a, claudeOpts));
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
