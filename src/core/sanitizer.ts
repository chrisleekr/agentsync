import { homedir } from "node:os";
import { basename } from "node:path";
import { normalizeForVault } from "./path-portability";

/** Global path patterns that AgentSync must never copy into the encrypted vault. */
export const NEVER_SYNC_PATTERNS = [
  "**/auth.json",
  "**/.credentials.json",
  "**/history.jsonl",
  "**/sessions/**",
  "**/.claude/statsig/**",
  "**/*.local.md",
  "**/.claude/settings.local.json",
  "**/agentsync.toml",
  "**/*.age",
  // Pull writes ".bak" beside overwritten files. Without this exclusion the
  // next push would carry stale backup copies back into the vault. Editor
  // tilde-suffix temp files are the same risk class.
  "**/*.bak",
  "**/*~",
] as const;

/**
 * Convert a glob pattern (supporting `**` and `*`) into a RegExp.
 * This is the single source of truth that drives `shouldNeverSync()` so that
 * NEVER_SYNC_PATTERNS is the only thing you need to update.
 */
function globToRegex(glob: string): RegExp {
  const g = glob.replaceAll("\\", "/");
  let rx = "";
  let i = 0;
  while (i < g.length) {
    if (g[i] === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        // **/ — zero or more path segments
        rx += "(.*/)?";
        i += 3;
      } else {
        // ** at end of pattern — match anything
        rx += ".*";
        i += 2;
      }
    } else if (g[i] === "*") {
      rx += "[^/]*";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(g[i] as string)) {
      rx += `\\${g[i]}`;
      i++;
    } else {
      rx += g[i];
      i++;
    }
  }
  // Match at string start or after any slash so that **/pattern matches
  // paths with or without a leading directory component.
  return new RegExp(`(^|/)${rx}$`, "i");
}

const NEVER_SYNC_REGEXPS: RegExp[] = NEVER_SYNC_PATTERNS.map((p) => globToRegex(p));

// Anchored patterns: used by `redactSecretLiterals` to replace an entire JSON
// string value with the redaction placeholder. The generic base64 catch-all
// only belongs here, since unanchored it would false-positive on long
// alphanumeric runs in prose.
const WHOLE_VALUE_SECRET_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/,
  /^ghp_[a-zA-Z0-9]{36}$/,
  /^xoxb-[0-9]+-[a-zA-Z0-9]+$/,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
];

// Unanchored, high-precision credential prefixes. Used by `scanForSecrets`
// to detect secrets embedded as substrings inside arbitrary text — markdown
// bodies, prompts, skill READMEs, and sentence-style values inside JSON
// `env` blocks. Every pattern here must be specific enough that a paragraph
// of prose cannot match it; otherwise legitimate pushes start aborting.
//
// Each fixed-length pattern is bounded with the exact real-world key length
// (e.g. AWS access keys are 16 chars). Open-ended `{n,}` quantifiers
// require a high minimum to push the false-positive rate toward zero.
export const EMBEDDED_SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "anthropic-api-key", pattern: /sk-ant-api03-[A-Za-z0-9_-]{40,}/ },
  { name: "openai-project-key", pattern: /sk-proj-[A-Za-z0-9_-]{40,}/ },
  { name: "github-classic-pat", pattern: /ghp_[A-Za-z0-9]{36}/ },
  { name: "github-fine-grained-pat", pattern: /github_pat_[A-Za-z0-9_]{80,}/ },
  { name: "gitlab-pat", pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "slack-token", pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
];

export interface RedactionResult<T> {
  value: T;
  warnings: string[];
}

/**
 * Returns true when a file path matches any entry in NEVER_SYNC_PATTERNS.
 * NEVER_SYNC_PATTERNS is the authoritative list — add new patterns there and
 * this function picks them up automatically.
 */
export function shouldNeverSync(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return NEVER_SYNC_REGEXPS.some((re) => re.test(normalized));
}

function looksLikeSecretLiteral(value: string): boolean {
  return WHOLE_VALUE_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Scan arbitrary text for secrets embedded as substrings. Returns warnings
 * prefixed `Detected literal secret` so the Phase-1 abort in
 * `commands/push.ts` fires on any hit. Empty array means clean.
 *
 * This is the defense-in-depth chokepoint that catches credentials in
 * markdown bodies and prose-style JSON values — neither of which goes
 * through `redactSecretLiterals` (it only walks structured JSON values).
 *
 * The prefix is a contract marker, not a description: the scan only
 * detects, the push aborts, the user removes the secret. Nothing is
 * actually redacted in this path.
 */
export function scanForSecrets(text: string, sourcePath: string): string[] {
  const warnings: string[] = [];
  for (const { name, pattern } of EMBEDDED_SECRET_PATTERNS) {
    if (pattern.test(text)) {
      warnings.push(`Detected literal secret (${name}) in ${sourcePath}`);
    }
  }
  return warnings;
}

/** Recursively replace literal-looking secrets while preserving surrounding structure. */
export function redactSecretLiterals(
  input: unknown,
  fieldName = "value",
): RedactionResult<unknown> {
  if (typeof input === "string") {
    if (looksLikeSecretLiteral(input)) {
      return {
        value: `$AGENTSYNC_REDACTED_${fieldName.toUpperCase()}`,
        warnings: [`Detected literal secret for field ${fieldName}`],
      };
    }
    return { value: input, warnings: [] };
  }

  if (Array.isArray(input)) {
    const warnings: string[] = [];
    const value = input.map((item, index) => {
      const nested = redactSecretLiterals(item, `${fieldName}_${index}`);
      warnings.push(...nested.warnings);
      return nested.value;
    });
    return { value, warnings };
  }

  if (input && typeof input === "object") {
    const warnings: string[] = [];
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      const nested = redactSecretLiterals(value, key);
      warnings.push(...nested.warnings);
      result[key] = nested.value;
    }

    return { value: result, warnings };
  }

  return { value: input, warnings: [] };
}

/**
 * Parse JSON, rewrite home-prefixed paths to the vault placeholder, and redact
 * secret-looking literals. Returns the serialized result with collected warnings.
 * Used by every adapter that snapshots a JSON config file the same way.
 */
export function sanitizeAndNormalizeJson(
  raw: string,
  fieldName: string,
  home: string = homedir(),
): RedactionResult<string> {
  const parsed = JSON.parse(raw);
  const normalized = normalizeForVault(parsed, home);
  const redacted = redactSecretLiterals(normalized, fieldName);
  return {
    value: `${JSON.stringify(redacted.value, null, 2)}\n`,
    warnings: redacted.warnings,
  };
}

/** Derive a stable redaction placeholder name from the original file name. */
export function redactionEnvNameForPath(path: string): string {
  const file = basename(path).replace(/[^a-zA-Z0-9]+/g, "_");
  return `AGENTSYNC_REDACTED_${file.toUpperCase()}`;
}
