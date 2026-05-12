import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, resolveConfigPath, writeConfig } from "../config/loader";
import { generateIdentity, identityToRecipient } from "../core/encryptor";
import { GitClient } from "../core/git";
import { loadPrivateKey, resolveRuntimeContext } from "./shared";

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
 */
async function ensureKeypair(
  path: string,
): Promise<{ identity: string; recipient: string; isNew: boolean }> {
  let identity: string;
  let isNew = false;

  try {
    identity = await loadPrivateKey(path);
  } catch {
    identity = await generateIdentity();
    await writeFile(path, `${identity}\n`, { mode: 0o600 });
    isNew = true;
  }

  const recipient = await identityToRecipient(identity);

  return { identity, recipient, isNew };
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
    await mkdir(runtime.vaultDir, { recursive: true });

    let git = new GitClient(runtime.vaultDir);

    // Probe the remote BEFORE writing any key material. An unreachable or
    // auth-blocked remote here must abort with no `key.txt` on disk so a
    // retry against a different URL does not silently inherit an orphan key
    // that was generated for a never-completed init.
    let remoteState: Awaited<ReturnType<GitClient["inspectRemoteBranch"]>>;
    try {
      remoteState = await git.inspectRemoteBranch(args.remote, args.branch);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }

    // `keyIsNew` is declared outside the try so the catch can tell whether
    // this invocation generated the key (and is allowed to delete it) or
    // inherited one from a previous successful init (which must be preserved).
    let keyIsNew = false;
    try {
      // `ensureKeypair` is inside the guarded block so a mid-call failure
      // (writeFile partial-write, identityToRecipient throw) still triggers
      // the rollback below instead of leaving a half-written key on disk.
      const { recipient, isNew } = await ensureKeypair(runtime.privateKeyPath);
      keyIsNew = isNew;

      if (keyIsNew) {
        log.warn(
          `New age keypair generated.\n  Public key : ${recipient}\n  Private key: ${runtime.privateKeyPath}\n  ⚠  Back up your private key in a password manager now. It cannot be recovered.`,
        );
      } else {
        log.info(`Loaded existing keypair — public key: ${recipient}`);
      }

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
