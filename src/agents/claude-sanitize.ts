/**
 * src/agents/claude-sanitize.ts
 *
 * Claude-specific sanitizers. Moved out of `src/core/sanitizer.ts` because
 * no other adapter consumes them — `core/` should hold cross-cutting
 * primitives (`shouldNeverSync`, `redactSecretLiterals`, `scanForSecrets`,
 * `sanitizeAndNormalizeJson`), not adapter-shaped helpers.
 *
 * Two flavours live here:
 *   - `sanitizeClaudeHooks` / `sanitizeClaudeMcp` filter to one allow-listed
 *     top-level key before redacting (we don't sync the rest of settings.json
 *     or .claude.json — only the curated subset).
 *   - `sanitizeClaudePluginManifest` / `sanitizeClaudePluginMcp` preserve the
 *     full shape because plugin metadata is plugin-owned, not user config.
 */

import { homedir } from "node:os";
import { normalizeForVault } from "../core/path-portability";
import { type RedactionResult, redactSecretLiterals } from "../core/sanitizer";

/**
 * Keep only Claude hook settings and redact any embedded literal secrets.
 * HOME-rooted string values are rewritten to the AGENTSYNC_HOME placeholder so
 * the vault round-trips across machines with different home directories.
 * Pass `home: ""` to disable normalization in tests.
 */
export function sanitizeClaudeHooks(
  rawSettingsJson: string,
  home: string = homedir(),
): RedactionResult<string> {
  const parsed = JSON.parse(rawSettingsJson) as Record<string, unknown>;
  const hooksOnly = { hooks: parsed.hooks ?? {} };
  const normalized = normalizeForVault(hooksOnly, home);
  const redacted = redactSecretLiterals(normalized, "hooks");
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
): RedactionResult<string> {
  const parsed = JSON.parse(rawClaudeJson) as Record<string, unknown>;
  const mcpOnly = { mcpServers: parsed.mcpServers ?? {} };
  const normalized = normalizeForVault(mcpOnly, home);
  const redacted = redactSecretLiterals(normalized, "mcpServers");
  return {
    value: `${JSON.stringify(redacted.value, null, 2)}\n`,
    warnings: redacted.warnings,
  };
}

/**
 * Sanitize a Claude Code plugin manifest (`.claude-plugin/plugin.json`).
 *
 * Unlike {@link sanitizeClaudeHooks} / {@link sanitizeClaudeMcp} — which
 * discard everything outside one allow-listed key — plugin manifests need
 * their full metadata preserved (name, version, description, author,
 * command/agent/hook lists, etc.) so that the apply side can restore an
 * equivalent manifest. The only transformation is `redactSecretLiterals`
 * over the entire object, which replaces obvious credential strings with
 * the standard placeholder while leaving structural fields untouched.
 */
export function sanitizeClaudePluginManifest(
  rawJson: string,
  home: string = homedir(),
): RedactionResult<string> {
  const parsed = JSON.parse(rawJson) as unknown;
  const normalized = normalizeForVault(parsed, home);
  const redacted = redactSecretLiterals(normalized, "plugin");
  return {
    value: `${JSON.stringify(redacted.value, null, 2)}\n`,
    warnings: redacted.warnings,
  };
}

/**
 * Sanitize a plugin-scoped `.mcp.json`. Mirrors {@link sanitizeClaudeMcp} but
 * preserves the file's full top-level shape because plugin MCP files do not
 * follow the user-level `.claude.json` schema — they are a bare server
 * descriptor that the plugin owner controls. Literal secret redaction still
 * runs over every value.
 */
export function sanitizeClaudePluginMcp(
  rawJson: string,
  home: string = homedir(),
): RedactionResult<string> {
  const parsed = JSON.parse(rawJson) as unknown;
  const normalized = normalizeForVault(parsed, home);
  const redacted = redactSecretLiterals(normalized, "pluginMcp");
  return {
    value: `${JSON.stringify(redacted.value, null, 2)}\n`,
    warnings: redacted.warnings,
  };
}
