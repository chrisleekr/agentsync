import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { log } from "@clack/prompts";
import {
  formatConfigError,
  isConfigParseError,
  loadConfig,
  peekVaultVersion,
  resolveConfigPath,
} from "../config/loader";
import { resolveAgentSyncHome } from "../config/paths";
import type { AgentSyncConfig } from "../config/schema";
import { nonBlank } from "../lib/env";

/** Runtime paths and machine identity resolved from the local environment. */
export interface RuntimeContext {
  vaultDir: string;
  privateKeyPath: string;
  machineName: string;
  machineFilePath: string;
}

/** A machine name that cannot safely become a vault namespace directory. */
export class InvalidMachineNameError extends Error {
  constructor(
    readonly provided: string,
    readonly reason: string,
  ) {
    super(
      `Invalid machine name ${JSON.stringify(provided)}: ${reason}. ` +
        "Set a valid name via AGENTSYNC_MACHINE, or fix the pinned name in the machine file.",
    );
    this.name = "InvalidMachineNameError";
  }
}

/**
 * Reject names that cannot safely become a directory segment. In vault format
 * v2 the machine name is the namespace directory under `machines/`, and a vault
 * pinned on one OS is cloned and walked on another, so the name must be a legal
 * path segment on EVERY platform. Beyond the POSIX checks shared with
 * validateSkillName / validatePluginName (separators, control chars, dot
 * names), this rejects the Windows-illegal set so a name pinned on Unix cannot
 * break — or, via the NTFS `name:stream` syntax, mis-target — a Windows
 * checkout. Fail loudly rather than pinning or using a bad name.
 */
export function validateMachineName(name: string): void {
  if (name.length === 0) throw new InvalidMachineNameError(name, "empty");
  if (name === "." || name === "..") throw new InvalidMachineNameError(name, "reserved name");
  if (name.startsWith(".")) {
    throw new InvalidMachineNameError(name, "leading dot is reserved for hidden entries");
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20) throw new InvalidMachineNameError(name, "contains control character");
    if (code === 0x2f || code === 0x5c) {
      throw new InvalidMachineNameError(name, "contains path separator");
    }
  }
  // Cross-OS path-segment safety: the vault is created on one platform and
  // checked out on another, so reject names that are illegal directory
  // segments on Windows even when the current host is Unix.
  if (/[:*?"<>|]/.test(name)) {
    throw new InvalidMachineNameError(name, "contains a Windows-reserved character");
  }
  if (name.endsWith(".") || name.endsWith(" ")) {
    throw new InvalidMachineNameError(name, "trailing dot or space is not a valid directory name");
  }
  const stem = (name.split(".")[0] ?? "").toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    throw new InvalidMachineNameError(name, "Windows-reserved device name");
  }
}

/** Read the pinned machine name, treating a missing or blank file as absent. */
async function readPinnedMachineName(path: string): Promise<string | undefined> {
  try {
    return nonBlank(await readFile(path, "utf8"));
  } catch (err) {
    if (isFileNotFoundError(err)) return undefined;
    throw err;
  }
}

/**
 * Resolve the working directories and machine label that all commands share.
 * The machine name prefers the pinned file so a hostname change after init
 * cannot silently orphan a machine's vault namespace; the env chain is only the
 * first-run fallback. The resolved name is validated because v2 turns it into a
 * directory segment. This resolver is read-only — `init` owns pinning the file.
 */
export async function resolveRuntimeContext(): Promise<RuntimeContext> {
  const baseDir = resolveAgentSyncHome();
  await mkdir(baseDir, { recursive: true });

  const privateKeyPath = nonBlank(process.env.AGENTSYNC_KEY_PATH) ?? join(baseDir, "key.txt");
  // Defaults to dirname(privateKeyPath)/machine (a sibling of key.txt); in the
  // default layout both resolve under baseDir, so the pin lands at
  // <AGENTSYNC_DIR>/machine. Follows AGENTSYNC_KEY_PATH so a sandboxed key path
  // keeps the pin isolated. AGENTSYNC_MACHINE_FILE is the per-machine test seam.
  const machineFilePath =
    nonBlank(process.env.AGENTSYNC_MACHINE_FILE) ?? join(dirname(privateKeyPath), "machine");

  const machineName =
    (await readPinnedMachineName(machineFilePath)) ??
    nonBlank(process.env.AGENTSYNC_MACHINE) ??
    nonBlank(process.env.HOSTNAME) ??
    nonBlank(hostname()) ??
    "local-machine";
  validateMachineName(machineName);

  return {
    vaultDir: nonBlank(process.env.AGENTSYNC_VAULT_DIR) ?? join(baseDir, "vault"),
    privateKeyPath,
    machineName,
    machineFilePath,
  };
}

/**
 * Persist the resolved machine name once so the namespace is stable across
 * hostname changes. No-op on a later run that observes an existing pin. Returns
 * true when it wrote. Called by `init`.
 */
export async function pinMachineNameIfAbsent(path: string, name: string): Promise<boolean> {
  if ((await readPinnedMachineName(path)) !== undefined) return false;
  validateMachineName(name);
  // The pin can sit outside the key dir (AGENTSYNC_MACHINE_FILE), so ensure its
  // parent exists rather than assuming a prior key write created it.
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${name}\n`, { mode: 0o600 });
  return true;
}

/** Read the local age identity and trim trailing newlines before use. */
export async function loadPrivateKey(path: string): Promise<string> {
  const key = await readFile(path, "utf8");
  return key.trim();
}

/**
 * Load the vault config. A missing file prints the friendly "vault not
 * initialized" hint and exits 1. Schema (Zod) and TOML syntax errors are
 * re-thrown with a single-line diagnostic message (via formatConfigError)
 * instead of the raw Zod/Toml stack trace, so the error stays catchable:
 * performPull/performPush and the daemon fold it into their errors[] /
 * retry logic, and anything that reaches the CLI top level shows the
 * one-line message rather than a multi-line blob. Only ENOENT exits here,
 * preserving the contract those callers depend on.
 */
export async function loadVaultConfigOrExit(vaultDir: string): Promise<AgentSyncConfig> {
  const configPath = resolveConfigPath(vaultDir);

  // Two-phase load: probe the raw version before the v2 schema runs so a v1
  // vault routes to `vault upgrade` instead of failing with an opaque Zod type
  // error, and a newer format tells the user to upgrade agentsync.
  try {
    const probe = await peekVaultVersion(configPath);
    if (probe.kind === "absent") {
      log.error(
        `Vault not initialized at ${vaultDir}. Run \`agentsync init --remote <git-url>\` first.`,
      );
      process.exit(1);
    }
    if (probe.kind === "v1") {
      log.error(
        `Vault at ${vaultDir} uses the old flat layout. Run \`agentsync vault upgrade\` to migrate it to the per-machine format.`,
      );
      process.exit(1);
    }
    if (probe.kind === "unsupported") {
      log.error(
        `Vault at ${vaultDir} uses format v${probe.version}, newer than this agentsync. Run \`agentsync upgrade\` to update agentsync first.`,
      );
      process.exit(1);
    }
  } catch (err) {
    // Malformed TOML surfaces here (peek parses too); format it the same way.
    if (isConfigParseError(err)) {
      throw new Error(formatConfigError(err, configPath));
    }
    throw err;
  }

  try {
    return await loadConfig(configPath);
  } catch (err) {
    if (isConfigParseError(err)) {
      throw new Error(formatConfigError(err, configPath));
    }
    throw err;
  }
}

export function isFileNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
