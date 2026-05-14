import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { type AgentDefinition, type AgentName, Agents } from "../agents/registry";
import { NEVER_SYNC_WARNING_PREFIX, WALKER_SECRET_WARNING_PREFIX } from "../agents/skills-walker";
import { encryptString } from "../core/encryptor";
import { GitClient } from "../core/git";
import { scanForSecrets, shouldNeverSync } from "../core/sanitizer";
import { loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

let agentDefinitions: AgentDefinition[] = Agents;

export function __setPushAgentsForTesting(agents: AgentDefinition[] | null): void {
  agentDefinitions = agents ?? Agents;
}

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
  } = {},
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
    const snapshot = await agent.snapshot(config);
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
    //   - `Detected literal secret (<name>) in <path>` — a credential found
    //     inside an interior file body during the walker's per-file scan.
    //     The central scan a few lines above skips `.tar.age` artifacts, so
    //     this is the only layer that catches a key pasted into `SKILL.md`,
    //     READMEs, or any other file inside a skill/agent bundle.
    //
    // The walker prefix is matched with the trailing `(` so it stays distinct
    // from `Detected literal secret for field <name>` emitted by
    // `redactSecretLiterals` (sanitizeClaudeHooks/Mcp/PluginManifest/PluginMcp).
    // Those redactor warnings land on BOTH artifact.warnings AND
    // snapshot.warnings; the per-artifact loop above already catches them, so
    // a broad `Detected literal secret` match here would double-report.
    for (const w of snapshot.warnings) {
      if (w.startsWith(NEVER_SYNC_WARNING_PREFIX) || w.startsWith(WALKER_SECRET_WARNING_PREFIX)) {
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
      const target = join(runtime.vaultDir, artifact.vaultPath);

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
