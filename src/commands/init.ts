import { mkdir, rm, writeFile } from "node:fs/promises";
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

/** Discriminated result of a `performInit` invocation — lets non-CLI callers
 * (e.g. the TUI init wizard) react to outcomes without parsing log output. */
export type InitResult =
  | {
      status: "success";
      vaultDir: string;
      joinedExistingVault: boolean;
      recipient: string;
      machineName: string;
      keyIsNew: boolean;
      privateKeyPath: string;
    }
  | { status: "remote-probe-failed"; error: string }
  | { status: "failed"; error: string; keyRolledBack: boolean };

export interface InitOptions {
  remote: string;
  branch: string;
}

async function ensureKeypair(
  path: string,
): Promise<{ identity: string; recipient: string; isNew: boolean }> {
  try {
    const identity = await loadPrivateKey(path);
    const recipient = await identityToRecipient(identity);
    return { identity, recipient, isNew: false };
  } catch (err) {
    // Only auto-generate when key.txt is genuinely absent. Other read errors
    // (EACCES on a locked-down key, malformed file, unreadable mount) surface
    // as failures so we never overwrite material the user may still recover.
    if (!isFileNotFoundError(err)) throw err;
  }

  const identity = await generateIdentity();
  try {
    await writeFile(path, `${identity}\n`, { mode: 0o600 });
    const recipient = await identityToRecipient(identity);
    return { identity, recipient, isNew: true };
  } catch (err) {
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

/**
 * Bootstrap a vault, local key material, and the initial git remote wiring.
 * Returns a discriminated {@link InitResult} so both the CLI wrapper and the
 * TUI wizard can render their own feedback. Never calls `process.exit*` —
 * callers decide whether to set an exit code.
 */
export async function performInit(options: InitOptions): Promise<InitResult> {
  const runtime = await resolveRuntimeContext();

  // Probe the remote BEFORE writing any local artifacts. An unreachable or
  // auth-blocked remote must abort with no on-disk state so a retry against
  // a different URL does not silently inherit an orphan key or empty vault.
  const probeClient = new GitClient(resolveAgentSyncHome());
  let remoteState: Awaited<ReturnType<GitClient["inspectRemoteBranch"]>>;
  try {
    remoteState = await probeClient.inspectRemoteBranch(options.remote, options.branch);
  } catch (err) {
    return {
      status: "remote-probe-failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await mkdir(runtime.vaultDir, { recursive: true });
  let git = new GitClient(runtime.vaultDir);

  let keyIsNew = false;
  try {
    const { recipient, isNew } = await ensureKeypair(runtime.privateKeyPath);
    keyIsNew = isNew;

    const repoInitialized = await git.isInitialized();

    if (!repoInitialized) {
      if (remoteState.exists) {
        git = await GitClient.clone(options.remote, runtime.vaultDir, options.branch);
      } else {
        await git.init();
        await git.setHeadBranch(options.branch);
        await git.ensureRemote("origin", options.remote);
      }
    } else {
      await git.ensureRemote("origin", options.remote);
      await git.reconcileWithRemote({
        remote: "origin",
        branch: options.branch,
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
        url: options.remote,
        branch: options.branch,
      },
      sync: existing?.sync ?? DEFAULT_SYNC,
      claudePlugins: existing?.claudePlugins ?? { syncMarketplace: false },
    };

    await writeConfig(configPath, config);

    const gitignorePath = join(runtime.vaultDir, ".gitignore");
    await writeFile(gitignorePath, "*.tmp\n", "utf8");

    const committed = await git.commit({ message: `init: ${runtime.machineName}` });
    if (committed) {
      await git.push("origin", options.branch, remoteState.exists ? [] : ["--set-upstream"]);
    }

    return {
      status: "success",
      vaultDir: runtime.vaultDir,
      joinedExistingVault,
      recipient,
      machineName: runtime.machineName,
      keyIsNew,
      privateKeyPath: runtime.privateKeyPath,
    };
  } catch (err) {
    // The remote probe passed but a later step failed. If we generated the
    // key on this invocation, delete it so a retry is not bound to material
    // that never made it into a successful init. A pre-existing key is
    // preserved untouched.
    let keyRolledBack = false;
    if (keyIsNew) {
      try {
        await rm(runtime.privateKeyPath, { force: true });
        keyRolledBack = true;
      } catch (rmErr) {
        const rmMessage = rmErr instanceof Error ? rmErr.message : String(rmErr);
        log.warn(
          `Failed to roll back freshly generated key at ${runtime.privateKeyPath}: ${rmMessage}.\nRemove key.txt manually before retrying.`,
        );
      }
    }
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      keyRolledBack,
    };
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
    const result = await performInit({ remote: args.remote, branch: args.branch });

    if (result.status === "remote-probe-failed") {
      log.error(result.error);
      process.exitCode = 1;
      return;
    }

    if (result.status === "failed") {
      if (result.keyRolledBack) {
        log.info("Rolled back freshly generated keypair.");
      }
      log.error(result.error);
      process.exitCode = 1;
      return;
    }

    if (result.keyIsNew) {
      log.warn(
        `New age keypair generated.\n  Public key : ${result.recipient}\n  Private key: ${result.privateKeyPath}\n  ⚠  Back up your private key in a password manager now. It cannot be recovered.`,
      );
    } else {
      log.info(`Loaded existing keypair — public key: ${result.recipient}`);
    }

    log.success(`Initialized vault at ${result.vaultDir}`);

    if (result.joinedExistingVault) {
      log.warn(
        [
          "This machine is registered but cannot decrypt the existing vault yet.",
          "An existing recipient must run on a machine that can decrypt the vault:",
          `  agentsync key add ${result.machineName} ${result.recipient}`,
          "Until that runs, `agentsync pull` on this machine will fail.",
        ].join("\n"),
      );
    }
  },
});
