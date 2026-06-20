/**
 * src/agents/claude-sanitize.ts
 *
 * Claude-specific sanitizers. Moved out of `src/core/sanitizer.ts` because
 * no other adapter consumes them — `core/` should hold cross-cutting
 * primitives (`shouldNeverSync`, `redactSecretLiterals`, `scanForSecrets`,
 * `sanitizeAndNormalizeJson`), not adapter-shaped helpers.
 *
 * `sanitizeClaudeHooks` / `sanitizeClaudeMcp` filter to one allow-listed
 * top-level key before redacting (we don't sync the rest of settings.json or
 * .claude.json — only the curated subset).
 */

import { homedir } from "node:os";
import { normalizeForVault } from "../../core/path-portability";
import {
  DEFAULT_SECRET_POLICY,
  type RedactionResult,
  redactSecretLiterals,
  type SecretPolicy,
} from "../../core/sanitizer";

/**
 * Keep only Claude hook settings and redact any embedded literal secrets.
 * HOME-rooted string values are rewritten to the AGENTSYNC_HOME placeholder so
 * the vault round-trips across machines with different home directories.
 * Pass `home: ""` to disable normalization in tests.
 */
export function sanitizeClaudeHooks(
  rawSettingsJson: string,
  home: string = homedir(),
  policy: SecretPolicy = DEFAULT_SECRET_POLICY,
): RedactionResult<string> {
  const parsed = JSON.parse(rawSettingsJson) as Record<string, unknown>;
  const hooksOnly = { hooks: parsed.hooks ?? {} };
  const normalized = normalizeForVault(hooksOnly, home);
  const redacted = redactSecretLiterals(normalized, "hooks", policy);
  return {
    value: `${JSON.stringify(redacted.value, null, 2)}\n`,
    warnings: redacted.warnings,
  };
}

/**
 * Keep only Claude MCP settings and redact any embedded literal secrets.
 * Path-portability rules match {@link sanitizeClaudeHooks}.
 */
export function sanitizeClaudeMcp(
  rawClaudeJson: string,
  home: string = homedir(),
  policy: SecretPolicy = DEFAULT_SECRET_POLICY,
): RedactionResult<string> {
  const parsed = JSON.parse(rawClaudeJson) as Record<string, unknown>;
  const mcpOnly = { mcpServers: parsed.mcpServers ?? {} };
  const normalized = normalizeForVault(mcpOnly, home);
  const redacted = redactSecretLiterals(normalized, "mcpServers", policy);
  return {
    value: `${JSON.stringify(redacted.value, null, 2)}\n`,
    warnings: redacted.warnings,
  };
}
