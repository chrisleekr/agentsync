import { describe, expect, test } from "bun:test";
import { InvalidPluginNameError, validatePluginName } from "../plugins";

describe("validatePluginName", () => {
  test("accepts a typical plugin or marketplace name", () => {
    expect(() => validatePluginName("my-plugin")).not.toThrow();
    expect(() => validatePluginName("acme.toolkit")).not.toThrow();
    expect(() => validatePluginName("claude-plugins-official")).not.toThrow();
  });

  test("rejects empty, dot, dot-dot, leading-dot, leading-dash, separators, and control chars", () => {
    // Leading dash matters: the name becomes a positional argv token to the
    // `claude` CLI and `-x` would be parsed as a flag.
    const bad = ["", ".", "..", ".hidden", "-flag", "a/b", "a\\b", "ctrl\x00name"];
    for (const name of bad) {
      expect(() => validatePluginName(name)).toThrow(InvalidPluginNameError);
    }
  });
});
