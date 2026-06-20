import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { machineVaultRoot } from "../config/paths";
import { GitClient } from "../core/git";
import { enumerateArtifacts, listMachines } from "./copy";
import { loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

/** Discriminated result of a `performLs` invocation. */
export type LsResult =
  | { kind: "machines"; machines: string[] }
  | { kind: "artifacts"; machine: string; paths: string[] }
  | { kind: "empty"; machine: string; path: string }
  | { kind: "unknown-machine"; provided: string; available: string[] }
  | { kind: "reconcile-error"; error: string };

/**
 * Browse the vault's machine namespaces and the copyable artifact paths within
 * one. Read-only and key-free — it lists which encrypted `.age` files exist
 * (never decrypts), so a fresh machine can discover what `copy` accepts without
 * holding any recipient's key. Reconciles fast-forward first so the listing
 * reflects the latest backed-up state.
 */
export async function performLs(options: { machine?: string; path?: string }): Promise<LsResult> {
  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);

  const git = new GitClient(runtime.vaultDir);
  try {
    await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      allowMissingRemote: true,
    });
  } catch (err) {
    return { kind: "reconcile-error", error: err instanceof Error ? err.message : String(err) };
  }

  const machines = await listMachines(runtime.vaultDir);
  if (!options.machine) {
    return { kind: "machines", machines };
  }

  // `self` resolves to this machine, mirroring `copy`.
  const machine = options.machine === "self" ? runtime.machineName : options.machine;
  if (!machines.includes(machine)) {
    return { kind: "unknown-machine", provided: options.machine, available: machines };
  }

  const machineRoot = machineVaultRoot(runtime.vaultDir, machine);
  const relDir = (options.path ?? "").replace(/^\/+|\/+$/g, "");
  const paths = await enumerateArtifacts(machineRoot, relDir);
  if (paths.length === 0) {
    return { kind: "empty", machine, path: relDir };
  }
  return { kind: "artifacts", machine, paths };
}

/** List the vault's machine namespaces, or the copyable artifacts within one. */
export const lsCommand = defineCommand({
  meta: {
    name: "ls",
    description: "List machine namespaces in the vault, or the copyable artifacts in one",
  },
  args: {
    machine: {
      type: "positional",
      required: false,
      description: "Machine namespace to browse, or `self` (omit to list machines)",
    },
    path: {
      type: "positional",
      required: false,
      description: "Optional path prefix to narrow the listing (e.g. claude/)",
    },
  },
  async run({ args }) {
    const result = await performLs({
      machine: args.machine ? String(args.machine) : undefined,
      path: args.path ? String(args.path) : undefined,
    });

    switch (result.kind) {
      case "machines":
        if (result.machines.length === 0) {
          log.warn("No machines in the vault yet. Run `agentsync push` first.");
          return;
        }
        log.info("Machines in the vault:");
        for (const m of result.machines) log.info(`  ${m}`);
        log.info(
          "Browse one with `agentsync ls <machine>`; copy from it with `agentsync copy <machine> <path>`.",
        );
        return;
      case "artifacts":
        log.info(`Copyable artifacts in ${result.machine}'s namespace:`);
        for (const p of result.paths) log.info(`  ${p}`);
        log.info(`Copy one with \`agentsync copy ${result.machine} <path>\`.`);
        return;
      case "empty":
        log.warn(
          `No artifacts under ${result.machine}/${result.path || ""}. Run \`agentsync ls ${result.machine}\` to see what exists.`,
        );
        return;
      case "unknown-machine":
        log.error(
          `Unknown machine: ${result.provided}. Available: ${result.available.join(", ") || "(none)"}`,
        );
        process.exitCode = 1;
        return;
      case "reconcile-error":
        log.error(result.error);
        process.exitCode = 1;
        return;
    }
  },
});
