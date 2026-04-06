/**
 * src/commands/migrate.ts
 *
 * CLI wrapper for the cross-agent configuration migration feature.
 * Follows the two-layer pattern: performMigrate() handles logic,
 * this module handles argument parsing and output formatting.
 */

import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { MigrateOptionsSchema } from "../config/schema";
import { performMigrate } from "../migrate/migrate";

/** CLI command definition for `agentsync migrate`. */
export const migrateCommand = defineCommand({
  meta: {
    name: "migrate",
    description: "Translate configuration from one agent format to another",
  },
  args: {
    from: {
      type: "string",
      description: "Source agent (claude|cursor|codex|copilot|vscode)",
      required: true,
    },
    to: {
      type: "string",
      description: "Target agent (claude|cursor|codex|copilot|vscode|all)",
      required: true,
    },
    type: {
      type: "string",
      description: "Config type to migrate (global-rules|mcp|commands). Omit to migrate all.",
    },
    name: {
      type: "string",
      description: "Specific artefact name (e.g. review.md). Requires --type.",
    },
    dryRun: {
      type: "boolean",
      description: "Show what would be written without touching disk",
      default: false,
    },
  },
  async run({ args }) {
    // Validate with Zod (constitution Principle IV)
    const parsed = MigrateOptionsSchema.safeParse({
      from: args.from,
      to: args.to,
      type: args.type || undefined,
      name: args.name || undefined,
      dryRun: args.dryRun,
    });

    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        log.error(issue.message);
      }
      process.exitCode = 1;
      return;
    }

    const options = parsed.data;
    const result = await performMigrate(options);

    const hasErrors = result.errors.length > 0;
    if (hasErrors) {
      for (const e of result.errors) {
        log.error(e);
      }
    }

    // Dry-run output
    if (options.dryRun) {
      for (const m of result.migrated) {
        log.info(`[dry-run] \u2192 ${m.targetPath}: ${m.description}`);
      }
      for (const s of result.skipped) {
        log.warn(
          `[dry-run] skipped (${s.reason}): ${s.pair.from}\u2192${s.pair.to} ${s.pair.type}`,
        );
      }
      if (result.migrated.length === 0) {
        log.info("Dry run complete. Nothing would be written.");
      } else {
        log.info(`Dry run complete. ${result.migrated.length} artefact(s) would be written.`);
      }
      if (hasErrors) process.exitCode = 1;
      return;
    }

    // Real migration output
    if (result.migrated.length === 0) {
      log.info("Nothing to migrate.");
    } else {
      for (const m of result.migrated) {
        log.success(`\u2192 ${m.targetPath}`);
      }
      log.success(`Migrated ${result.migrated.length} artefact(s).`);
    }
    if (result.skipped.length > 0) {
      for (const s of result.skipped) {
        log.warn(`Skipped (${s.reason}): ${s.pair.from}\u2192${s.pair.to} ${s.pair.type}`);
      }
    }
    if (hasErrors) process.exitCode = 1;
  },
});
