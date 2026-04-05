import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, resolveConfigPath, writeConfig } from "../config/loader";
import {
  decryptString,
  encryptString,
  generateIdentity,
  identityToRecipient,
} from "../core/encryptor";
import { GitClient } from "../core/git";
import { loadPrivateKey, resolveRuntimeContext } from "./shared";

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
        const name = args.name as string;
        const pubkey = args.pubkey as string;

        if (!pubkey.startsWith("age1")) {
          log.error("Invalid key: age public keys must start with 'age1'");
          process.exitCode = 1;
          return;
        }

        const runtime = await resolveRuntimeContext();
        const configPath = resolveConfigPath(runtime.vaultDir);
        const config = await loadConfig(configPath);

        if (config.recipients[name]) {
          log.error(`Recipient '${name}' already exists. Use a different name or remove it first.`);
          process.exitCode = 1;
          return;
        }

        // Add recipient to config
        config.recipients[name] = pubkey;
        await writeConfig(configPath, config);

        // Pull latest vault state before re-encrypting to avoid overwriting remote changes
        const git = new GitClient(runtime.vaultDir);
        await git.pull("origin", config.remote.branch);

        // Re-encrypt all vault files so the new recipient can decrypt
        const key = await loadPrivateKey(runtime.privateKeyPath);
        const allRecipients = Object.values(config.recipients);
        const ageFiles = await findAgeFiles(runtime.vaultDir);

        for (const filePath of ageFiles) {
          const encrypted = await readFile(filePath, "utf8");
          const decrypted = await decryptString(encrypted, key);
          const reEncrypted = await encryptString(decrypted, allRecipients);
          await writeFile(filePath, reEncrypted, "utf8");
        }

        await git.addAll();
        await git.commit({ message: `key: add recipient ${name}` });
        await git.push("origin", config.remote.branch);

        log.success(
          `Added recipient '${name}'. Vault re-encrypted for ${allRecipients.length} recipient(s).`,
        );
      },
    }),

    rotate: defineCommand({
      meta: { description: "Generate a new local age identity and re-encrypt the vault" },
      async run() {
        const runtime = await resolveRuntimeContext();
        const configPath = resolveConfigPath(runtime.vaultDir);
        const config = await loadConfig(configPath);

        // Find our current machine name from config by matching old recipient key
        const oldKey = await loadPrivateKey(runtime.privateKeyPath);
        const oldRecipient = await identityToRecipient(oldKey);

        const machineEntry = Object.entries(config.recipients).find(
          ([, pub]) => pub === oldRecipient,
        );

        if (!machineEntry) {
          log.error(
            "Could not find the current machine's public key in config.recipients. " +
              "Cannot determine which recipient to rotate.",
          );
          process.exitCode = 1;
          return;
        }

        const [machineName] = machineEntry;

        // Generate new identity
        const newIdentity = await generateIdentity();
        const newRecipient = await identityToRecipient(newIdentity);

        // Update config to replace old recipient with new one
        config.recipients[machineName] = newRecipient;
        await writeConfig(configPath, config);

        // Overwrite private key file (mode 0o600 preserved)
        const { open } = await import("node:fs/promises");
        const fh = await open(runtime.privateKeyPath, "w", 0o600);
        await fh.writeFile(`${newIdentity}\n`, "utf8");
        await fh.close();

        // Pull latest vault state before re-encrypting to avoid overwriting remote changes
        const git = new GitClient(runtime.vaultDir);
        await git.pull("origin", config.remote.branch);

        // Re-encrypt all vault files: decrypt with old key, encrypt for all new recipients
        const allRecipients = Object.values(config.recipients);
        const ageFiles = await findAgeFiles(runtime.vaultDir);

        for (const filePath of ageFiles) {
          const encrypted = await readFile(filePath, "utf8");
          const decrypted = await decryptString(encrypted, oldKey);
          const reEncrypted = await encryptString(decrypted, allRecipients);
          await writeFile(filePath, reEncrypted, "utf8");
        }

        await git.addAll();
        await git.commit({ message: `key: rotate ${machineName}` });
        await git.push("origin", config.remote.branch);

        log.success(`Rotated key for '${machineName}'.`);
        log.info(`New public key: ${newRecipient}`);
        log.warn(`Remember to back up: ${runtime.privateKeyPath}`);
      },
    }),
  },
});
