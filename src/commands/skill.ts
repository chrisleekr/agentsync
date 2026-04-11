import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, resolveConfigPath } from "../config/loader";
import { GitClient } from "../core/git";
import { resolveRuntimeContext } from "./shared";

/**
 * Agents that participate in the skill sync feature. `vscode` is intentionally
 * rejected because its configuration model does not include per-user skills.
 */
const SKILL_BEARING_AGENTS = ["claude", "cursor", "codex", "copilot"] as const;
export type SkillBearingAgent = (typeof SKILL_BEARING_AGENTS)[number];

function isSkillBearingAgent(value: string): value is SkillBearingAgent {
  return (SKILL_BEARING_AGENTS as readonly string[]).includes(value);
}

/** Discriminated result of a `skill remove` invocation. */
export type SkillRemoveResult =
  | { status: "success"; path: string; commitSha: string | null }
  | { status: "unknown-agent"; provided: string; supported: readonly string[] }
  | { status: "not-found"; path: string }
  | { status: "reconcile-error"; error: string }
  | { status: "git-error"; path: string; error: string };

/**
 * Remove a single skill from the vault, commit the deletion, and push. Leaves
 * every local skill directory on every machine untouched (FR-012 + FR-013).
 *
 * This function is the testable core — it returns a discriminated result
 * object instead of throwing or calling `process.exit()` so tests can assert
 * each branch deterministically. The thin citty wrapper at the bottom of this
 * file translates the result into `@clack/prompts` log calls and
 * `process.exitCode`.
 *
 * @param options.agent Name of the skill-bearing agent.
 * @param options.name  Basename of the skill in the vault (no `.tar.age` suffix).
 * @returns A {@link SkillRemoveResult} describing the outcome.
 */
export async function performSkillRemove(options: {
  agent: string;
  name: string;
}): Promise<SkillRemoveResult> {
  if (!isSkillBearingAgent(options.agent)) {
    return {
      status: "unknown-agent",
      provided: options.agent,
      supported: SKILL_BEARING_AGENTS,
    };
  }

  const runtime = await resolveRuntimeContext();
  const config = await loadConfig(resolveConfigPath(runtime.vaultDir));
  const targetPath = join(runtime.vaultDir, options.agent, "skills", `${options.name}.tar.age`);

  try {
    await stat(targetPath);
  } catch {
    return { status: "not-found", path: targetPath };
  }

  const git = new GitClient(runtime.vaultDir);

  try {
    await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      allowMissingRemote: true,
    });
  } catch (err) {
    return {
      status: "reconcile-error",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Re-stat after the reconcile — the remote may have already removed the file
  // as part of an earlier `skill remove` from another machine. If the file is
  // gone post-reconcile, the removal has already happened upstream and there
  // is nothing to do locally except report success without a new commit.
  try {
    await stat(targetPath);
  } catch {
    return { status: "success", path: targetPath, commitSha: null };
  }

  try {
    await unlink(targetPath);
    const committed = await git.commit({
      message: `skill remove(${options.agent}): ${options.name}`,
    });
    if (committed) {
      try {
        await git.push("origin", config.remote.branch);
      } catch (err) {
        return {
          status: "git-error",
          path: targetPath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return {
      status: "success",
      path: targetPath,
      commitSha: committed ? await readHeadShortSha(runtime.vaultDir) : null,
    };
  } catch (err) {
    return {
      status: "git-error",
      path: targetPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read the 7-character short SHA of the current HEAD in a repo. Returns null
 * if git cannot be invoked for any reason — the failure is non-fatal because
 * the SHA is only used for the success log line.
 */
async function readHeadShortSha(repoDir: string): Promise<string | null> {
  const result = Bun.spawnSync(["git", "-C", repoDir, "rev-parse", "--short=7", "HEAD"]);
  if (result.exitCode !== 0) return null;
  const out = new TextDecoder().decode(result.stdout).trim();
  return out.length > 0 ? out : null;
}

/**
 * Thin citty wrapper around {@link performSkillRemove}. Translates the
 * discriminated result into log output and sets `process.exitCode = 1` on any
 * non-success branch so the shell sees a failure.
 */
export const skillCommand = defineCommand({
  meta: {
    name: "skill",
    description: "Manage skills stored in the vault",
  },
  subCommands: {
    remove: defineCommand({
      meta: {
        name: "remove",
        description: "Remove one skill from the vault (leaves local files alone)",
      },
      args: {
        agent: {
          type: "positional",
          required: true,
          description: "Agent owning the skill (claude|cursor|codex|copilot)",
        },
        name: {
          type: "positional",
          required: true,
          description: "Basename of the skill in the vault",
        },
      },
      async run({ args }) {
        const result = await performSkillRemove({
          agent: String(args.agent),
          name: String(args.name),
        });

        switch (result.status) {
          case "success": {
            const shaFragment = result.commitSha ? ` (commit ${result.commitSha})` : "";
            log.success(`Removed ${args.agent}/${args.name} from vault${shaFragment}`);
            return;
          }
          case "unknown-agent": {
            log.error(
              `Unknown agent: ${result.provided}. Supported: ${result.supported.join(", ")}`,
            );
            process.exitCode = 1;
            return;
          }
          case "not-found": {
            log.error(`Skill not found: ${args.agent}/${args.name}`);
            log.info(`Looked for: ${result.path}`);
            process.exitCode = 1;
            return;
          }
          case "reconcile-error": {
            log.error(result.error);
            process.exitCode = 1;
            return;
          }
          case "git-error": {
            log.error(`Removal staged but not pushed: ${result.error}`);
            log.info(
              `Hint: run \`agentsync push\` or re-run \`agentsync skill remove ${args.agent} ${args.name}\` to retry.`,
            );
            process.exitCode = 1;
            return;
          }
        }
      },
    }),
  },
});
