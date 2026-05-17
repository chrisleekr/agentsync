import { describe, expect, test } from "bun:test";
import { nonBlank } from "../env";

describe("nonBlank", () => {
  test("returns undefined for undefined", () => {
    expect(nonBlank(undefined)).toBeUndefined();
  });

  test("returns undefined for an empty string", () => {
    expect(nonBlank("")).toBeUndefined();
  });

  test("returns undefined for a whitespace-only string", () => {
    expect(nonBlank("   ")).toBeUndefined();
    expect(nonBlank("\t")).toBeUndefined();
    expect(nonBlank("\n")).toBeUndefined();
  });

  test("returns a non-blank value unchanged", () => {
    expect(nonBlank("value")).toBe("value");
  });

  test("trims surrounding whitespace from a non-blank value", () => {
    expect(nonBlank("  value  ")).toBe("value");
  });

  test("preserves internal whitespace", () => {
    expect(nonBlank("  a b  ")).toBe("a b");
  });

  test("treats '0' as a real value, not a blank", () => {
    // The check is blank-vs-non-blank, not falsy-vs-truthy: "0" is a valid
    // non-empty string and must survive.
    expect(nonBlank("0")).toBe("0");
  });
});
