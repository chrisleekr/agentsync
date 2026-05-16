import { describe, expect, test } from "bun:test";
import { computeDiffOps, sideBySideDiff, unifiedDiff } from "../diff";

describe("unifiedDiff", () => {
  test("identical strings produce empty output", () => {
    expect(unifiedDiff("hello\nworld", "hello\nworld")).toBe("");
    expect(unifiedDiff("", "")).toBe("");
  });

  test("single-line addition", () => {
    const out = unifiedDiff("a\nb", "a\nb\nc");
    expect(out).toContain("+c");
    expect(out).toContain("@@");
  });

  test("single-line removal", () => {
    const out = unifiedDiff("a\nb\nc", "a\nc");
    expect(out).toContain("-b");
  });

  test("single-line change", () => {
    const out = unifiedDiff("a\nb\nc", "a\nB\nc");
    expect(out).toContain("-b");
    expect(out).toContain("+B");
  });

  test("contiguous changes form a single hunk", () => {
    const out = unifiedDiff("a\nb\nc\nd", "a\nx\ny\nd");
    const hunkHeaders = out.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunkHeaders.length).toBe(1);
  });

  test("widely separated changes form multiple hunks", () => {
    const a = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n");
    const b = ["A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "K"].join("\n");
    const out = unifiedDiff(a, b, 1);
    const hunkHeaders = out.split("\n").filter((l) => l.startsWith("@@"));
    expect(hunkHeaders.length).toBe(2);
  });

  test("context lines flank changes", () => {
    const out = unifiedDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne", 2);
    expect(out).toContain(" a");
    expect(out).toContain(" b");
    expect(out).toContain("-c");
    expect(out).toContain("+X");
    expect(out).toContain(" d");
    expect(out).toContain(" e");
  });

  test("empty-to-content emits adds only", () => {
    const out = unifiedDiff("", "hello\nworld");
    expect(out).toContain("+hello");
    expect(out).toContain("+world");
    const removalLines = out.split("\n").filter((l) => l.startsWith("-"));
    expect(removalLines.length).toBe(0);
  });

  test("content-to-empty emits removes only", () => {
    const out = unifiedDiff("hello\nworld", "");
    expect(out).toContain("-hello");
    expect(out).toContain("-world");
    expect(out.split("\n").filter((l) => l.startsWith("+")).length).toBe(0);
  });
});

describe("computeDiffOps", () => {
  test("returns only eq ops when inputs match", () => {
    const ops = computeDiffOps("a\nb", "a\nb");
    expect(ops.every((o) => o.kind === "eq")).toBe(true);
  });

  test("classifies single-line change as del+add pair", () => {
    const ops = computeDiffOps("a\nb\nc", "a\nX\nc");
    const dels = ops.filter((o) => o.kind === "del").map((o) => o.line);
    const adds = ops.filter((o) => o.kind === "add").map((o) => o.line);
    expect(dels).toEqual(["b"]);
    expect(adds).toEqual(["X"]);
  });
});

describe("sideBySideDiff", () => {
  test("returns empty string when inputs are identical", () => {
    expect(sideBySideDiff("a\nb", "a\nb", 40)).toBe("");
  });

  test("pairs a single-line edit so old and new appear on the same row", () => {
    const out = sideBySideDiff("hello\nfoo\nbye", "hello\nbar\nbye", 40);
    const lines = out.split("\n");
    // Find the row with the changed pair — both - and + must be on the same row.
    const pairRow = lines.find((l) => l.includes("-foo") && l.includes("+bar"));
    expect(pairRow).toBeDefined();
  });

  test("addition with no matching removal pads the left side", () => {
    const out = sideBySideDiff("a", "a\nb", 40);
    const addRow = out.split("\n").find((l) => l.includes("+b"));
    expect(addRow).toBeDefined();
    // Left side of the add row must have a blank line-number (no removal).
    if (addRow) {
      const [left] = addRow.split(" │ ");
      expect(left.trim()).toBe("");
    }
  });

  test("removal with no matching addition pads the right side", () => {
    const out = sideBySideDiff("a\nb", "a", 40);
    const delRow = out.split("\n").find((l) => l.includes("-b"));
    expect(delRow).toBeDefined();
    if (delRow) {
      const parts = delRow.split(" │ ");
      expect(parts[1].trim()).toBe("");
    }
  });

  test("header line contains vault and local labels", () => {
    const out = sideBySideDiff("a", "b", 40);
    expect(out.split("\n")[0]).toContain("vault");
    expect(out.split("\n")[0]).toContain("local");
  });
});
