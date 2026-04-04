import { basename } from "node:path";

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

const SECRET_VALUE_PATTERNS = [
  /^sk-[a-zA-Z0-9]{20,}$/,
  /^ghp_[a-zA-Z0-9]{36}$/,
  /^xoxb-[0-9]+-[a-zA-Z0-9]+$/,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
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
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactSecretLiterals(
  input: unknown,
  fieldName = "value",
): RedactionResult<unknown> {
  if (typeof input === "string") {
    if (looksLikeSecretLiteral(input)) {
      return {
        value: `$AGENTSYNC_REDACTED_${fieldName.toUpperCase()}`,
        warnings: [`Redacted literal secret for field ${fieldName}`],
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

export function sanitizeClaudeHooks(rawSettingsJson: string): RedactionResult<string> {
  const parsed = JSON.parse(rawSettingsJson) as Record<string, unknown>;
  const hooksOnly = { hooks: parsed.hooks ?? {} };
  const redacted = redactSecretLiterals(hooksOnly, "hooks");
  return {
    value: `${JSON.stringify(redacted.value, null, 2)}\n`,
    warnings: redacted.warnings,
  };
}

export function sanitizeClaudeMcp(rawClaudeJson: string): RedactionResult<string> {
  const parsed = JSON.parse(rawClaudeJson) as Record<string, unknown>;
  const mcpOnly = { mcpServers: parsed.mcpServers ?? {} };
  const redacted = redactSecretLiterals(mcpOnly, "mcpServers");
  return {
    value: `${JSON.stringify(redacted.value, null, 2)}\n`,
    warnings: redacted.warnings,
  };
}

export function redactionEnvNameForPath(path: string): string {
  const file = basename(path).replace(/[^a-zA-Z0-9]+/g, "_");
  return `AGENTSYNC_REDACTED_${file.toUpperCase()}`;
}
