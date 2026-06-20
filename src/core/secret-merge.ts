import { REDACTION_PLACEHOLDER_PREFIX } from "./sanitizer";

/**
 * src/core/secret-merge.ts
 *
 * Placeholder-aware merge for the apply (copy) side. `redact` mode ships a
 * `$AGENTSYNC_REDACTED_<FIELD>` placeholder into the vault instead of a real
 * token (see `redactSecretLiterals`). When that placeholder is applied onto a
 * machine that already holds the real secret, a wholesale overwrite would
 * replace the working key with the placeholder and break the local config.
 *
 * `mergePreservingSecrets` overlays `incoming` onto `existing` with one rule:
 * an incoming placeholder never clobbers a real local value. It also keeps
 * local-only keys (copy is additive — a key absent from the vault stays), which
 * incidentally fixes the prior wholesale-replace that dropped local-only MCP
 * servers.
 */

export interface SecretMergeResult {
  /** The merged tree, ready to serialise back to disk. */
  merged: unknown;
  /** Dotted field paths where a placeholder was written because no local value
   *  existed — the destination must still replace these with the real value.
   *  Informational: the apply callers currently ignore it (there is no
   *  apply-side warning channel yet); the placeholder itself is self-documenting
   *  on disk. Kept so a future copy-summary can surface "these need a value". */
  placeholders: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlaceholder(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(REDACTION_PLACEHOLDER_PREFIX);
}

function mergeNode(
  existing: unknown,
  incoming: unknown,
  path: string,
  placeholders: string[],
): unknown {
  // Incoming placeholder: keep a real local value rather than overwrite it. Only
  // fall through to writing the placeholder when there is no local value to
  // preserve (a local placeholder counts as "no value").
  if (isPlaceholder(incoming)) {
    if (existing !== undefined && existing !== null && !isPlaceholder(existing)) {
      return existing;
    }
    placeholders.push(path || "(root)");
    return incoming;
  }

  // Incoming object: deep-merge so nested secrets are preserved per-leaf and
  // local-only keys survive (additive). When the local side is not an object
  // (missing, or a type change) we still walk incoming over an empty base so
  // nested placeholders are recorded — the merged output is just incoming.
  if (isPlainObject(incoming)) {
    const base = isPlainObject(existing) ? existing : {};
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
      // Never assign through a prototype-polluting key from vault content.
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = mergeNode(base[key], value, path ? `${path}.${key}` : key, placeholders);
    }
    return out;
  }

  // Arrays: merge element-wise so a placeholder at index i preserves the local
  // element. The snapshot side redacts inside arrays too (an MCP `args` array
  // can carry a token, e.g. ["--token", "sk-…"]), so without this an incoming
  // placeholder element would clobber the real local value — the exact failure
  // the object branch prevents, one level down.
  if (Array.isArray(incoming)) {
    const base = Array.isArray(existing) ? existing : [];
    return incoming.map((value, i) => mergeNode(base[i], value, `${path}[${i}]`, placeholders));
  }

  // Primitives and type changes: incoming wins (the synced value).
  return incoming;
}

/**
 * Merge `incoming` (from the vault) onto `existing` (local disk), preserving any
 * real local value an incoming redaction placeholder would otherwise overwrite.
 */
export function mergePreservingSecrets(existing: unknown, incoming: unknown): SecretMergeResult {
  const placeholders: string[] = [];
  const merged = mergeNode(existing, incoming, "", placeholders);
  return { merged, placeholders };
}
