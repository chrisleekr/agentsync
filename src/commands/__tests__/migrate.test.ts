/**
 * Tests for src/commands/migrate.ts — CLI argument validation.
 */

import { describe, expect, test } from "bun:test";
import { MigrateOptionsSchema } from "../../config/schema";

describe("MigrateOptionsSchema", () => {
  test("accepts valid claude → cursor migration", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "cursor",
    });
    expect(result.success).toBe(true);
  });

  test("accepts --to all", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "all",
    });
    expect(result.success).toBe(true);
  });

  test("accepts --type flag", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "cursor",
      type: "mcp",
    });
    expect(result.success).toBe(true);
  });

  test("accepts --name with --type", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "cursor",
      type: "commands",
      name: "review.md",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown agent name", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "vim",
      to: "cursor",
    });
    expect(result.success).toBe(false);
  });

  test("rejects same source and target", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "claude",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("different");
    }
  });

  test("allows same agent when --to is all", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "all",
    });
    expect(result.success).toBe(true);
  });

  test("rejects --name without --type", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "cursor",
      name: "review.md",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("--name requires --type");
    }
  });

  test("rejects invalid --type value", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "cursor",
      type: "extensions",
    });
    expect(result.success).toBe(false);
  });

  test("accepts the new skills and rules ConfigType values", () => {
    const skills = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "cursor",
      type: "skills",
    });
    expect(skills.success).toBe(true);
    const rules = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "codex",
      type: "rules",
    });
    expect(rules.success).toBe(true);
  });

  test("defaults dryRun to false", () => {
    const result = MigrateOptionsSchema.safeParse({
      from: "claude",
      to: "cursor",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dryRun).toBe(false);
    }
  });
});
