import { randomUUID } from "node:crypto";
import { open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * Decrypt every vault `.age` file once with the given identity.
 *
 * Built fully in memory BEFORE any caller writes to disk: an unreadable or
 * corrupt artefact rejects here, so a re-encryption that aborts mid-way never
 * leaves the key/config mutated. This preserves the `key rotate` contract that
 * a failed re-encryption leaves `key.txt` and `agentsync.toml` untouched.
 */
async function decryptAllAgeFiles(files: string[], identity: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const file of files) {
    const armored = await readFile(file, "utf8");
    out.set(file, await decryptString(armored, identity));
  }
  return out;
}

/** Re-encrypt a plaintext map to a recipient set, returning armored ciphertext per path. */
async function encryptAll(
  plaintexts: Map<string, string>,
  recipients: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [file, plaintext] of plaintexts) {
    out.set(file, await encryptString(plaintext, recipients));
  }
  return out;
}

/** Flush a path→ciphertext map to disk. */
async function writeAll(ciphertexts: Map<string, string>): Promise<void> {
  for (const [file, content] of ciphertexts) {
    await writeFile(file, content, "utf8");
  }
}

/**
 * Persist an age identity with crash durability: write a sibling temp file,
 * fsync it, then rename it over the destination. rename(2) is atomic on a single
 * filesystem, so a crash leaves either the old key or the new key fully intact,
 * never a truncated middle that bricks the machine's only decryption material.
 */
async function writeIdentityAtomic(path: string, identity: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "w", 0o600);
  try {
    try {
      await handle.writeFile(`${identity}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (err) {
    // Any failure before the rename completes leaves a stray temp; drop it so a
    // crashed write never litters the key directory with a partial identity.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Discriminated result of a `performKeyAdd` invocation. */
export type KeyAddResult =
  | { status: "success"; name: string; recipientCount: number }
  | { status: "invalid-key"; error: string }
  | { status: "name-conflict"; name: string }
  | { status: "duplicate-key"; name: string; existingName: string }
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

/** Discriminated result of a `performKeyRemove` invocation. */
export type KeyRemoveResult =
  | { status: "success"; name: string; remaining: number }
  | { status: "not-found"; name: string; available: string[] }
  | { status: "last-recipient"; name: string }
  | { status: "self"; name: string }
  | { status: "failed"; error: string };

/** One recipient row for `performKeyList`. */
export interface KeyListEntry {
  name: string;
  recipient: string;
  /** True when this recipient is the key on the current machine. */
  isSelf: boolean;
}

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

    // One pubkey per alias: the `key remove` self-guard refuses removal by
    // comparing the stored pubkey to the local identity, so a pubkey registered
    // under two aliases would make "remove this alias" ambiguous. Reject a
    // duplicate pubkey under a different name (the same-name path above is the
    // idempotent re-add and is allowed).
    const duplicateAlias = Object.entries(refreshedConfig.recipients).find(
      ([name, pubkey]) => pubkey === options.pubkey && name !== options.name,
    )?.[0];
    if (duplicateAlias) {
      return { status: "duplicate-key", name: options.name, existingName: duplicateAlias };
    }

    refreshedConfig.recipients[options.name] = options.pubkey;

    const key = await loadPrivateKey(runtime.privateKeyPath);
    const allRecipients = Object.values(refreshedConfig.recipients);
    const ageFiles = await findAgeFiles(runtime.vaultDir);

    // Build the re-encrypted ciphertext in memory before writing anything, so a
    // decrypt failure aborts with the vault untouched. The old key stays in
    // `allRecipients`, so every on-disk file remains readable throughout —
    // adding a recipient can never orphan content. Files are written before the
    // config so a mid-write crash never leaves a config that claims a recipient
    // the on-disk ciphertext does not yet include.
    const plaintexts = await decryptAllAgeFiles(ageFiles, key);
    const reEncrypted = await encryptAll(plaintexts, allRecipients);
    await writeAll(reEncrypted);
    await writeConfig(configPath, refreshedConfig);

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
 *
 * Crash-safe by a two-pass re-encryption around the key swap:
 *   1. Re-encrypt every file to `union(new recipients, old recipient)` and write
 *      it — the old key still decrypts everything on disk.
 *   2. Persist the new identity atomically. The new recipient is a member of the
 *      union just written, so a crash on either side of this step still leaves
 *      every on-disk file readable by an on-disk key — no lock-out window.
 *   3. Re-encrypt every file to the new recipient set only, dropping the old
 *      recipient so a retired identity can no longer decrypt fresh pushes.
 * Both ciphertext maps are built before any write, so a corrupt artefact aborts
 * with `key.txt` and `agentsync.toml` untouched.
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
    const newRecipients = Object.values(nextConfig.recipients);
    // Dedup so the union never lists the same recipient twice (another alias
    // could already hold the old recipient). The old recipient is gone from
    // nextConfig, so the union is the new set plus the old.
    const unionRecipients = Array.from(new Set([...newRecipients, oldRecipient]));
    const ageFiles = await findAgeFiles(runtime.vaultDir);

    const plaintexts = await decryptAllAgeFiles(ageFiles, oldKey);
    const unionCiphertext = await encryptAll(plaintexts, unionRecipients);
    const newCiphertext = await encryptAll(plaintexts, newRecipients);

    // Pass 1: union ciphertext (old key still decrypts everything on disk).
    await writeAll(unionCiphertext);
    // Swap the key atomically between the passes.
    await writeIdentityAtomic(runtime.privateKeyPath, newIdentity);
    // Pass 2: drop the old recipient (new key decrypts everything).
    await writeAll(newCiphertext);

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

/**
 * Remove a recipient from the vault and re-encrypt every artefact for the
 * remaining set, so the removed key can no longer decrypt FUTURE pushes.
 *
 * Refuses to remove the last recipient (a vault must stay decryptable) and the
 * running machine's own key (you cannot deauthorize the machine you are on —
 * remove a lost machine from a different one). The re-encryption targets a
 * subset that still contains the local key, so every on-disk file stays readable
 * throughout; the ciphertext map is built before any write so a failure leaves
 * the vault untouched.
 */
export async function performKeyRemove(options: { name: string }): Promise<KeyRemoveResult> {
  const runtime = await resolveRuntimeContext();
  const configPath = resolveConfigPath(runtime.vaultDir);
  const config = await loadVaultConfigOrExit(runtime.vaultDir);

  try {
    // Inside the try so a missing or unreadable key returns a typed `failed`
    // result rather than escaping as a raw rejection.
    const key = await loadPrivateKey(runtime.privateKeyPath);
    const git = new GitClient(runtime.vaultDir);
    const reconciliation = await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      allowMissingRemote: true,
    });
    const refreshed = await loadConfig(configPath);

    if (!refreshed.recipients[options.name]) {
      return {
        status: "not-found",
        name: options.name,
        available: Object.keys(refreshed.recipients).sort(),
      };
    }

    const localRecipient = await identityToRecipient(key);
    if (refreshed.recipients[options.name] === localRecipient) {
      return { status: "self", name: options.name };
    }

    const next = structuredClone(refreshed);
    delete next.recipients[options.name];
    const remaining = Object.values(next.recipients);
    if (remaining.length === 0) {
      return { status: "last-recipient", name: options.name };
    }

    const ageFiles = await findAgeFiles(runtime.vaultDir);
    const plaintexts = await decryptAllAgeFiles(ageFiles, key);
    const reEncrypted = await encryptAll(plaintexts, remaining);
    // Re-encrypt the artefacts BEFORE dropping the recipient from config, so a
    // mid-write crash fails safe: the removed key is already excluded from the
    // on-disk ciphertext while config still lists it, never the reverse.
    await writeAll(reEncrypted);
    await writeConfig(configPath, next);

    await git.addAll();
    const committed = await git.commit({ message: `key: remove recipient ${options.name}` });
    if (committed) {
      await git.push(
        "origin",
        next.remote.branch,
        reconciliation.status === "remote-missing" ? ["--set-upstream"] : [],
      );
    }

    return { status: "success", name: options.name, remaining: remaining.length };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * List the recipients registered in the vault config, flagging the one that
 * matches the local machine's key. Read-only: reads the committed local config
 * (the same source `status` reads), never pushes. A missing local key means the
 * self flag cannot be computed, so every row is reported as not-self.
 */
export async function performKeyList(): Promise<KeyListEntry[]> {
  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);

  let localRecipient: string | null = null;
  try {
    localRecipient = await identityToRecipient(await loadPrivateKey(runtime.privateKeyPath));
  } catch {
    localRecipient = null;
  }

  return Object.entries(config.recipients)
    .map(([name, recipient]) => ({ name, recipient, isSelf: recipient === localRecipient }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
          case "duplicate-key":
            log.error(
              `That public key is already registered as '${result.existingName}'. Reuse that alias, or remove it first.`,
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

    remove: defineCommand({
      meta: {
        description:
          "Remove a recipient and re-encrypt the vault so they can no longer decrypt new pushes",
      },
      args: {
        name: {
          type: "positional",
          description: "Recipient alias to remove (see `agentsync key list`)",
          required: true,
        },
      },
      async run({ args }) {
        const result = await performKeyRemove({ name: String(args.name) });

        switch (result.status) {
          case "success":
            log.success(
              `Removed recipient '${result.name}'. Vault re-encrypted for ${result.remaining} recipient(s).`,
            );
            log.warn(
              [
                "The removed key can still decrypt PRIOR vault history already on the remote.",
                "For true revocation of a lost machine, rotate any secrets it could read.",
              ].join("\n"),
            );
            return;
          case "not-found":
            log.error(
              `No recipient named '${result.name}'. Known: ${result.available.join(", ") || "(none)"}`,
            );
            process.exitCode = 1;
            return;
          case "last-recipient":
            log.error(
              `Refusing to remove '${result.name}': it is the only recipient. A vault must keep at least one.`,
            );
            process.exitCode = 1;
            return;
          case "self":
            log.error(
              `Refusing to remove '${result.name}': it is THIS machine's own key. Run \`agentsync key remove ${result.name}\` from another machine to deauthorize this one.`,
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

    list: defineCommand({
      meta: { description: "List the recipients who can decrypt the vault" },
      async run() {
        const entries = await performKeyList();
        if (entries.length === 0) {
          log.warn("No recipients registered. Run `agentsync init` first.");
          return;
        }
        log.info("Recipients ('*' = this machine):");
        for (const entry of entries) {
          log.info(`  ${entry.isSelf ? "*" : " "} ${entry.name}  ${entry.recipient}`);
        }
        log.info(`${entries.length} recipient(s) can decrypt the vault.`);
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
