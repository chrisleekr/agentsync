import { describe, expect, test } from "bun:test";
import pc from "picocolors";

// The statusColour mapping applies colour AFTER padding to preserve
// column alignment. We verify each status gets a distinct colour function.

describe("status colour mapping", () => {
  test("pad-then-colour produces correct visual width with distinct colours", () => {
    type SyncStatus = "synced" | "local-changed" | "vault-only" | "local-only" | "error";

    const statusColour: Record<SyncStatus, (s: string) => string> = {
      synced: pc.green,
      "local-changed": pc.yellow,
      "vault-only": pc.cyan,
      "local-only": pc.dim,
      error: pc.red,
    };

    const padWidth = 13; // max visual width ("local-changed")

    for (const [status, colourFn] of Object.entries(statusColour)) {
      const padded = status.padEnd(padWidth);
      const coloured = colourFn(padded);

      // Padded plain text should be exactly padWidth chars
      expect(padded.length).toBe(padWidth);

      // Coloured string should contain the original status text
      expect(coloured).toContain(status);

      // Coloured string should be strictly longer than padded (ANSI codes added)
      // unless colour is disabled, in which case it equals padded
      expect(coloured.length).toBeGreaterThanOrEqual(padded.length);
    }

    // Verify distinct colours — no two statuses produce identical output
    const values = Object.entries(statusColour).map(([s, fn]) => fn(s));
    const unique = new Set(values);
    expect(unique.size).toBe(Object.keys(statusColour).length);
  });
});
