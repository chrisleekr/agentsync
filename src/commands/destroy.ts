import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, resolveConfigPath } from "../config/loader";
import type { AgentSyncConfig } from "../config/schema";
import { GitClient, GitReconciliationError } from "../core/git";
import { isFileNotFoundError, resolveRuntimeContext } from "./shared";

// Warning-text constants live at module top so docs/tests reference the same
// strings the command prints. A divergence between any of them is a test or
// docs bug — never a runtime drift.

const LOCAL_PREVIEW_TEMPLATE = (vaultDir: string, remote: string) =>
  `
⚠  agentsync destroy — local vault teardown

This will permanently REMOVE:
  ${vaultDir}    encrypted artefacts, agentsync.toml,
                                            .gitignore, the local git clone

This will NOT touch:
  ~/.claude/, ~/.cursor/, ~/.codex/         YOUR LOCAL AGENT FILES are completely
  ~/.copilot/, VS Code user dir             off-limits to this command — every
                                            file in these directories stays exactly
                                            as it is on disk.
  <agentsync home>/key.txt                  Your age private key.
  ${remote}    The remote repository.

After destroy you can re-init from the same remote with:
  agentsync init --remote <url> --branch <branch>
`.trimEnd();

const REMOTE_PREVIEW_TEMPLATE = (
  remote: string,
  branch: string,
  vaultDir: string,
  recipientCount: number,
) =>
  `
⚠  agentsync destroy — remote vault teardown (via commit, not force-push)

This will:
  - Pull and reconcile against the remote first
  - git rm -rf every tracked file in the vault working tree
  - Commit  "destroy: clear vault content"
  - Push to: ${remote} (branch: ${branch})

This will NOT touch:
  ~/.claude/, ~/.cursor/, ~/.codex/         YOUR LOCAL AGENT FILES are completely
  ~/.copilot/, VS Code user dir             off-limits to this command — every
                                            file in these directories stays exactly
                                            as it is on disk.
  ${vaultDir}    The LOCAL vault clone — pass
                                            --scope=all if you also want it gone.
  <agentsync home>/key.txt                  Your age private key.
  ${remote}    The repository itself (only its
                                            tracked content, via a normal commit).
                                            .git history is preserved.

Effects on other machines:
  - Each machine's local config is its own source of truth and is untouched,
    but the shared vault backup is gone — a future \`agentsync copy\` finds
    nothing, and a new machine cannot \`init\` against the empty vault.
  - History is preserved. Any machine with a vault clone can
    \`git revert <destroy-commit>\` to recover the data.
  - This vault has ${recipientCount} registered recipient(s); ALL of them are affected.
`.trimEnd();

const DESTROY_COMMIT_MESSAGE = "destroy: clear vault content";

export type DestroyScope = "local" | "remote" | "all";

export type DestroyResult =
  | { status: "removed-local"; path: string }
  | { status: "removed-remote"; commitSha: string | null; branch: string; remote: string }
  | {
      status: "removed-all";
      localPath: string;
      commitSha: string | null;
      branch: string;
      remote: string;
    }
  | { status: "not-found"; path: string }
  | { status: "not-an-agentsync-vault"; path: string }
  | { status: "remote-diverged"; error: string }
  | { status: "remote-push-failed"; error: string; commitSha: string | null }
  | { status: "aborted-by-user"; gate: 1 | 2 | 3 }
  | { status: "non-tty-without-yes" }
  | { status: "failed"; error: string };

export interface DestroyOptions {
  scope: DestroyScope;
  /** Bypass the agentsync.toml presence check. */
  force?: boolean;
  /** Skip all three confirmation gates. Intended for tests / scripted use. */
  yes?: boolean;
  /**
   * Async prompt callback. Defaults to a readline interface on
   * `process.stdin`. Tests can inject a function that returns scripted
   * answers without dealing with stream plumbing.
   */
  ask?: (prompt: string) => Promise<string>;
  /** Optional stdout override for testing. Default writes to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /**
   * Override the non-TTY guard for testing. When undefined, the guard reads
   * `process.stdin.isTTY` (the production default).
   */
  isInteractive?: boolean;
}

/**
 * Wipe vault state at the configured scope. Returns a discriminated result —
 * does not throw and never calls `process.exit` so non-CLI callers (tests,
 * future TUI gating) can react to outcomes without parsing log output.
 */
export async function performDestroy(options: DestroyOptions): Promise<DestroyResult> {
  const runtime = await resolveRuntimeContext();
  const stdout = options.stdout ?? process.stdout;
  const interactive = options.isInteractive ?? Boolean(process.stdin.isTTY);

  // Stat the vault dir before doing anything else. ENOENT short-circuits to
  // "not-found" so destroy is a no-op when the user has never run init.
  let vaultExists = false;
  try {
    const info = await lstat(runtime.vaultDir);
    vaultExists = info.isDirectory();
  } catch (err) {
    if (!isFileNotFoundError(err)) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (!vaultExists) {
    return { status: "not-found", path: runtime.vaultDir };
  }

  // Safety check: refuse to destroy a directory that does not look like an
  // agentsync vault. AGENTSYNC_VAULT_DIR pointing at a stray path would
  // otherwise let this command wipe unrelated data.
  let config: AgentSyncConfig | null = null;
  try {
    config = await loadConfig(resolveConfigPath(runtime.vaultDir));
  } catch {
    config = null;
  }

  if (!config && !options.force) {
    return { status: "not-an-agentsync-vault", path: runtime.vaultDir };
  }

  if (!options.yes && !interactive) {
    return { status: "non-tty-without-yes" };
  }

  // Remote-scope checks: refuse early on divergence so the user is not left
  // in a half-destroyed state.
  if (options.scope === "remote" || options.scope === "all") {
    if (!config) {
      return {
        status: "failed",
        error: "Cannot run --scope=remote without a vault config (agentsync.toml).",
      };
    }
    const probe = new GitClient(runtime.vaultDir);
    try {
      await probe.reconcileWithRemote({
        remote: "origin",
        branch: config.remote.branch,
        allowMissingRemote: true,
      });
    } catch (err) {
      if (err instanceof GitReconciliationError) {
        return { status: "remote-diverged", error: err.message };
      }
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Confirmation gates. `--yes` skips all three.
  if (!options.yes) {
    const { ask, cleanup } = options.ask
      ? { ask: options.ask, cleanup: () => undefined }
      : buildReadlineAsk();
    try {
      const gate1 = await runGate1(options.scope, runtime.vaultDir, config, ask, stdout);
      if (!gate1) return { status: "aborted-by-user", gate: 1 };

      const phrase = expectedPhrase(options.scope, config);
      const gate2 = await runGate2(phrase, ask, stdout);
      if (!gate2) return { status: "aborted-by-user", gate: 2 };

      const gate3 = await runGate3(options.scope, ask, stdout);
      if (!gate3) return { status: "aborted-by-user", gate: 3 };
    } finally {
      cleanup();
    }
  }

  // Execute. Remote first when --scope=all so a push failure does not leave
  // us with a wiped local that can no longer reach the remote.
  let remoteOutcome: { commitSha: string | null; pushed: boolean } | null = null;
  if (options.scope === "remote" || options.scope === "all") {
    if (!config) {
      return { status: "failed", error: "Cannot run --scope=remote without a vault config." };
    }
    const out = await wipeRemoteContent(runtime.vaultDir, config);
    if (out.status !== "ok") return out.result;
    remoteOutcome = { commitSha: out.commitSha, pushed: true };
  }

  if (options.scope === "local" || options.scope === "all") {
    try {
      await rm(runtime.vaultDir, { recursive: true, force: true });
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (options.scope === "local") {
    return { status: "removed-local", path: runtime.vaultDir };
  }
  // config is guaranteed non-null on the remote / all paths because the
  // early-return at the top of the remote block fails fast when it is
  // missing. Narrow the type once here so the return objects do not need
  // non-null assertions on every field access.
  if (!config) {
    return { status: "failed", error: "Internal: config missing on remote scope path" };
  }
  if (options.scope === "remote") {
    return {
      status: "removed-remote",
      commitSha: remoteOutcome?.commitSha ?? null,
      branch: config.remote.branch,
      remote: config.remote.url,
    };
  }
  return {
    status: "removed-all",
    localPath: runtime.vaultDir,
    commitSha: remoteOutcome?.commitSha ?? null,
    branch: config.remote.branch,
    remote: config.remote.url,
  };
}

function expectedPhrase(scope: DestroyScope, config: AgentSyncConfig | null): string {
  if (scope === "local" || !config) return "DESTROY";
  const branch = config.remote.branch;
  const fragment = parseRemoteFragment(config.remote.url);
  return `DESTROY ${branch}@${fragment}`;
}

/**
 * Extract the last two path components of a Git remote URL so the typed-phrase
 * gate forces the user to read the remote off the preview before they can
 * type it. Falls back to the raw URL if the parse fails — better a long
 * phrase than no friction.
 */
function parseRemoteFragment(url: string): string {
  const cleaned = url.replace(/\.git$/, "");
  const segments = cleaned.split(/[/:]/).filter((s) => s.length > 0);
  if (segments.length >= 2) return segments.slice(-2).join("/");
  return cleaned;
}

type AskFn = (prompt: string) => Promise<string>;

async function runGate1(
  scope: DestroyScope,
  vaultDir: string,
  config: AgentSyncConfig | null,
  ask: AskFn,
  stdout: NodeJS.WritableStream,
): Promise<boolean> {
  const remote = config?.remote.url ?? "<remote not configured>";
  const branch = config?.remote.branch ?? "<branch not configured>";
  const recipientCount = config ? Object.keys(config.recipients).length : 0;

  if (scope === "local" || scope === "all") {
    stdout.write(`${LOCAL_PREVIEW_TEMPLATE(vaultDir, remote)}\n`);
  }
  if (scope === "remote" || scope === "all") {
    stdout.write(`${REMOTE_PREVIEW_TEMPLATE(remote, branch, vaultDir, recipientCount)}\n`);
  }

  const answer = (await ask("\nContinue? (y/N) ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function runGate2(
  expected: string,
  ask: AskFn,
  _stdout: NodeJS.WritableStream,
): Promise<boolean> {
  const line = await ask(`\nType ${expected} (exact, case-sensitive) to confirm: `);
  return line === expected;
}

async function runGate3(
  scope: DestroyScope,
  ask: AskFn,
  stdout: NodeJS.WritableStream,
): Promise<boolean> {
  const action =
    scope === "local"
      ? "the vault directory will be removed"
      : scope === "remote"
        ? "the remote will be wiped via a commit + push"
        : "the remote will be wiped AND the local vault directory will be removed";
  stdout.write(`\nLast chance. After this prompt, ${action}.`);
  const answer = (await ask("\nConfirm? (y/N) ")).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function buildReadlineAsk(): {
  ask: (prompt: string) => Promise<string>;
  cleanup: () => void;
} {
  const rl = createInterface({ input: process.stdin, terminal: false });
  return {
    ask: (prompt: string) =>
      new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer));
      }),
    cleanup: () => rl.close(),
  };
}

type WipeRemoteResult =
  | { status: "ok"; commitSha: string | null }
  | { status: "err"; result: DestroyResult };

async function wipeRemoteContent(
  vaultDir: string,
  config: AgentSyncConfig,
): Promise<WipeRemoteResult> {
  const git = new GitClient(vaultDir);

  // Walk the working tree and unlink every regular file except inside .git/.
  // `git add -A` (via GitClient.addAll → commit) then stages all the
  // deletions for the commit. If nothing changed we short-circuit to a
  // noop "already empty" success result.
  try {
    await unlinkAllTrackedContent(vaultDir);
  } catch (err) {
    return {
      status: "err",
      result: { status: "failed", error: err instanceof Error ? err.message : String(err) },
    };
  }

  let committed = false;
  try {
    committed = await git.commit({ message: DESTROY_COMMIT_MESSAGE });
  } catch (err) {
    return {
      status: "err",
      result: { status: "failed", error: err instanceof Error ? err.message : String(err) },
    };
  }

  if (!committed) {
    return { status: "ok", commitSha: null };
  }

  let sha: string | null = null;
  try {
    sha = await readHeadShortSha(vaultDir);
  } catch {
    sha = null;
  }

  try {
    await git.push("origin", config.remote.branch, []);
  } catch (err) {
    return {
      status: "err",
      result: {
        status: "remote-push-failed",
        error: err instanceof Error ? err.message : String(err),
        commitSha: sha,
      },
    };
  }

  return { status: "ok", commitSha: sha };
}

/**
 * Walk the working tree and unlink every regular file under `vaultDir`
 * except inside `.git/`. This intentionally removes BOTH tracked and
 * untracked files: a vault clone is meant to contain only AgentSync-managed
 * encrypted artifacts, and a `destroy` invocation should leave nothing
 * unencrypted behind. `git add -A` afterwards captures the deletions in a
 * single commit so recovery via `git revert` reproduces the prior tracked
 * state — untracked detritus is not recoverable by git in either direction.
 */
async function unlinkAllTrackedContent(vaultDir: string): Promise<void> {
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git") continue;
      const full = join(dir, name);
      // lstat (not stat) so a symlink in the vault tree is identified as a
      // symlink and unlinked in place — never followed. Following a symlink
      // would let a malicious vault entry escape the subtree and delete
      // files anywhere on disk, breaking the agent-files-never-touched
      // invariant that the entire destroy command exists to uphold.
      const info = await lstat(full).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) {
        await rm(full, { force: true });
        continue;
      }
      if (info.isDirectory()) {
        await walk(full);
        // Best-effort remove the now-empty directory so `git status` sees a
        // clean tree. `git rm -rf` does this implicitly; we do it explicitly.
        await rm(full, { recursive: true, force: true }).catch(() => undefined);
      } else if (info.isFile()) {
        await rm(full, { force: true });
      }
    }
  }
  await walk(vaultDir);
}

async function readHeadShortSha(repoDir: string): Promise<string | null> {
  const result = Bun.spawnSync(["git", "-C", repoDir, "rev-parse", "--short=7", "HEAD"]);
  if (result.exitCode !== 0) return null;
  const out = new TextDecoder().decode(result.stdout).trim();
  return out.length > 0 ? out : null;
}

/** Thin citty wrapper around `performDestroy`. Translates results into log
 * output and sets `process.exitCode` on non-success branches. */
export const destroyCommand = defineCommand({
  meta: {
    name: "destroy",
    description: "Wipe local vault clone and/or remote vault contents",
  },
  args: {
    scope: {
      type: "string",
      description: "What to destroy: local (default), remote, or all",
      default: "local",
    },
    force: {
      type: "boolean",
      description: "Bypass the agentsync.toml safety check (still prompts unless --yes)",
      default: false,
    },
    yes: {
      type: "boolean",
      description: "Skip all three confirmation gates. Intended for scripted use.",
      default: false,
    },
  },
  async run({ args }) {
    const scope = String(args.scope) as DestroyScope;
    if (scope !== "local" && scope !== "remote" && scope !== "all") {
      log.error(`Invalid --scope: ${args.scope}. Expected one of: local, remote, all.`);
      process.exitCode = 1;
      return;
    }

    const result = await performDestroy({
      scope,
      force: Boolean(args.force),
      yes: Boolean(args.yes),
    });

    switch (result.status) {
      case "removed-local":
        log.success(`Local vault removed: ${result.path}`);
        log.info("Your key.txt and local agent files are untouched.");
        return;
      case "removed-remote":
        if (result.commitSha) {
          log.success(
            `Remote vault wiped via commit ${result.commitSha} on ${result.branch} at ${result.remote}.`,
          );
        } else {
          log.success(`Remote vault already empty (no tracked content to remove).`);
        }
        log.info(
          "Other recipients can `git revert` this commit if they still have a copy of the data.",
        );
        return;
      case "removed-all":
        log.success(
          `Remote wiped (commit ${result.commitSha ?? "none"} on ${result.branch}) and local vault removed at ${result.localPath}.`,
        );
        return;
      case "not-found":
        log.info(`No vault to destroy at ${result.path}. Nothing to do.`);
        return;
      case "not-an-agentsync-vault":
        log.error(
          `Refusing to destroy ${result.path}: no agentsync.toml found.\nThis does not look like an agentsync vault. If it is, pass --force.`,
        );
        process.exitCode = 1;
        return;
      case "remote-diverged":
        log.error(`Remote diverged — refusing to destroy:\n${result.error}`);
        log.info("See docs/operations.md#recover-from-divergence for the recovery path.");
        process.exitCode = 1;
        return;
      case "remote-push-failed":
        log.error(
          `Destroy commit ${result.commitSha ?? "(none)"} created locally but push failed: ${result.error}`,
        );
        process.exitCode = 1;
        return;
      case "aborted-by-user":
        log.info(`Aborted at gate ${result.gate}. No state changed.`);
        return;
      case "non-tty-without-yes":
        log.error(
          "Refusing to destroy in a non-interactive shell without --yes. Run in a terminal or pass --yes to confirm.",
        );
        process.exitCode = 1;
        return;
      case "failed":
        log.error(result.error);
        process.exitCode = 1;
        return;
    }
  },
});

export const __TEST_ONLY = {
  parseRemoteFragment,
  expectedPhrase,
  LOCAL_PREVIEW_TEMPLATE,
  REMOTE_PREVIEW_TEMPLATE,
  DESTROY_COMMIT_MESSAGE,
};
