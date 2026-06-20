import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { performVaultRemove } from "./vault-remove";

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
  | { status: "invalid-machine"; provided: string; reason: string }
  | { status: "not-found"; path: string }
  | { status: "reconcile-error"; error: string }
  | { status: "git-error"; path: string; error: string };

/**
 * Remove a single skill from the vault, commit the deletion, and push. Leaves
 * every local skill directory on every machine untouched.
 *
 * This function is the testable core — it returns a discriminated result
 * object instead of throwing or calling `process.exit()` so tests can assert
 * each branch deterministically. The thin citty wrapper at the bottom of this
 * file translates the result into `@clack/prompts` log calls and
 * `process.exitCode`.
 *
 * @param options.agent Name of the skill-bearing agent.
 * @param options.name  Basename of the skill in the vault (no `.tar.age` suffix).
 * @param options.machine Namespace to remove from; defaults to this machine.
 * @returns A {@link SkillRemoveResult} describing the outcome.
 */
export async function performSkillRemove(options: {
  agent: string;
  name: string;
  machine?: string;
}): Promise<SkillRemoveResult> {
  if (!isSkillBearingAgent(options.agent)) {
    return {
      status: "unknown-agent",
      provided: options.agent,
      supported: SKILL_BEARING_AGENTS,
    };
  }

  // A skill is just a vault artifact at `<agent>/skills/<name>.tar.age`.
  // Delegate the git removal dance (reconcile, re-stat, unlink, commit, push)
  // and the --machine path-traversal gate to the shared core; this wrapper
  // only adds the skill-specific agent check and vault-path construction.
  const result = await performVaultRemove({
    vaultRelPath: join(options.agent, "skills", `${options.name}.tar.age`),
    machine: options.machine,
    commitMessage: `skill remove(${options.agent}): ${options.name}`,
  });

  // A constructed skill path can never be a traversal, but map the variant
  // defensively so the SkillRemoveResult union stays exhaustive for callers.
  if (result.status === "invalid-path") {
    return { status: "git-error", path: options.name, error: result.reason };
  }
  return result;
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
        machine: {
          type: "string",
          description: "Machine namespace to remove from (defaults to this machine)",
        },
      },
      async run({ args }) {
        const result = await performSkillRemove({
          agent: String(args.agent),
          name: String(args.name),
          // Preserve an explicit --machine "" so it reaches validation (rejected)
          // rather than being coerced to "use this machine".
          machine: args.machine !== undefined ? String(args.machine) : undefined,
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
          case "invalid-machine": {
            log.error(`Invalid --machine ${JSON.stringify(result.provided)}: ${result.reason}.`);
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
