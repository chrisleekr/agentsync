import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, resolveConfigPath, writeConfig } from "../config/loader";
import { generateIdentity, identityToRecipient } from "../core/encryptor";
import { GitClient } from "../core/git";
import { loadPrivateKey, resolveRuntimeContext } from "./shared";

/**
 * Load an existing age identity from disk, or generate a new X25519 keypair
 * and persist it to disk with 0o600 permissions.
 * Returns { identity, recipient } where identity is the AGE-SECRET-KEY-1… string
 * and recipient is the age1… public key.
 */
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

    const configPath = resolveConfigPath(runtime.vaultDir);

    // Load existing config if present so we don't overwrite other machines' recipients
    let existingRecipients: Record<string, string> = {};
    try {
      const existing = await loadConfig(configPath);
      existingRecipients = existing.recipients;
    } catch {
      // No existing config — start fresh
    }

    const config = {
      version: "1",
      recipients: {
        ...existingRecipients,
        [runtime.machineName]: recipient,
      },
      agents: {
        cursor: true,
        claude: true,
        codex: true,
        copilot: true,
        vscode: false,
      },
      remote: {
        url: args.remote,
        branch: args.branch,
      },
      sync: {
        debounceMs: 300,
        autoPush: true,
        autoPull: true,
        pullIntervalMs: 300_000,
      },
    };

    await writeConfig(configPath, config);

    const gitignorePath = join(runtime.vaultDir, ".gitignore");
    await writeFile(gitignorePath, "*.tmp\n", "utf8");

    // Ensure manifest was written.
    await readFile(configPath, "utf8");

    // Set up git repository if not already initialised
    const git = new GitClient(runtime.vaultDir);
    if (!(await git.isInitialized())) {
      await git.init();
      await git.addRemote("origin", args.remote);
    }

    // Best-effort pull (tolerate failure for brand-new vaults)
    try {
      await git.pull("origin", args.branch);
    } catch {
      // New vault — no history on remote yet
    }

    await git.addAll();
    const committed = await git.commit({ message: `init: ${runtime.machineName}` });
    if (committed) {
      try {
        await git.push("origin", args.branch, ["--set-upstream"]);
        log.info("Vault pushed to remote.");
      } catch (err) {
        log.warn(`Initial push failed — push manually later: ${String(err)}`);
      }
    }

    log.success(`Initialized vault at ${runtime.vaultDir}`);
  },
});
