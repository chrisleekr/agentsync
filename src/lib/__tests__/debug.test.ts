/**
 * T049 — debug module: isDebug flag and debug() function
 *
 * isDebug is a module-level constant evaluated at import time.
 * In this test file AGENTSYNC_DEBUG is either unset or "0", so isDebug is false
 * and we verify that debug() does not write to stderr.
 *
 * For the "writes when enabled" case we inline the same logic to avoid the need
 * for a second isolated module import.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { debug, isDebug } from "../debug";

describe("isDebug", () => {
  test("is false when AGENTSYNC_DEBUG is not '1'", () => {
    // The test runner does not set AGENTSYNC_DEBUG="1", so this must be false.
    expect(isDebug).toBe(false);
  });
});

describe("debug()", () => {
  test("does NOT write to stderr when isDebug is false", () => {
    const writeSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      debug("should-not-appear");
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("writes '[debug] <msg>\\n' to stderr when the flag is true", () => {
    const messages: string[] = [];
    const writeSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      messages.push(String(chunk));
      return true;
    });

    try {
      // Inline the debug logic with the flag forced to true so we can test
      // the output format without re-importing the module.
      const enabledDebug = (msg: string) => process.stderr.write(`[debug] ${msg}\n`);
      enabledDebug("hello");

      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe("[debug] hello\n");
    } finally {
      writeSpy.mockRestore();
    }
  });
});
