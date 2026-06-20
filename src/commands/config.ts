import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { formatConfigError, loadConfig, resolveConfigPath, writeConfig } from "../config/loader";
import { AgentSyncConfigSchema } from "../config/schema";
import { GitClient } from "../core/git";
import { scanForSecrets } from "../core/sanitizer";
import { loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

// Sections a user may change through `config set`. `version`, `recipients`, and
// `remote` are deliberately excluded: version is the format guard, recipients
// are managed by `key add`/`key remove`, and changing the remote is `init`'s
// job. Everything settable lives under one of these object sections.
const SETTABLE_PREFIXES = ["agents.", "sync.", "claudePlugins.", "security."] as const;

// The one settable key whose values are deliberately secret-shaped: it is the
// allowlist of literals to exempt from the secret scan, so scanning it would
// defeat its purpose.
const SECRET_EXEMPT_KEY = "security.allowSecretValues";

type Json = Record<string, unknown>;

/**
 * Read a dotted path (`a.b.c`) from a nested object; undefined when any segment
 * is missing. Uses own-property checks only (never the `in` operator) so an
 * inherited name like `constructor` or `__proto__` reads as absent — that is
 * what makes a prototype-walk key (`security.__proto__.x`) fail the
 * existence guard in `performConfigSet` instead of reaching `setByPath`.
 */
function getByPath(obj: Json, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && Object.hasOwn(acc as object, key)) {
      return (acc as Json)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Set a dotted path on a nested object, creating intermediate objects as needed.
 * Every assignment is preceded by an inline literal guard against the three
 * prototype-polluting segment names — assigning through `__proto__`,
 * `constructor`, or `prototype` would reach `Object.prototype` and corrupt
 * every object in the process (CWE-1321).
 */
function setByPath(obj: Json, path: string, value: unknown): void {
  const keys = path.split(".");
  let cursor = obj;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i] as string;
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`Refusing to set unsafe config key segment '${key}'`);
    }
    if (i === keys.length - 1) {
      cursor[key] = value;
      return;
    }
    if (!Object.hasOwn(cursor, key) || typeof cursor[key] !== "object" || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Json;
  }
}

/** Flatten a config object to dotted `key`→`value` leaf pairs (arrays kept whole). */
function flatten(obj: Json, prefix = ""): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(obj)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flatten(value as Json, dotted));
    } else {
      out.push([dotted, value]);
    }
  }
  return out;
}

/**
 * Coerce a raw CLI string to a typed value. JSON.parse handles numbers,
 * booleans, and arrays (`500`, `true`, `["a"]`); a bare word that is not valid
 * JSON (e.g. `strict`) falls through as a plain string. The Zod schema is the
 * real validator — this only picks the right primitive type.
 */
function parseScalar(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** One row for `performConfigList`. */
export interface ConfigEntry {
  key: string;
  value: unknown;
}

/** Result of `performConfigGet`. */
export type ConfigGetResult =
  | { status: "found"; key: string; value: unknown }
  | { status: "unknown-key"; key: string };

/** Result of `performConfigSet`. */
export type ConfigSetResult =
  | { status: "success"; key: string; oldValue: unknown; newValue: unknown }
  | { status: "not-settable"; key: string }
  | { status: "unknown-key"; key: string }
  | { status: "invalid-value"; key: string; error: string }
  | { status: "failed"; error: string };

/** List every config leaf except recipients (use `agentsync key list` for those). */
export async function performConfigList(): Promise<ConfigEntry[]> {
  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);
  return flatten(config as unknown as Json)
    .filter(([key]) => key !== "version" && !key.startsWith("recipients"))
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Read a single dotted config key. Read-only. */
export async function performConfigGet(key: string): Promise<ConfigGetResult> {
  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);
  const value = getByPath(config as unknown as Json, key);
  if (value === undefined) {
    return { status: "unknown-key", key };
  }
  return { status: "found", key, value };
}

/**
 * Change a single dotted config key in the vault. Because `agentsync.toml` is
 * shared across machines, this reconciles fast-forward, validates the mutated
 * config against the full schema (so every constraint — debounce range, enum
 * values, boolean types — is enforced without duplication), then commits and
 * pushes like `key add`.
 */
export async function performConfigSet(key: string, rawValue: string): Promise<ConfigSetResult> {
  if (!SETTABLE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return { status: "not-settable", key };
  }

  const runtime = await resolveRuntimeContext();
  const configPath = resolveConfigPath(runtime.vaultDir);
  const config = await loadVaultConfigOrExit(runtime.vaultDir);

  try {
    const git = new GitClient(runtime.vaultDir);
    const reconciliation = await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      allowMissingRemote: true,
    });
    const refreshed = await loadConfig(configPath);

    // The key must already exist post-load (defaults are materialised), so a
    // typo like `agents.cluade` is rejected here instead of being silently
    // stripped by the schema's unknown-key removal.
    const oldValue = getByPath(refreshed as unknown as Json, key);
    if (oldValue === undefined) {
      return { status: "unknown-key", key };
    }

    // agentsync.toml is committed in PLAINTEXT (only artifacts are encrypted),
    // so refuse to write a literal credential into it — e.g. a token pasted
    // into the wrong field. The allowlist key is exempt by construction.
    if (key !== SECRET_EXEMPT_KEY) {
      const leaks = scanForSecrets(rawValue, key);
      if (leaks.length > 0) {
        return {
          status: "invalid-value",
          key,
          error: `Refusing to store a literal secret in plaintext config (${leaks.join("; ")}).`,
        };
      }
    }

    const next = structuredClone(refreshed);
    setByPath(next as unknown as Json, key, parseScalar(rawValue));

    const validated = AgentSyncConfigSchema.safeParse(next);
    if (!validated.success) {
      return {
        status: "invalid-value",
        key,
        error: formatConfigError(validated.error, configPath),
      };
    }

    await writeConfig(configPath, validated.data);
    await git.addAll();
    const committed = await git.commit({ message: `config: set ${key}` });
    if (committed) {
      await git.push(
        "origin",
        validated.data.remote.branch,
        reconciliation.status === "remote-missing" ? ["--set-upstream"] : [],
      );
    }

    return {
      status: "success",
      key,
      oldValue,
      newValue: getByPath(validated.data as unknown as Json, key),
    };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Render a config value for display: strings as-is, everything else as JSON. */
function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** View or change vault configuration (agents, sync options, security policy). */
export const configCommand = defineCommand({
  meta: {
    name: "config",
    description: "View or change vault configuration (agents, sync, security)",
  },
  subCommands: {
    list: defineCommand({
      meta: { description: "Print every configurable key and its current value" },
      async run() {
        const entries = await performConfigList();
        for (const entry of entries) {
          log.info(`${entry.key} = ${formatValue(entry.value)}`);
        }
        log.info(
          `${entries.length} setting(s). Change one with \`agentsync config set <key> <value>\`.`,
        );
      },
    }),

    get: defineCommand({
      meta: { description: "Print one config value by dotted key (e.g. sync.debounceMs)" },
      args: {
        key: { type: "positional", required: true, description: "Dotted config key" },
      },
      async run({ args }) {
        const result = await performConfigGet(String(args.key));
        if (result.status === "unknown-key") {
          log.error(`Unknown config key: ${result.key}. Run \`agentsync config list\`.`);
          process.exitCode = 1;
          return;
        }
        log.info(`${result.key} = ${formatValue(result.value)}`);
      },
    }),

    set: defineCommand({
      meta: { description: "Change one config value and push it to the vault" },
      args: {
        key: {
          type: "positional",
          required: true,
          description: "Dotted config key (e.g. agents.vscode)",
        },
        value: {
          type: "positional",
          required: true,
          description: "New value (true/false, a number, a word, or JSON)",
        },
      },
      async run({ args }) {
        const result = await performConfigSet(String(args.key), String(args.value));
        switch (result.status) {
          case "success":
            log.success(
              `Set ${result.key} = ${formatValue(result.newValue)} (was ${formatValue(result.oldValue)}).`,
            );
            return;
          case "not-settable":
            log.error(
              `'${result.key}' is not settable here. Settable sections: ${SETTABLE_PREFIXES.map((p) => p.slice(0, -1)).join(", ")}. Use \`key\`/\`init\` for recipients and remote.`,
            );
            process.exitCode = 1;
            return;
          case "unknown-key":
            log.error(`Unknown config key: ${result.key}. Run \`agentsync config list\`.`);
            process.exitCode = 1;
            return;
          case "invalid-value":
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
