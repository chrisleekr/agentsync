import { afterEach, describe, expect, test } from "bun:test";
import { __setPullAgentsForTesting, performPull } from "../pull";

describe("performPull", () => {
  afterEach(() => {
    __setPullAgentsForTesting(null);
  });

  test("accepts force option and returns valid result shape", async () => {
    // performPull catches errors internally (never throws) and returns a result object.
    // This test verifies:
    //   1. TypeScript accepts { force: true } in the options (compile-time contract)
    //   2. The function returns the expected result shape regardless of vault state
    // The actual force→reconcileWithRemote behaviour is covered by git.test.ts.
    const result = await performPull({ force: true, dryRun: true });

    expect(result).toHaveProperty("applied");
    expect(result).toHaveProperty("errors");
    expect(result).toHaveProperty("fatal");
    expect(typeof result.applied).toBe("number");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.fatal).toBe("boolean");
  });
});
