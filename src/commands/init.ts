import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, resolveConfigPath, writeConfig } from "../config/loader";
import { resolveAgentSyncHome } from "../config/paths";
import { generateIdentity, identityToRecipient } from "../core/encryptor";
import { GitClient } from "../core/git";
import { isFileNotFoundError, loadPrivateKey, resolveRuntimeContext } from "./shared";

const DEFAULT_AGENTS = {
  cursor: true,
  claude: true,
  codex: true,
  copilot: true,
  vscode: false,
};

const DEFAULT_SYNC = {
  debounceMs: 300,
  autoPush: true,
  autoPull: true,
  pullIntervalMs: 300_000,
};

/**
 * Load or create the local age keypair so init can register this machine as a
 * recipient. Returns `isNew` so the caller can (a) defer the "generated" /
 * "loaded" log line until after init has actually committed to keeping the key
 * and (b) roll back a freshly written `key.txt` without touching a pre-existing
 * one if a later step fails.
 *
 * Contract on failure: if this function throws, the on-disk state of `path` is
 * either unchanged (pre-existing key preserved, or no key ever written) or
 * has been best-effort cleaned up. The caller's `isNew` rollback only fires
 * after a successful return, so any failure mid-generate-and-write must be
 * handled locally or the orphan key.txt is invisible to the outer recovery.
 */
async function ensureKeypair(
  path: string,
): Promise<{ identity: string; recipient: string; isNew: boolean }> {
  try {
    const identity = await loadPrivateKey(path);
    const recipient = await identityToRecipient(identity);
    return { identity, recipient, isNew: false };
  } catch (err) {
    // Only auto-generate when key.txt is genuinely absent. Other read errors
    // (EACCES on a locked-down key, a malformed file from a previous corrupt
    // write, an unreadable mount) must surface as failures — silently
    // overwriting them would destroy a key the user may still be able to
    // recover and rebind every recipient to fresh material the user did not
    // consent to.
    if (!isFileNotFoundError(err)) throw err;
  }

  const identity = await generateIdentity();
  try {
    await writeFile(path, `${identity}\n`, { mode: 0o600 });
    const recipient = await identityToRecipient(identity);
    return { identity, recipient, isNew: true };
  } catch (err) {
    // writeFile may have written partial data before rejecting (per Node docs,
    // the call performs multiple internal writes and is best-effort on abort),
    // and identityToRecipient can throw on a freshly written key. Either way,
    // the file we just created — full, partial, or empty — must not survive
    // as an "existing key" that the next init silently loads. `force: true`
    // swallows ENOENT for the case where writeFile failed before opening the
    // file. A real rm failure (EBUSY/EACCES/EROFS) is surfaced as a warn:
    // the original write/recipient error is still the root cause, but the
    // user needs to know an orphan key.txt may remain on disk so a naive
    // retry does not silently inherit it.
    try {
      await rm(path, { force: true });
    } catch (rmErr) {
      const rmMessage = rmErr instanceof Error ? rmErr.message : String(rmErr);
      log.warn(
        `Failed to remove newly generated key at ${path}: ${rmMessage}.\nRemove it manually before retrying.`,
      );
    }
    throw err;
  }
}

/** Bootstrap a vault, local key material, and the initial git remote wiring. */
export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Initialize agentsync vault and machine key",
  },
  args: {
    remote: {
      type: "string",
      description: "Git remote URL for the vault",
      required: true,
    },
    branch: {
      type: "string",
      description: "Git branch",
      default: "main",
    },
  },
  async run({ args }) {
    log.info("Initializing AgentSync");

    const runtime = await resolveRuntimeContext();

    // Probe the remote BEFORE writing any local artifacts (key.txt or even
    // the vault directory itself). An unreachable or auth-blocked remote
    // must abort with no on-disk state inside `runtime.vaultDir` so a retry
    // against a different URL does not silently inherit an orphan key or
    // an empty vault dir that was created for a never-completed init.
    //
    // The probe needs a cwd to run `git -C <cwd> ls-remote` against, but
    // does not need a git repo. `resolveRuntimeContext` has already created
    // the agentsync home (the parent of the default vault dir), which is
    // always a valid cwd regardless of whether `AGENTSYNC_VAULT_DIR`
    // overrides the vault location.
    const probeClient = new GitClient(resolveAgentSyncHome());
    let remoteState: Awaited<ReturnType<GitClient["inspectRemoteBranch"]>>;
    try {
      remoteState = await probeClient.inspectRemoteBranch(args.remote, args.branch);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    await mkdir(runtime.vaultDir, { recursive: true });
    let git = new GitClient(runtime.vaultDir);

    // `keyIsNew` is declared outside the try so the catch can tell whether
    // this invocation generated the key (and is allowed to delete it) or
    // inherited one from a previous successful init (which must be preserved).
    // It is only set to true after `ensureKeypair` returns successfully —
    // partial-write and post-write failures inside `ensureKeypair` clean up
    // their own orphan file locally (see its contract above), since this
    // catch cannot observe `isNew` for a call that threw.
    let keyIsNew = false;
    try {
      const { recipient, isNew } = await ensureKeypair(runtime.privateKeyPath);
      keyIsNew = isNew;

      const repoInitialized = await git.isInitialized();

      if (!repoInitialized) {
        if (remoteState.exists) {
          git = await GitClient.clone(args.remote, runtime.vaultDir, args.branch);
          log.info(`Joined existing remote vault history from ${args.remote}.`);
        } else {
          await git.init();
          await git.setHeadBranch(args.branch);
          await git.ensureRemote("origin", args.remote);
        }
      } else {
        await git.ensureRemote("origin", args.remote);
        await git.reconcileWithRemote({
          remote: "origin",
          branch: args.branch,
          allowMissingRemote: true,
        });
      }

      const configPath = resolveConfigPath(runtime.vaultDir);

      let existing = null;
      try {
        existing = await loadConfig(configPath);
      } catch {
        existing = null;
      }

      const joinedExistingVault =
        existing !== null && existing.recipients[runtime.machineName] !== recipient;

      const config = {
        version: existing?.version ?? "1",
        recipients: {
          ...(existing?.recipients ?? {}),
          [runtime.machineName]: recipient,
        },
        agents: existing?.agents ?? DEFAULT_AGENTS,
        remote: {
          url: args.remote,
          branch: args.branch,
        },
        sync: existing?.sync ?? DEFAULT_SYNC,
        claudePlugins: existing?.claudePlugins ?? { syncMarketplace: false },
      };

      await writeConfig(configPath, config);

      const gitignorePath = join(runtime.vaultDir, ".gitignore");
      await writeFile(gitignorePath, "*.tmp\n", "utf8");
      await readFile(configPath, "utf8");

      const committed = await git.commit({ message: `init: ${runtime.machineName}` });
      if (committed) {
        await git.push("origin", args.branch, remoteState.exists ? [] : ["--set-upstream"]);
        log.info("Vault pushed to remote.");
      }

      // Defer the keypair status log until every fallible step above has
      // succeeded. Reporting "New age keypair generated, back it up now"
      // earlier risks the user copying a key into a password manager seconds
      // before the catch block rolls it back, leaving them with a backup
      // that no longer matches anything on disk.
      if (keyIsNew) {
        log.warn(
          `New age keypair generated.\n  Public key : ${recipient}\n  Private key: ${runtime.privateKeyPath}\n  ⚠  Back up your private key in a password manager now. It cannot be recovered.`,
        );
      } else {
        log.info(`Loaded existing keypair — public key: ${recipient}`);
      }

      log.success(`Initialized vault at ${runtime.vaultDir}`);

      if (joinedExistingVault) {
        // The new machine wrote its pubkey into the recipient set but cannot
        // re-encrypt existing .age artifacts itself (no decryption key). An
        // existing recipient must run `key add` to grant read access.
        log.warn(
          [
            "This machine is registered but cannot decrypt the existing vault yet.",
            "An existing recipient must run on a machine that can decrypt the vault:",
            `  agentsync key add ${runtime.machineName} ${recipient}`,
            "Until that runs, `agentsync pull` on this machine will fail.",
          ].join("\n"),
        );
      }
    } catch (err) {
      // The remote probe above passed, so the failure here is in keypair
      // generation, clone/init, reconcile, config write, commit, or push. If
      // we generated the key on this invocation, delete it so a retry is not
      // bound to material that never made it into a successful init. A
      // pre-existing key (one a previous successful init committed to) is
      // preserved untouched.
      if (keyIsNew) {
        try {
          await rm(runtime.privateKeyPath, { force: true });
          log.info(`Rolled back freshly generated keypair at ${runtime.privateKeyPath}.`);
        } catch (rmErr) {
          // Surface rm failures (EBUSY/EACCES/EROFS) as a warning instead of
          // letting them propagate and mask the real init error below. The
          // hint tells the user that an orphan key.txt may still be on disk
          // and a naive retry would silently inherit it.
          const rmMessage = rmErr instanceof Error ? rmErr.message : String(rmErr);
          log.warn(
            `Failed to roll back freshly generated key at ${runtime.privateKeyPath}: ${rmMessage}.\nRemove key.txt manually before retrying.`,
          );
        }
      }
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
});
