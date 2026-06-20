import { stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { machineVaultRoot } from "../config/paths";
import { GitClient } from "../core/git";
import {
  InvalidMachineNameError,
  loadVaultConfigOrExit,
  resolveRuntimeContext,
  validateMachineName,
} from "./shared";

/** Discriminated result of a {@link performVaultRemove} invocation. */
export type VaultRemoveResult =
  | { status: "success"; path: string; commitSha: string | null }
  | { status: "invalid-machine"; provided: string; reason: string }
  | { status: "invalid-path"; provided: string; reason: string }
  | { status: "not-found"; path: string }
  | { status: "reconcile-error"; error: string }
  | { status: "git-error"; path: string; error: string };

/**
 * Reject any vault-relative path that could escape the machine namespace.
 * `vaultRelPath` is joined onto the machine root and then `git rm`-ed and
 * pushed, so a `..` segment or absolute path would let a caller delete an
 * arbitrary vault file. Returns a human-readable reason string when invalid,
 * or null when the path is a safe machine-relative path. This mirrors the
 * path-traversal posture of `validateMachineName` for the `--machine` segment.
 */
function validateVaultRelPath(p: string): string | null {
  if (p.length === 0) return "empty";
  if (isAbsolute(p)) return "must be relative to the machine root";
  const segments = p.replaceAll("\\", "/").split("/");
  if (segments.some((s) => s === "..")) return "contains a parent-directory segment";
  return null;
}

/**
 * Remove a single artifact from the vault, commit the deletion, and push.
 * Touches only the vault working tree — never any agent's local files.
 *
 * This is the generalised core that {@link performSkillRemove} delegates to.
 * The git sequence (fast-forward reconcile → re-stat → unlink → commit →
 * push) is the one removal invariant shared by every vault deletion, so it
 * lives here once rather than being duplicated per artifact kind.
 *
 * Returns a discriminated result instead of throwing so callers (CLI wrapper,
 * TUI bulk-remove) can branch deterministically.
 *
 * @param options.vaultRelPath Path of the artifact relative to the machine
 *        vault root, e.g. `claude/commands/foo.md.age`.
 * @param options.machine Namespace to remove from; defaults to this machine.
 * @param options.commitMessage Commit subject; defaults to `vault remove: <path>`.
 */
export async function performVaultRemove(options: {
  vaultRelPath: string;
  machine?: string;
  commitMessage?: string;
}): Promise<VaultRemoveResult> {
  // A user-supplied --machine becomes a vault directory segment, so it must
  // pass the same path-traversal gate as the resolved machine name.
  if (options.machine !== undefined) {
    try {
      validateMachineName(options.machine);
    } catch (err) {
      if (err instanceof InvalidMachineNameError) {
        return { status: "invalid-machine", provided: err.provided, reason: err.reason };
      }
      throw err;
    }
  }

  const pathReason = validateVaultRelPath(options.vaultRelPath);
  if (pathReason) {
    return { status: "invalid-path", provided: options.vaultRelPath, reason: pathReason };
  }

  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);
  const targetMachine = options.machine ?? runtime.machineName;
  const machineRoot = machineVaultRoot(runtime.vaultDir, targetMachine);
  const targetPath = join(machineRoot, options.vaultRelPath);

  // Defence in depth: even after the segment check above, assert the joined
  // path still resolves inside the machine root before we delete anything.
  const rel = relative(machineRoot, targetPath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      status: "invalid-path",
      provided: options.vaultRelPath,
      reason: "escapes the machine root",
    };
  }

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
  // as part of an earlier removal from another machine. If it is gone now, the
  // removal already happened upstream; report success without a new commit.
  try {
    await stat(targetPath);
  } catch {
    return { status: "success", path: targetPath, commitSha: null };
  }

  try {
    await unlink(targetPath);
    const committed = await git.commit({
      message: options.commitMessage ?? `vault remove: ${options.vaultRelPath}`,
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
