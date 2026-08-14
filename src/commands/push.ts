import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { type AgentDefinition, type AgentName, Agents } from "../agents/registry";
import { snapshotSafetyIssues, walkerWarningMatchesSelection } from "../agents/snapshot-safety";
import { machineVaultRoot } from "../config/paths";
import { encryptString } from "../core/encryptor";
import { GitClient } from "../core/git";
import { securityToPolicy, shouldNeverSync } from "../core/sanitizer";
import { loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

let agentDefinitions: AgentDefinition[] = Agents;

export function __setPushAgentsForTesting(agents: AgentDefinition[] | null): void {
  agentDefinitions = agents ?? Agents;
}

/**
 * Decide whether a walker warning is in scope for a path-filtered push.
 *
 * Walker warnings carry the interior path of the offending file inside a
 * skill bundle (e.g. `claude/skills/foo/SKILL.md`). The vault path for the
 * skill itself is `<agent>/skills/<name>.tar.age`. We strip the `.tar.age`
 * suffix from each selected skill vault path and check whether the warning
 * mentions that skill's directory. If yes, the user is explicitly trying to
 * push a skill the walker rejected and the warning must escalate to a fatal
 * abort. Non-skill selections cannot match any walker warning by
 * construction (warnings only fire from the skills-walker).
 */
export { walkerWarningMatchesSelection };

/** Preview entry emitted to onPreview callbacks during a dry-run push. */
export type PushPreviewEntry = {
  agent: AgentName;
  sourcePath: string;
  vaultPath: string;
  targetPath: string;
  skipped: boolean;
  skipReason?: string;
};

/**
 * Snapshot local agent state, encrypt it, and publish the resulting vault changes.
 * @param options Optional agent filter, dry-run flag, commit message override, and dry-run preview callback.
 * @returns The number of written artifacts, collected errors, and whether the run failed fatally.
 */
export async function performPush(
  options: {
    agent?: string;
    dryRun?: boolean;
    message?: string;
    onPreview?: (entry: PushPreviewEntry) => void;
    /** Optional allowlist of relative vault paths (e.g. `claude/CLAUDE.md.age`)
     *  to push. When provided, only matching artifacts are scanned and
     *  written — secrets in unselected files do NOT abort the push. When
     *  omitted (CLI default) every enabled-agent artifact is processed,
     *  preserving the original full-scan abort-on-secret behaviour. */
    vaultPaths?: Set<string>;
  } = {},
): Promise<{ pushed: number; errors: string[]; fatal: boolean }> {
  const errors: string[] = [];
  let pushed = 0;
  let fatal = false;

  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);
  // v2: every artifact lands under this machine's namespace, never the flat root.
  const machineRoot = machineVaultRoot(runtime.vaultDir, runtime.machineName);
  const recipients = Object.values(config.recipients);
  // Secret-scan policy from [security]: honours mode (standard/strict/off) and
  // the allow-list for the central artifact-body scan below.
  const secretPolicy = securityToPolicy(config.security);

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

  // When the caller passes a `vaultPaths` allowlist (e.g. the TUI handing
  // through a Sync-tab selection) we filter every agent's artifact list
  // down to the matching subset BEFORE running the secret scan. Secrets in
  // unselected files are still in your working tree and still bad, but they
  // are not in scope for THIS push and must not abort it.
  const pathFilter = options.vaultPaths;

  for (const agent of agentsToSync) {
    const raw = await agent.snapshot(config);
    // Shallow-copy with a filtered artifacts array so we never mutate the
    // object an adapter returned. Adapters are free to memoise or share
    // state across calls; in-place mutation here would leak between pushes.
    const snapshot =
      pathFilter !== undefined
        ? { ...raw, artifacts: raw.artifacts.filter((a) => pathFilter.has(a.vaultPath)) }
        : raw;
    allSnapshots.push({ agent, snapshot });
    secretErrors.push(...snapshotSafetyIssues(agent.name, snapshot, secretPolicy, pathFilter));
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
      const target = join(machineRoot, artifact.vaultPath);

      // Guard: never sync files matching global never-sync patterns. In
      // dry-run, the SKIP signal goes only through onPreview so the CLI
      // renders one line per artifact. In a real push, the warning goes
      // onto allWarnings so the post-run summary still surfaces it.
      // Emitting both in dry-run would double-print the same artifact
      // (onPreview → SKIP line, then result.errors → log.warn).
      if (shouldNeverSync(artifact.sourcePath)) {
        if (options.dryRun) {
          options.onPreview?.({
            agent: agent.name,
            sourcePath: artifact.sourcePath,
            vaultPath: artifact.vaultPath,
            targetPath: target,
            skipped: true,
            skipReason: "never-sync",
          });
        } else {
          allWarnings.push(
            `[${agent.name}] Skipped ${artifact.sourcePath} — matches never-sync pattern`,
          );
        }
        continue;
      }

      if (options.dryRun) {
        options.onPreview?.({
          agent: agent.name,
          sourcePath: artifact.sourcePath,
          vaultPath: artifact.vaultPath,
          targetPath: target,
          skipped: false,
        });
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
      description: "Specific agent to sync (cursor|claude|codex|copilot|vscode|opencode)",
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

    const result = await performPush({
      agent: requestedAgent,
      dryRun: args.dryRun === true,
      message: args.message as string | undefined,
      onPreview: args.dryRun
        ? (entry) => {
            if (entry.skipped) {
              const reason = entry.skipReason ?? "skipped";
              log.warn(`[dry-run] [${entry.agent}] SKIP ${entry.sourcePath} — ${reason}`);
            } else {
              log.info(`[dry-run] [${entry.agent}] ${entry.sourcePath} → ${entry.targetPath}`);
            }
          }
        : undefined,
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

    if (args.dryRun) {
      return;
    }

    if (result.pushed === 0) {
      log.info("Nothing to push.");
    } else {
      log.success(`Pushed ${result.pushed} encrypted artifact(s).`);
    }
  },
});
