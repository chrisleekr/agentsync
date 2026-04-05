import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** Load or create the local age keypair so init can register this machine as a recipient. */
async function ensureKeypair(path: string): Promise<{ identity: string; recipient: string }> {
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

  if (isNew) {
    log.warn(
      `New age keypair generated.\n  Public key : ${recipient}\n  Private key: ${path}\n  ⚠  Back up your private key in a password manager now. It cannot be recovered.`,
    );
  } else {
    log.info(`Loaded existing keypair — public key: ${recipient}`);
  }

  return { identity, recipient };
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

    const { recipient } = await ensureKeypair(runtime.privateKeyPath);

    let git = new GitClient(runtime.vaultDir);

    try {
      const repoInitialized = await git.isInitialized();
      const remoteState = await git.inspectRemoteBranch(args.remote, args.branch);

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
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  },
});
