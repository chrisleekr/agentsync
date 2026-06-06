import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { applySingleArtifact, NoMatchingArtifactError } from "../agents/_apply";
import { Agents } from "../agents/registry";
import { machineVaultRoot } from "../config/paths";
import { GitClient } from "../core/git";
import { loadPrivateKey, loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

/** Discriminated result of a `copy` invocation (no throw / no exit). */
export type CopyResult =
  | { status: "applied"; count: number; dryRun: boolean }
  | { status: "unknown-machine"; provided: string; available: string[] }
  | { status: "unknown-agent"; provided: string; supported: string[] }
  | { status: "not-found"; vaultPath: string }
  | { status: "not-copyable"; vaultPath: string; reason: string }
  | { status: "reconcile-error"; error: string }
  | { status: "error"; error: string };

/** List the machine namespace directories under `<vaultDir>/machines/`. */
export async function listMachines(vaultDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(vaultDir, "machines"), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Enumerate every `.age` artifact beneath `<machineRoot>/<relDir>`, returned as
 * machine-root-relative logical paths (e.g. "claude/skills/foo.tar.age").
 */
async function enumerateArtifacts(machineRoot: string, relDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(join(machineRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(childRel);
      else if (e.isFile() && e.name.endsWith(".age")) out.push(childRel);
    }
  }
  await walk(relDir);
  return out.sort();
}

/**
 * Copy one artifact (or a whole subdir) from a machine's vault namespace and
 * apply it to LOCAL disk. The only vault→local path in v2. Reuses each agent's
 * declarative plan via applySingleArtifact, so the JSONC merge, `.bak` backups,
 * and validators are identical to a full apply. Never writes the local
 * machine's vault namespace — the next `push` captures the result normally.
 */
export async function performCopy(options: {
  fromMachine: string;
  vaultPath: string;
  dryRun?: boolean;
}): Promise<CopyResult> {
  const dryRun = options.dryRun ?? false;
  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);

  // Reconcile fast-forward-only so we copy the latest backed-up state.
  const git = new GitClient(runtime.vaultDir);
  try {
    await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      allowMissingRemote: true,
    });
  } catch (err) {
    return { status: "reconcile-error", error: err instanceof Error ? err.message : String(err) };
  }

  // `self` resolves to this machine (the restore primitive); a literal own name
  // is not special-cased.
  const fromMachine = options.fromMachine === "self" ? runtime.machineName : options.fromMachine;
  const machines = await listMachines(runtime.vaultDir);
  if (!machines.includes(fromMachine)) {
    return { status: "unknown-machine", provided: options.fromMachine, available: machines };
  }
  const machineRoot = machineVaultRoot(runtime.vaultDir, fromMachine);

  // The leading path segment names the agent whose plan owns the artifact.
  const vaultPath = options.vaultPath.replace(/\/+$/, "");
  const firstSlash = vaultPath.indexOf("/");
  const agentName = firstSlash === -1 ? vaultPath : vaultPath.slice(0, firstSlash);
  const agent = Agents.find((a) => a.name === agentName);
  if (!agent) {
    return { status: "unknown-agent", provided: agentName, supported: Agents.map((a) => a.name) };
  }

  const key = await loadPrivateKey(runtime.privateKeyPath);
  const plan = agent.buildPlan(config);

  // Directory-prefix copy applies every artifact beneath the path; a single
  // file copies just that one.
  const sourceAbs = join(machineRoot, vaultPath);
  let sourceIsDir = false;
  try {
    sourceIsDir = (await stat(sourceAbs)).isDirectory();
  } catch {
    sourceIsDir = false;
  }

  let targets: string[];
  if (sourceIsDir) {
    targets = await enumerateArtifacts(machineRoot, vaultPath);
    if (targets.length === 0) return { status: "not-found", vaultPath: options.vaultPath };
  } else {
    try {
      await stat(sourceAbs);
    } catch {
      return { status: "not-found", vaultPath: options.vaultPath };
    }
    targets = [vaultPath];
  }

  let count = 0;
  for (const target of targets) {
    try {
      // A directory sweep honours each directive's `enabled` gate (a disabled
      // artifact is skipped); an explicit single-file copy applies what the
      // user named regardless.
      await applySingleArtifact(plan, target, machineRoot, key, dryRun, sourceIsDir);
      count++;
    } catch (err) {
      if (err instanceof NoMatchingArtifactError) {
        // A single explicit miss is an error; in a dir sweep, skip entries no
        // directive owns (e.g. the plugins subtree, handled by `plugin install`).
        if (!sourceIsDir) return { status: "not-copyable", vaultPath: target, reason: err.reason };
        continue;
      }
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
  if (count === 0) {
    return {
      status: "not-copyable",
      vaultPath: options.vaultPath,
      reason: "no copyable artifacts",
    };
  }
  return { status: "applied", count, dryRun };
}

/** Thin citty wrapper: translates the result into log output and exit code. */
export const copyCommand = defineCommand({
  meta: {
    name: "copy",
    description:
      "Copy an artifact (or subdir) from a machine's vault namespace to local disk. Use `copy self <path>` to restore your own.",
  },
  args: {
    machine: {
      type: "positional",
      required: true,
      description: "Source machine namespace, or `self`",
    },
    path: {
      type: "positional",
      required: true,
      description: "Logical vault path, e.g. claude/CLAUDE.md.age or claude/skills/",
    },
    "dry-run": { type: "boolean", description: "Preview each artifact without writing" },
  },
  async run({ args }) {
    const result = await performCopy({
      fromMachine: String(args.machine),
      vaultPath: String(args.path),
      dryRun: Boolean(args["dry-run"]),
    });
    switch (result.status) {
      case "applied":
        log.success(
          `${result.dryRun ? "Would copy" : "Copied"} ${result.count} artifact(s) from ${args.machine}`,
        );
        return;
      case "unknown-machine":
        log.error(
          `Unknown machine: ${result.provided}. Available: ${result.available.join(", ") || "(none)"}`,
        );
        process.exitCode = 1;
        return;
      case "unknown-agent":
        log.error(
          `Unknown agent in path: ${result.provided}. Supported: ${result.supported.join(", ")}`,
        );
        process.exitCode = 1;
        return;
      case "not-found":
        log.error(`Not found in ${args.machine}'s namespace: ${result.vaultPath}`);
        process.exitCode = 1;
        return;
      case "not-copyable":
        log.error(`Not copyable: ${result.vaultPath} — ${result.reason}`);
        process.exitCode = 1;
        return;
      case "reconcile-error":
        log.error(result.error);
        process.exitCode = 1;
        return;
      case "error":
        log.error(result.error);
        process.exitCode = 1;
        return;
    }
  },
});
