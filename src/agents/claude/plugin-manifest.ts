/**
 * src/agents/claude/plugin-manifest.ts
 *
 * Distil Claude Code's on-disk plugin state into a small, portable manifest and
 * read it back. Replaces the old whole-tree encryption: the marketplace is the
 * source of truth, so we persist only what `agentsync plugin install` needs to
 * reinstall — `<name>@<marketplace>`, scope, and the enabled flag — and drop
 * every machine-specific absolute path. Reinstall fetches the latest version;
 * there is no version pin and local edits to plugin files are not preserved.
 *
 * Inputs (upstream: anthropics/claude-code):
 *   ~/.claude/plugins/installed_plugins.json
 *     { plugins: { "<name>@<marketplace>": [{ scope, ... }] },
 *       enabledPlugins: { "<name>@<marketplace>": boolean } }
 *   ~/.claude/plugins/known_marketplaces.json
 *     { "<marketplace>": { source: { source: "github", repo: "owner/repo" }, ... } }
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { validatePluginName } from "./plugins";

/** A marketplace to re-register: its name plus an add-able source token. */
const PluginMarketplaceSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
});

/**
 * A plugin to reinstall: name, owning marketplace, install scope, enabled.
 * `scope` rejects a leading dash so a hostile manifest cannot smuggle a value
 * that `claude plugin install -s <scope>` would misparse as a flag. The known
 * scopes are user/project/local; a non-dash string is allowed for forward-compat.
 */
const PluginRecordSchema = z.object({
  name: z.string().min(1),
  marketplace: z.string().min(1),
  scope: z
    .string()
    .min(1)
    .refine((s) => !s.startsWith("-"), {
      message: "scope must not start with '-' (would be parsed as a CLI flag)",
    }),
  enabled: z.boolean(),
});

export const PluginManifestSchema = z.object({
  marketplaces: z.array(PluginMarketplaceSchema),
  plugins: z.array(PluginRecordSchema),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** Serialize a manifest the same way every other JSON artifact is written. */
export function serializeManifest(manifest: PluginManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Derive the `claude plugin marketplace add <source>` token from a
 * known_marketplaces entry. Only forms the CLI accepts survive: a GitHub
 * `owner/repo`, or an explicit url/path string. Anything else returns null so
 * the caller can warn and skip rather than persist an unusable source.
 */
function marketplaceAddSource(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") return null;
  const source = (entry as { source?: unknown }).source;
  if (typeof source === "string") return source.length > 0 ? source : null;
  if (!source || typeof source !== "object") return null;
  const obj = source as Record<string, unknown>;
  let derived: string | null = null;
  if (obj.source === "github" && typeof obj.repo === "string" && obj.repo.length > 0) {
    derived = obj.repo;
  } else if (typeof obj.url === "string" && obj.url.length > 0) derived = obj.url;
  else if (typeof obj.path === "string" && obj.path.length > 0) derived = obj.path;
  else if (typeof obj.repo === "string" && obj.repo.length > 0) derived = obj.repo;
  // A leading dash would be parsed as a flag by `claude plugin marketplace add`.
  // No legitimate owner/repo, URL, or path starts with one — reject it.
  if (derived === null || derived.startsWith("-")) return null;
  return derived;
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Split a `<name>@<marketplace>` key on its last `@` (marketplaces have none). */
function splitPluginKey(key: string): { name: string; marketplace: string } | null {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
}

/**
 * Build the plugin manifest from a plugins directory. Returns null when
 * `installed_plugins.json` is absent — there is genuinely nothing to back up.
 * Throws only when that file exists but is not valid JSON; the snapshot caller
 * wraps that into a warning and skips, matching the other manifest paths.
 */
export async function buildPluginManifest(
  pluginsDir: string,
): Promise<{ manifest: PluginManifest; warnings: string[] } | null> {
  const installedText = await readTextIfExists(join(pluginsDir, "installed_plugins.json"));
  if (installedText === null) return null;

  const warnings: string[] = [];
  const installed = JSON.parse(installedText) as {
    plugins?: Record<string, unknown>;
    enabledPlugins?: Record<string, unknown>;
  };

  const marketplaces: { name: string; source: string }[] = [];
  const marketplacesText = await readTextIfExists(join(pluginsDir, "known_marketplaces.json"));
  if (marketplacesText !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(marketplacesText);
    } catch {
      warnings.push("[claude] known_marketplaces.json is not valid JSON — skipping marketplaces");
      parsed = null;
    }
    if (parsed && typeof parsed === "object") {
      for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
        try {
          validatePluginName(name);
        } catch {
          warnings.push(`[claude] Skipping marketplace '${name}' — invalid name`);
          continue;
        }
        const source = marketplaceAddSource(entry);
        if (source === null) {
          warnings.push(`[claude] Skipping marketplace '${name}' — unrecognized source shape`);
          continue;
        }
        marketplaces.push({ name, source });
      }
    }
  }

  const enabledMap = (installed.enabledPlugins ?? {}) as Record<string, unknown>;
  const plugins: PluginManifest["plugins"] = [];
  for (const [key, entriesRaw] of Object.entries(installed.plugins ?? {})) {
    const split = splitPluginKey(key);
    if (!split) {
      warnings.push(`[claude] Skipping plugin '${key}' — not in <name>@<marketplace> form`);
      continue;
    }
    try {
      validatePluginName(split.name);
      validatePluginName(split.marketplace);
    } catch {
      warnings.push(`[claude] Skipping plugin '${key}' — invalid name`);
      continue;
    }
    const enabled = enabledMap[key] === true;
    const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
    // One record per distinct scope. installPath / version / timestamps are
    // intentionally dropped — reinstall regenerates them.
    const seenScopes = new Set<string>();
    for (const entry of entries) {
      const scope = readScope(entry);
      if (seenScopes.has(scope)) continue;
      seenScopes.add(scope);
      plugins.push({ name: split.name, marketplace: split.marketplace, scope, enabled });
    }
    if (entries.length === 0) {
      plugins.push({ name: split.name, marketplace: split.marketplace, scope: "user", enabled });
    }
  }

  // No secret scan here: push.ts re-scans every artifact's plaintext at the
  // encryption chokepoint, so scanning the manifest twice only double-reports.
  return { manifest: { marketplaces, plugins }, warnings };
}

/**
 * Read a record's scope. Clamps a missing/non-string or leading-dash value to
 * `user` so a build never emits a manifest its own parser would reject.
 */
function readScope(entry: unknown): string {
  if (entry && typeof entry === "object") {
    const raw = (entry as { scope?: unknown }).scope;
    if (typeof raw === "string" && raw.length > 0 && !raw.startsWith("-")) return raw;
  }
  return "user";
}

/**
 * Parse and validate a manifest read back from the vault. Re-runs
 * {@link validatePluginName} on every name and rejects a leading-dash
 * marketplace source because the values become arguments to `claude plugin
 * install` / `marketplace add` — a `../evil`, control-char, or `--flag` value
 * must never reach the shell-out. (`scope` is already constrained by the enum.)
 */
export function parsePluginManifest(raw: string): PluginManifest {
  const manifest = PluginManifestSchema.parse(JSON.parse(raw));
  for (const m of manifest.marketplaces) {
    validatePluginName(m.name);
    if (m.source.startsWith("-")) {
      throw new Error(`Invalid marketplace source '${m.source}': leading dash could be a CLI flag`);
    }
  }
  for (const p of manifest.plugins) {
    validatePluginName(p.name);
    validatePluginName(p.marketplace);
  }
  return manifest;
}
