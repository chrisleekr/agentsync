/**
 * src/migrate/types.ts
 *
 * Shared type definitions for the cross-agent configuration migration feature.
 * See data-model.md for entity documentation and relationships.
 */

import type { AgentName } from "../agents/registry";

/** Translatable configuration categories. Skills are out of scope for this feature. */
export type ConfigType = "global-rules" | "mcp" | "commands";

/** Identifies a specific directional translation between two agents for one config type. */
export interface MigrationPair {
  from: AgentName;
  to: AgentName;
  type: ConfigType;
}

/** A single file or config entry that was (or would be) written during migration. */
export interface MigratedArtifact {
  /** Absolute destination path on disk. */
  targetPath: string;
  /** Transformed content ready to write. */
  content: string;
  /** Human-readable summary of the transformation applied. */
  description: string;
}

/** Aggregate outcome of a migration operation. */
export interface MigrateResult {
  /** Successfully translated and written (or previewed in dry-run) items. */
  migrated: MigratedArtifact[];
  /** Items not migrated, each with a reason and the pair that was attempted. */
  skipped: Array<{ reason: string; pair: MigrationPair }>;
  /** Non-fatal issues encountered during migration. */
  warnings: string[];
  /** Fatal issues that prevented migration (e.g., detected secrets, validation failures). */
  errors: string[];
}

/**
 * Pure function that converts source content to target format.
 *
 * @param sourceContent - Raw content read from the source agent's config file.
 * @param sourceName - Filename of the source artefact (used for file-based types like commands).
 * @returns Translated content and target filename, or null if the input is empty/untranslatable.
 */
export type Translator = (
  sourceContent: string,
  sourceName?: string,
) => { content: string; targetName: string } | null;

// MigrateOptions is defined by the Zod schema in src/config/schema.ts
// and re-exported here for convenience.
export type { MigrateOptions } from "../config/schema";
