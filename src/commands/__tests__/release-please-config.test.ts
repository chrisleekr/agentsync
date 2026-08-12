import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface ChangelogSection {
  type: string;
  section: string;
  hidden?: boolean;
}

describe("release-please changelog sections", () => {
  test("preserves the pinned v17.6.0 defaults while making only refactor visible", async () => {
    const config = JSON.parse(
      await readFile(join(process.cwd(), "release-please-config.json"), "utf8"),
    ) as { "changelog-sections"?: ChangelogSection[] };

    expect(config["changelog-sections"]).toEqual([
      { type: "feat", section: "Features" },
      { type: "feature", section: "Features" },
      { type: "fix", section: "Bug Fixes" },
      { type: "perf", section: "Performance Improvements" },
      { type: "revert", section: "Reverts" },
      { type: "docs", section: "Documentation", hidden: true },
      { type: "style", section: "Styles", hidden: true },
      { type: "chore", section: "Miscellaneous Chores", hidden: true },
      { type: "refactor", section: "Code Refactoring" },
      { type: "test", section: "Tests", hidden: true },
      { type: "build", section: "Build System", hidden: true },
      { type: "ci", section: "Continuous Integration", hidden: true },
    ]);
  });
});
