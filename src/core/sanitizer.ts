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

// The generic base64 whole-value catch-all. Broad by nature, so it is the one
// redaction pattern gated behind `redactBase64Values`: a config can disable it
// when it legitimately stores long base64 values that must round-trip
// unchanged. Pulled out as a named const so it can be filtered out by policy.
const BASE64_VALUE_PATTERN = /^[A-Za-z0-9+/]{40,}={0,2}$/;

// Anchored patterns: used by `redactSecretLiterals` to replace an entire JSON
// string value with the redaction placeholder. The generic base64 catch-all
// only belongs here, since unanchored it would false-positive on long
// alphanumeric runs in prose.
const WHOLE_VALUE_SECRET_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/,
  /^ghp_[a-zA-Z0-9]{36}$/,
  /^xoxb-[0-9]+-[a-zA-Z0-9]+$/,
  // AgentSync's own vault identity. Bech32 HRP "AGE-SECRET-KEY-", separator
  // "1", uppercased, so the body is a strict subset of [A-Z0-9]. A native
  // X25519 key is a fixed 32 bytes, which bech32-encodes to exactly 58 chars,
  // so we bound to the exact length like the other fixed-size patterns. The
  // hyphens in the prefix mean the base64 catch-all below can never match it,
  // so this anchored entry is required to redact a key pasted as a JSON value.
  /^AGE-SECRET-KEY-1[A-Z0-9]{58}$/,
  BASE64_VALUE_PATTERN,
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
  // The vault's own age identity decrypts every artifact AgentSync has ever
  // stored, retroactively and irreversibly once committed to git history. A
  // native X25519 key bech32-encodes to a fixed 58-char body; the 16-char
  // prefix makes false positives on prose effectively impossible.
  { name: "age-secret-key", pattern: /AGE-SECRET-KEY-1[A-Z0-9]{58}/ },
  // A PEM private-key header is never legitimate in synced agent config, and
  // the fixed banner makes a false positive on prose impossible — so it is
  // scanned in every mode, not gated behind `strict`.
  { name: "private-key-pem", pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
];

// The catastrophic tier: patterns that block a push in EVERY mode — including
// `off` — because they are never legitimate agent config and cannot be made
// safe by encryption. The age secret key is the master key to the very vault
// being written, so committing it (even encrypted to recipients) hands every
// future reader the means to decrypt everything. A PEM private key is the same
// class. Every other pattern is "ordinary" (an API token) whose handling the
// `secretScan` mode chooses. Derived from EMBEDDED_SECRET_PATTERNS by name so
// the pattern bodies stay defined in exactly one place.
const ALWAYS_BLOCK_NAMES: ReadonlySet<string> = new Set(["age-secret-key", "private-key-pem"]);
export const ALWAYS_BLOCK_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> =
  EMBEDDED_SECRET_PATTERNS.filter((p) => ALWAYS_BLOCK_NAMES.has(p.name));

// Additional patterns scanned only in `strict` mode. A JWT legitimately appears
// in API examples and docs, so its higher false-positive rate is opt-in rather
// than aborting every push that mentions one.
export const STRICT_SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  {
    name: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
];

/** Secret-handling policy resolved from the vault's [security] config section. */
export interface SecretPolicy {
  /**
   * `standard` (built-in patterns), `strict` (+ JWT), or `off` (waive the
   * ordinary API-token patterns). The catastrophic tier (age key, PEM) blocks
   * in every mode, `off` included.
   */
  mode: "standard" | "strict" | "off";
  /** Literal values exempt from both detection and redaction. */
  allow: readonly string[];
  /** When false, the generic base64 whole-value redaction is skipped. */
  redactBase64: boolean;
}

/**
 * The behaviour when no [security] config is supplied: the historical default.
 * Frozen so the shared instance can never be mutated (e.g. a stray push to
 * `allow`) and contaminate every other caller in a long-lived daemon process.
 */
export const DEFAULT_SECRET_POLICY: SecretPolicy = Object.freeze({
  mode: "standard",
  allow: Object.freeze([]) as readonly string[],
  redactBase64: true,
});

/** Resolve a {@link SecretPolicy} from the optional [security] config section. */
export function securityToPolicy(security?: {
  secretScan?: "standard" | "strict" | "off";
  allowSecretValues?: readonly string[];
  redactBase64Values?: boolean;
}): SecretPolicy {
  if (!security) return DEFAULT_SECRET_POLICY;
  return {
    mode: security.secretScan ?? "standard",
    allow: security.allowSecretValues ?? [],
    redactBase64: security.redactBase64Values ?? true,
  };
}

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

function looksLikeSecretLiteral(value: string, policy: SecretPolicy): boolean {
  if (policy.allow.includes(value)) return false;
  const patterns = policy.redactBase64
    ? WHOLE_VALUE_SECRET_PATTERNS
    : WHOLE_VALUE_SECRET_PATTERNS.filter((pattern) => pattern !== BASE64_VALUE_PATTERN);
  return patterns.some((pattern) => pattern.test(value));
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
 *
 * `off` does NOT mean "scan nothing": the catastrophic tier
 * ({@link ALWAYS_BLOCK_PATTERNS} — age secret key, PEM private key) is scanned
 * in every mode. `off` only waives the ordinary API-token patterns, accepting
 * that those values ride into the vault protected by encryption alone.
 */
export function scanForSecrets(
  text: string,
  sourcePath: string,
  policy: SecretPolicy = DEFAULT_SECRET_POLICY,
): string[] {
  const patterns =
    policy.mode === "off"
      ? ALWAYS_BLOCK_PATTERNS
      : policy.mode === "strict"
        ? [...EMBEDDED_SECRET_PATTERNS, ...STRICT_SECRET_PATTERNS]
        : EMBEDDED_SECRET_PATTERNS;
  const warnings: string[] = [];
  for (const { name, pattern } of patterns) {
    // Catastrophic-tier hits (age secret key, PEM private key) are NEVER
    // exemptible: an `allowSecretValues` entry must not be able to silence the
    // key that decrypts the entire vault, or the always-block guarantee becomes
    // a suggestion. Only ordinary patterns honour the allow-list.
    const catastrophic = ALWAYS_BLOCK_NAMES.has(name);
    // Iterate EVERY occurrence (a global clone of the pattern) and exempt only
    // the exact allow-listed literals. A non-global `match` would return just
    // the FIRST occurrence, so an allow-listed decoy earlier in the text could
    // mask a real secret of the same shape later — a fail-open leak.
    const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
    for (const m of text.matchAll(global)) {
      if (catastrophic || !policy.allow.includes(m[0])) {
        warnings.push(`Detected literal secret (${name}) in ${sourcePath}`);
        break; // one warning per pattern is enough to abort the push
      }
    }
  }
  return warnings;
}

/** Recursively replace literal-looking secrets while preserving surrounding structure. */
export function redactSecretLiterals(
  input: unknown,
  fieldName = "value",
  policy: SecretPolicy = DEFAULT_SECRET_POLICY,
): RedactionResult<unknown> {
  // `off` disables redaction entirely — the input is returned unchanged and BY
  // REFERENCE (no clone). Every in-repo caller re-serialises the result, so the
  // alias never escapes; a future caller that mutates `.value` must clone first.
  if (policy.mode === "off") {
    return { value: input, warnings: [] };
  }

  if (typeof input === "string") {
    if (looksLikeSecretLiteral(input, policy)) {
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
      const nested = redactSecretLiterals(item, `${fieldName}_${index}`, policy);
      warnings.push(...nested.warnings);
      return nested.value;
    });
    return { value, warnings };
  }

  if (input && typeof input === "object") {
    const warnings: string[] = [];
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      const nested = redactSecretLiterals(value, key, policy);
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
  policy: SecretPolicy = DEFAULT_SECRET_POLICY,
): RedactionResult<string> {
  const parsed: unknown = JSON.parse(raw);
  const normalized = normalizeForVault(parsed, home);
  const redacted = redactSecretLiterals(normalized, fieldName, policy);
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
