import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, resolveConfigPath, writeConfig } from "../config/loader";
import { AgePublicKeySchema } from "../config/schema";
import {
  decryptString,
  encryptString,
  generateIdentity,
  identityToRecipient,
} from "../core/encryptor";
import { GitClient } from "../core/git";
import { loadPrivateKey, loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

/** Walk a directory recursively and return all paths ending in `.age`. */
async function findAgeFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (info.isDirectory()) {
        results.push(...(await findAgeFiles(full)));
      } else if (info.isFile() && name.endsWith(".age")) {
        results.push(full);
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return results;
}

/** Discriminated result of a `performKeyAdd` invocation. */
export type KeyAddResult =
  | { status: "success"; name: string; recipientCount: number }
  | { status: "invalid-key"; error: string }
  | { status: "name-conflict"; name: string }
  | { status: "failed"; error: string };

/** Discriminated result of a `performKeyRotate` invocation. */
export type KeyRotateResult =
  | {
      status: "success";
      machineName: string;
      newRecipient: string;
      privateKeyPath: string;
    }
  | { status: "not-in-recipients"; error: string }
  | { status: "failed"; error: string };

/**
 * Add an age recipient to the vault and re-encrypt every `.age` artefact for
 * the full recipient set. Returns a typed result so non-CLI callers can render
 * their own feedback.
 */
export async function performKeyAdd(options: {
  name: string;
  pubkey: string;
}): Promise<KeyAddResult> {
  const parsed = AgePublicKeySchema.safeParse(options.pubkey);
  if (!parsed.success) {
    return { status: "invalid-key", error: parsed.error.issues[0].message };
  }

  const runtime = await resolveRuntimeContext();
  const configPath = resolveConfigPath(runtime.vaultDir);
  const config = await loadVaultConfigOrExit(runtime.vaultDir);

  if (config.recipients[options.name] && config.recipients[options.name] !== options.pubkey) {
    return { status: "name-conflict", name: options.name };
  }

  try {
    const git = new GitClient(runtime.vaultDir);
    const reconciliation = await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      allowMissingRemote: true,
    });
    const refreshedConfig = await loadConfig(configPath);

    // Idempotent on matching pubkey: the joining machine's `init` already
    // wrote its own entry to recipients on the remote.
    if (
      refreshedConfig.recipients[options.name] &&
      refreshedConfig.recipients[options.name] !== options.pubkey
    ) {
      return { status: "name-conflict", name: options.name };
    }

    refreshedConfig.recipients[options.name] = options.pubkey;
    await writeConfig(configPath, refreshedConfig);

    const key = await loadPrivateKey(runtime.privateKeyPath);
    const allRecipients = Object.values(refreshedConfig.recipients);
    const ageFiles = await findAgeFiles(runtime.vaultDir);

    for (const filePath of ageFiles) {
      const encrypted = await readFile(filePath, "utf8");
      const decrypted = await decryptString(encrypted, key);
      const reEncrypted = await encryptString(decrypted, allRecipients);
      await writeFile(filePath, reEncrypted, "utf8");
    }

    await git.addAll();
    const committed = await git.commit({ message: `key: add recipient ${options.name}` });
    if (committed) {
      await git.push(
        "origin",
        refreshedConfig.remote.branch,
        reconciliation.status === "remote-missing" ? ["--set-upstream"] : [],
      );
    }

    return { status: "success", name: options.name, recipientCount: allRecipients.length };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Generate a new local age identity, re-encrypt every vault artefact for the
 * updated recipient set, persist the new key locally, and push the rotation.
 */
export async function performKeyRotate(): Promise<KeyRotateResult> {
  const runtime = await resolveRuntimeContext();
  const configPath = resolveConfigPath(runtime.vaultDir);
  const initialConfig = await loadVaultConfigOrExit(runtime.vaultDir);
  const oldKey = await loadPrivateKey(runtime.privateKeyPath);

  try {
    const git = new GitClient(runtime.vaultDir);
    const reconciliation = await git.reconcileWithRemote({
      remote: "origin",
      branch: initialConfig.remote.branch,
      allowMissingRemote: true,
    });
    const config = await loadConfig(configPath);
    const oldRecipient = await identityToRecipient(oldKey);

    const machineEntry = Object.entries(config.recipients).find(([, pub]) => pub === oldRecipient);

    if (!machineEntry) {
      return {
        status: "not-in-recipients",
        error:
          "Could not find the current machine's public key in config.recipients. " +
          "Cannot determine which recipient to rotate.",
      };
    }

    const [machineName] = machineEntry;
    const newIdentity = await generateIdentity();
    const newRecipient = await identityToRecipient(newIdentity);

    const nextConfig = structuredClone(config);
    nextConfig.recipients[machineName] = newRecipient;
    const allRecipients = Object.values(nextConfig.recipients);
    const ageFiles = await findAgeFiles(runtime.vaultDir);
    const rewrittenFiles = new Map<string, string>();

    for (const filePath of ageFiles) {
      const encrypted = await readFile(filePath, "utf8");
      const decrypted = await decryptString(encrypted, oldKey);
      const reEncrypted = await encryptString(decrypted, allRecipients);
      rewrittenFiles.set(filePath, reEncrypted);
    }

    for (const [filePath, reEncrypted] of rewrittenFiles) {
      await writeFile(filePath, reEncrypted, "utf8");
    }

    await writeFile(runtime.privateKeyPath, `${newIdentity}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeConfig(configPath, nextConfig);

    await git.addAll();
    const committed = await git.commit({ message: `key: rotate ${machineName}` });
    if (committed) {
      await git.push(
        "origin",
        nextConfig.remote.branch,
        reconciliation.status === "remote-missing" ? ["--set-upstream"] : [],
      );
    }

    return {
      status: "success",
      machineName,
      newRecipient,
      privateKeyPath: runtime.privateKeyPath,
    };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Manage recipients and local age key rotation for an existing vault. */
export const keyCommand = defineCommand({
  meta: {
    name: "key",
    description: "Manage age recipients and key rotation",
  },
  subCommands: {
    add: defineCommand({
      meta: { description: "Add a recipient public key (age1…) so they can decrypt the vault" },
      args: {
        name: {
          type: "positional",
          description: "Alias for this recipient (e.g. work-laptop)",
          required: true,
        },
        pubkey: {
          type: "positional",
          description: "age public key (age1…)",
          required: true,
        },
      },
      async run({ args }) {
        const result = await performKeyAdd({
          name: String(args.name),
          pubkey: String(args.pubkey),
        });

        switch (result.status) {
          case "success":
            log.success(
              `Added recipient '${result.name}'. Vault re-encrypted for ${result.recipientCount} recipient(s).`,
            );
            return;
          case "invalid-key":
            log.error(`Invalid key: ${result.error}`);
            process.exitCode = 1;
            return;
          case "name-conflict":
            log.error(
              `Recipient '${result.name}' already exists. Use a different name or remove it first.`,
            );
            process.exitCode = 1;
            return;
          case "failed":
            log.error(result.error);
            process.exitCode = 1;
            return;
        }
      },
    }),

    rotate: defineCommand({
      meta: { description: "Generate a new local age identity and re-encrypt the vault" },
      async run() {
        const result = await performKeyRotate();

        switch (result.status) {
          case "success":
            log.success(`Rotated key for '${result.machineName}'.`);
            log.info(`New public key: ${result.newRecipient}`);
            log.warn(`Remember to back up: ${result.privateKeyPath}`);
            return;
          case "not-in-recipients":
            log.error(result.error);
            process.exitCode = 1;
            return;
          case "failed":
            log.error(result.error);
            process.exitCode = 1;
            return;
        }
      },
    }),
  },
});
