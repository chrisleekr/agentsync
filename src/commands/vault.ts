import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { parse } from "@iarna/toml";
import { defineCommand } from "citty";
import { Agents } from "../agents/registry";
import { peekVaultVersion, resolveConfigPath, writeConfig } from "../config/loader";
import { machineVaultRoot } from "../config/paths";
import { AgentSyncConfigSchema, CURRENT_VAULT_VERSION } from "../config/schema";
import { GitClient } from "../core/git";
import { resolveRuntimeContext } from "./shared";

/** Discriminated result of a `vault upgrade` invocation (no throw / no exit). */
export type VaultUpgradeResult =
  | { status: "upgraded"; movedAgents: string[]; commitSha: string | null }
  | { status: "already-v2" }
  | { status: "not-initialized"; vaultDir: string }
  | { status: "unsupported"; version: number }
  | { status: "reconcile-error"; error: string }
  | { status: "git-error"; error: string };

/** Read and TOML-parse the raw vault config (pre-schema) for migration. */
async function readRawConfig(configPath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(configPath, "utf8");
  // structuredClone strips the Symbol metadata @iarna/toml attaches to tables,
  // which otherwise trips Zod's record key walk (mirrors loader.ts:loadConfig).
  return structuredClone(parse(raw)) as Record<string, unknown>;
}

/** True when `<vaultDir>/<name>` exists and is a directory. */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Short HEAD sha for the success line; null if git cannot be invoked (non-fatal). */
function readHeadShortSha(repoDir: string): string | null {
  const result = Bun.spawnSync(["git", "-C", repoDir, "rev-parse", "--short=7", "HEAD"]);
  if (result.exitCode !== 0) return null;
  const out = new TextDecoder().decode(result.stdout).trim();
  return out.length > 0 ? out : null;
}

/**
 * Migrate a flat v1 vault to the per-machine v2 layout: relocate every top-level
 * agent directory under `machines/<thisMachine>/`, drop the down-sync schema
 * fields, bump `version` to the integer 2, then commit and fast-forward push.
 *
 * Baked-in assumption: the existing flat content belongs to the machine running
 * the upgrade (it is this machine's backup). Idempotent — a vault already at v2
 * is a no-op. The relocation is a normal commit; history is preserved via
 * `git mv` and the remote is never force-pushed.
 */
export async function performVaultUpgrade(): Promise<VaultUpgradeResult> {
  const runtime = await resolveRuntimeContext();
  const configPath = resolveConfigPath(runtime.vaultDir);

  const initialProbe = await peekVaultVersion(configPath);
  if (initialProbe.kind === "absent") {
    return { status: "not-initialized", vaultDir: runtime.vaultDir };
  }
  if (initialProbe.kind === "unsupported") {
    return { status: "unsupported", version: initialProbe.version };
  }

  // The branch is read from the raw (pre-schema) config of a possibly shared
  // vault, so it is not yet type-narrowed and is passed to git. Reject a
  // non-string, and a leading dash (simple-git uses argv, but a dash could still
  // be read as a flag), before it reaches fetch/push.
  const rawBranch = (await readRawConfig(configPath)).remote as { branch?: unknown } | undefined;
  const branch = rawBranch?.branch ?? "main";
  if (typeof branch !== "string") {
    return {
      status: "git-error",
      error: "Invalid remote.branch in agentsync.toml: expected a string.",
    };
  }
  if (branch.startsWith("-")) {
    return { status: "git-error", error: `Refusing unsafe branch name: ${JSON.stringify(branch)}` };
  }

  const git = new GitClient(runtime.vaultDir);
  try {
    // Reconcile first: another machine may have already upgraded and pushed v2,
    // in which case the fast-forward brings it down and the re-probe below sees v2.
    await git.reconcileWithRemote({ remote: "origin", branch, allowMissingRemote: true });
  } catch (err) {
    return { status: "reconcile-error", error: err instanceof Error ? err.message : String(err) };
  }

  const probe = await peekVaultVersion(configPath);
  if (probe.kind === "v2") return { status: "already-v2" };
  if (probe.kind === "unsupported") return { status: "unsupported", version: probe.version };

  try {
    const machineRoot = machineVaultRoot(runtime.vaultDir, runtime.machineName);
    await mkdir(machineRoot, { recursive: true });

    // Relocate each top-level agent dir into this machine's namespace. The
    // config and .gitignore stay at the vault root (vault-global).
    const movedAgents: string[] = [];
    for (const agent of Agents) {
      if (await isDir(join(runtime.vaultDir, agent.name))) {
        await git.move(agent.name, join("machines", runtime.machineName, agent.name));
        movedAgents.push(agent.name);
      }
    }

    // Rewrite the config to v2: integer version, no down-sync fields. Validate
    // through the v2 schema so a malformed legacy file fails loudly here.
    const raw = await readRawConfig(configPath);
    const sync = (raw.sync ?? {}) as Record<string, unknown>;
    delete sync.autoPull;
    delete sync.pullIntervalMs;
    const v2Config = AgentSyncConfigSchema.parse({ ...raw, version: CURRENT_VAULT_VERSION, sync });
    await writeConfig(configPath, v2Config);

    const committed = await git.commit({
      message: `vault upgrade: migrate to per-machine layout v2 (${runtime.machineName})`,
    });
    if (committed) {
      await git.push("origin", branch);
    }
    return {
      status: "upgraded",
      movedAgents,
      commitSha: committed ? readHeadShortSha(runtime.vaultDir) : null,
    };
  } catch (err) {
    return { status: "git-error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Thin citty wrapper: translates the result into log output and exit code. */
export const vaultCommand = defineCommand({
  meta: {
    name: "vault",
    description: "Manage the vault format",
  },
  subCommands: {
    upgrade: defineCommand({
      meta: {
        name: "upgrade",
        description:
          "Migrate a flat (v1) vault to the per-machine layout. Assumes the existing flat content belongs to this machine.",
      },
      async run() {
        const result = await performVaultUpgrade();
        switch (result.status) {
          case "upgraded": {
            const moved =
              result.movedAgents.length > 0
                ? result.movedAgents.join(", ")
                : "no agent directories";
            const shaFragment = result.commitSha ? ` (commit ${result.commitSha})` : "";
            log.success(`Upgraded vault to v2 — relocated ${moved} under machines/${shaFragment}`);
            return;
          }
          case "already-v2":
            log.info("Vault is already at format v2. Nothing to do.");
            return;
          case "not-initialized":
            log.error(
              `Vault not initialized at ${result.vaultDir}. Run \`agentsync init --remote <git-url>\` first.`,
            );
            process.exitCode = 1;
            return;
          case "unsupported":
            log.error(
              `Vault uses format v${result.version}, newer than this agentsync. Run \`agentsync upgrade\` to update agentsync first.`,
            );
            process.exitCode = 1;
            return;
          case "reconcile-error":
            log.error(result.error);
            process.exitCode = 1;
            return;
          case "git-error":
            log.error(`Upgrade staged but not completed: ${result.error}`);
            process.exitCode = 1;
            return;
        }
      },
    }),
  },
});
