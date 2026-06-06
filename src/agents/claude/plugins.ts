/**
 * src/agents/claude/plugins.ts
 *
 * Name validator for Claude Code plugins and marketplaces. The plugin tree is
 * no longer snapshotted (it became a reinstall manifest, see plugin-manifest.ts),
 * but the validator survives: plugin and marketplace names read back from the
 * vault become arguments to `claude plugin install` / `marketplace add`, so a
 * `..`, leading-dot, separator, or control-char name must be rejected before it
 * reaches the shell-out.
 */

/**
 * Thrown by {@link validatePluginName} when a name fails the allow-list. A
 * dedicated subclass lets callers catch this specific failure mode and skip the
 * adversarial entry without swallowing unrelated errors.
 */
export class InvalidPluginNameError extends Error {
  constructor(
    public readonly provided: string,
    public readonly reason: string,
  ) {
    super(`Invalid Claude plugin name '${provided}': ${reason}`);
    this.name = "InvalidPluginNameError";
  }
}

/**
 * Validate a plugin or marketplace name. Symmetric to `validateSkillName` in
 * skills-walker.ts — closes the same traversal / argument-injection class. A
 * name literally `..` would otherwise resolve to the agent config root or be
 * misread as a flag by the `claude` CLI.
 */
export function validatePluginName(name: string): void {
  if (name.length === 0) {
    throw new InvalidPluginNameError(name, "empty");
  }
  if (name === "." || name === "..") {
    throw new InvalidPluginNameError(name, "reserved name");
  }
  if (name.startsWith(".")) {
    throw new InvalidPluginNameError(name, "leading dot is reserved for hidden entries");
  }
  if (name.startsWith("-")) {
    // The name becomes a positional argv token to the `claude` CLI; a leading
    // dash would be parsed as a flag.
    throw new InvalidPluginNameError(name, "leading dash could be parsed as a CLI flag");
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20) {
      throw new InvalidPluginNameError(name, "contains control character");
    }
    if (code === 0x2f || code === 0x5c) {
      throw new InvalidPluginNameError(name, "contains path separator");
    }
  }
}
