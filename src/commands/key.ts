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

        try {
          const git = new GitClient(runtime.vaultDir);
          const reconciliation = await git.reconcileWithRemote({
            remote: "origin",
            branch: config.remote.branch,
            allowMissingRemote: true,
          });
          const refreshedConfig = await loadConfig(configPath);

          refreshedConfig.recipients[name] = pubkey;
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
          const committed = await git.commit({ message: `key: add recipient ${name}` });
          if (committed) {
            await git.push(
              "origin",
              refreshedConfig.remote.branch,
              reconciliation.status === "remote-missing" ? ["--set-upstream"] : [],
            );
          }

          log.success(
            `Added recipient '${name}'. Vault re-encrypted for ${allRecipients.length} recipient(s).`,
          );
        } catch (err) {
          log.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
      },
    }),

    rotate: defineCommand({
      meta: { description: "Generate a new local age identity and re-encrypt the vault" },
      async run() {
        const runtime = await resolveRuntimeContext();
        const configPath = resolveConfigPath(runtime.vaultDir);
        const oldKey = await loadPrivateKey(runtime.privateKeyPath);

        try {
          const git = new GitClient(runtime.vaultDir);
          const initialConfig = await loadConfig(configPath);
          const reconciliation = await git.reconcileWithRemote({
            remote: "origin",
            branch: initialConfig.remote.branch,
            allowMissingRemote: true,
          });
          const config = await loadConfig(configPath);
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
          const newIdentity = await generateIdentity();
          const newRecipient = await identityToRecipient(newIdentity);

          config.recipients[machineName] = newRecipient;
          await writeConfig(configPath, config);

          const { open } = await import("node:fs/promises");
          const fh = await open(runtime.privateKeyPath, "w", 0o600);
          await fh.writeFile(`${newIdentity}\n`, "utf8");
          await fh.close();

          const allRecipients = Object.values(config.recipients);
          const ageFiles = await findAgeFiles(runtime.vaultDir);

          for (const filePath of ageFiles) {
            const encrypted = await readFile(filePath, "utf8");
            const decrypted = await decryptString(encrypted, oldKey);
            const reEncrypted = await encryptString(decrypted, allRecipients);
            await writeFile(filePath, reEncrypted, "utf8");
          }

          await git.addAll();
          const committed = await git.commit({ message: `key: rotate ${machineName}` });
          if (committed) {
            await git.push(
              "origin",
              config.remote.branch,
              reconciliation.status === "remote-missing" ? ["--set-upstream"] : [],
            );
          }

          log.success(`Rotated key for '${machineName}'.`);
          log.info(`New public key: ${newRecipient}`);
          log.warn(`Remember to back up: ${runtime.privateKeyPath}`);
        } catch (err) {
          log.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 1;
        }
      },
    }),
  },
});
