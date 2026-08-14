import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, peekVaultVersion, resolveConfigPath, writeConfig } from "../config/loader";
import { resolveAgentSyncHome } from "../config/paths";
import { CURRENT_VAULT_VERSION } from "../config/schema";
import { generateIdentity, identityToRecipient } from "../core/encryptor";
import { GitClient } from "../core/git";
import {
  isFileNotFoundError,
  loadPrivateKey,
  pinMachineNameIfAbsent,
  resolveRuntimeContext,
} from "./shared";

const DEFAULT_AGENTS = {
  cursor: true,
  claude: true,
  codex: true,
  copilot: true,
  vscode: false,
  opencode: false,
};

const DEFAULT_SECURITY = {
  secretScan: "standard" as const,
  allowSecretValues: [] as string[],
  redactBase64Values: true,
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
  | { status: "vault-needs-upgrade"; vaultDir: string }
  | { status: "unsupported-version"; version: number }
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
 * Remove a key generated on this invocation when init aborts, so a retry is not
 * bound to material that never made it into a successful init. A pre-existing
 * key (keyIsNew false) is preserved untouched. Returns whether it removed one.
 */
async function rollbackFreshKey(keyIsNew: boolean, path: string): Promise<boolean> {
  if (!keyIsNew) return false;
  try {
    await rm(path, { force: true });
    return true;
  } catch (rmErr) {
    const rmMessage = rmErr instanceof Error ? rmErr.message : String(rmErr);
    log.warn(
      `Failed to roll back freshly generated key at ${path}: ${rmMessage}.\nRemove key.txt manually before retrying.`,
    );
    return false;
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
  let pushAttempted = false;
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

    // Refuse to join a vault this binary cannot safely write. A v1 vault must be
    // upgraded first — otherwise the v2 schema fails to load it, we treat it as
    // fresh, and re-create a config that drops every other machine's recipient.
    const probe = await peekVaultVersion(configPath);
    if (probe.kind === "v1" || probe.kind === "unsupported") {
      // Refusing to join — roll back a key generated this run so it does not
      // linger unused (mirrors the failure path below).
      await rollbackFreshKey(keyIsNew, runtime.privateKeyPath);
      return probe.kind === "v1"
        ? { status: "vault-needs-upgrade", vaultDir: runtime.vaultDir }
        : { status: "unsupported-version", version: probe.version };
    }

    let existing = null;
    try {
      existing = await loadConfig(configPath);
    } catch {
      existing = null;
    }

    const joinedExistingVault =
      existing !== null && existing.recipients[runtime.machineName] !== recipient;

    await writeConfig(configPath, {
      version: CURRENT_VAULT_VERSION,
      recipients: {
        ...(existing?.recipients ?? {}),
        [runtime.machineName]: recipient,
      },
      agents: existing?.agents ?? DEFAULT_AGENTS,
      remote: {
        url: options.remote,
        branch: options.branch,
      },
      claudePlugins: existing?.claudePlugins ?? { syncPlugins: false },
      security: existing?.security ?? DEFAULT_SECURITY,
    });

    // Pin the machine name to local state so a later hostname change cannot
    // re-derive a different name and orphan this machine's vault namespace
    // (machines/<name>/ in v2). Idempotent: a no-op once pinned. The name is
    // already validated in resolveRuntimeContext, and the pin is deliberately
    // NOT part of the key rollback below: it is local identity, so a retry must
    // resolve to the same namespace and reuse it.
    await pinMachineNameIfAbsent(runtime.machineFilePath, runtime.machineName);

    const gitignorePath = join(runtime.vaultDir, ".gitignore");
    await writeFile(gitignorePath, "*.tmp\n", "utf8");

    const committed = await git.commit({ message: `init: ${runtime.machineName}` });
    if (committed) {
      pushAttempted = true;
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
    // The remote probe passed but a later step failed. Roll back a key generated
    // this invocation so a retry is not bound to material that never made it into
    // a successful init. A pre-existing key is preserved untouched. Do NOT roll
    // back once a push was attempted: the commit (registering this machine's
    // recipient) may already be local or pushed, and a retry must reuse this key.
    const keyRolledBack = pushAttempted
      ? false
      : await rollbackFreshKey(keyIsNew, runtime.privateKeyPath);
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

    if (result.status === "vault-needs-upgrade") {
      log.error(
        `Vault at ${result.vaultDir} uses the old flat layout. An existing member must run \`agentsync vault upgrade\` to migrate it before this machine can join.`,
      );
      process.exitCode = 1;
      return;
    }

    if (result.status === "unsupported-version") {
      log.error(
        `Vault uses format v${result.version}, newer than this agentsync. Run \`agentsync upgrade\` to update agentsync first.`,
      );
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
          "Until that runs, this machine cannot decrypt other machines' artifacts.",
        ].join("\n"),
      );
    }
  },
});
