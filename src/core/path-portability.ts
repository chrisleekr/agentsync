/**
 * Cross-machine path portability for JSON/TOML values stored in the vault.
 *
 * Adapters call `normalizeForVault` at snapshot and `denormalizeFromVault`
 * at apply. A home-prefixed string is only rewritten when followed by `/`
 * or end-of-string, so substrings inside a larger identifier are left
 * alone. The vendor-prefixed placeholder avoids collision with shell
 * expansion any agent runtime might attempt on its own.
 */

export const AGENTSYNC_HOME_PLACEHOLDER = "${AGENTSYNC_HOME}";

/** Escape a string for inclusion inside a RegExp body. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the ordered set of patterns we treat as a home-prefix. Each pattern
 * is anchored by a no-preceding-identifier-char lookbehind and a trailing
 * `(?=[\\/]|$)` so partial matches inside a larger identifier never fire.
 * The separator class accepts both `/` and `\` so a Windows home prefix
 * like `C:\Users\alice\.claude` is recognised the same way as the Unix form.
 */
function homePatterns(home: string): RegExp[] {
  // Trim a trailing separator so the lookahead works whether the caller
  // passes "/Users/x", "/Users/x/", "C:\\Users\\x" or "C:\\Users\\x\\".
  const trimmed = home.replace(/[\\/]+$/, "");
  const escapedHome = escapeRegExp(trimmed);
  return [
    /(?<![A-Za-z0-9_])\$\{HOME\}(?=[\\/]|$)/g,
    /(?<![A-Za-z0-9_])\$HOME(?=[\\/]|$)/g,
    /(?<![A-Za-z0-9_~])~(?=[\\/]|$)/g,
    new RegExp(`(?<![A-Za-z0-9_])${escapedHome}(?=[\\\\/]|$)`, "g"),
  ];
}

/** Rewrite every recognizable home prefix in `input` to the placeholder. */
export function normalizeStringForVault(input: string, home: string): string {
  if (input.length === 0 || home.length === 0) {
    return input;
  }
  let out = input;
  for (const pattern of homePatterns(home)) {
    out = out.replace(pattern, AGENTSYNC_HOME_PLACEHOLDER);
  }
  return out;
}

/**
 * Re-expand the placeholder back to the current machine's home directory.
 *
 * The tail after the placeholder is opaque text and is left untouched. We
 * deliberately do not rewrite `/` into `\` (or vice versa) on the target
 * host, because that tail may contain URLs, regex flags, glob patterns,
 * or other non-path strings that legitimately use one separator. Windows
 * path APIs accept `/` in absolute paths, so a Unix-authored
 * `${AGENTSYNC_HOME}/foo` re-expanded on a Windows host yields a working
 * `C:\Users\alice/foo` without corrupting non-path neighbours.
 */
export function denormalizeStringFromVault(input: string, home: string): string {
  if (home.length === 0) {
    throw new Error("denormalizeStringFromVault requires a non-empty home");
  }
  if (input.length === 0) {
    return input;
  }
  // Replacement-as-function form bypasses `$&`, `$$`, `$1` pattern
  // interpretation, which `replaceAll(str, str)` performs. A home path
  // containing a literal `$` would otherwise corrupt the output.
  return input.replaceAll(AGENTSYNC_HOME_PLACEHOLDER, () => home);
}

/**
 * Recursively walk a JSON-like value and apply `transform` to every string.
 * Returns the same reference when nothing changes so callers can cheaply
 * detect no-op transforms.
 */
function walk(value: unknown, transform: (s: string) => string): unknown {
  if (typeof value === "string") {
    return transform(value);
  }
  if (Array.isArray(value)) {
    let mutated = false;
    const out = value.map((item) => {
      const next = walk(item, transform);
      if (next !== item) {
        mutated = true;
      }
      return next;
    });
    return mutated ? out : value;
  }
  if (value !== null && typeof value === "object") {
    let mutated = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = walk(item, transform);
      if (next !== item) {
        mutated = true;
      }
      out[key] = next;
    }
    return mutated ? out : value;
  }
  return value;
}

/** Normalize every home-prefixed string inside a JSON-like value. */
export function normalizeForVault(value: unknown, home: string): unknown {
  if (home.length === 0) {
    return value;
  }
  return walk(value, (s) => normalizeStringForVault(s, home));
}

/** Denormalize every placeholder back to the current machine's home. */
export function denormalizeFromVault(value: unknown, home: string): unknown {
  if (home.length === 0) {
    throw new Error("denormalizeFromVault requires a non-empty home");
  }
  return walk(value, (s) => denormalizeStringFromVault(s, home));
}
