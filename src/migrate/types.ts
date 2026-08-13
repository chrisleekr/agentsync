/**
 * src/migrate/types.ts
 *
 * Shared type definitions for the cross-agent configuration migration feature.
 * See data-model.md for entity documentation and relationships.
 */

import type { MigrationAgentName } from "./agent-names";

/** Translatable configuration categories. */
export type ConfigType = "global-rules" | "mcp" | "commands" | "skills" | "rules" | "agents";

/** Identifies a specific directional translation between two agents for one config type. */
export interface MigrationPair {
  from: MigrationAgentName;
  to: MigrationAgentName;
  type: ConfigType;
}

/** A single file or config entry that was (or would be) written during migration. */
export interface MigratedArtifact {
  /** Absolute destination path on disk. */
  targetPath: string;
  /** Absolute source path on disk (the file this artefact was translated from). */
  sourcePath: string;
  /** Transformed content ready to write. */
  content: string;
  /** Human-readable summary of the transformation applied (e.g. "claude → codex: global rules"). */
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

/** Sidecar file emitted alongside a primary translator output (used by skills with supporting files). */
export interface ExtraFile {
  /** Path relative to the artefact root (e.g. "reference.md", "scripts/build.sh"). */
  relPath: string;
  /** File content. utf8 (default) for text, base64 for binary. */
  content: string;
  encoding?: "utf8" | "base64";
}

/**
 * Pure function that converts source content to target format.
 *
 * @param sourceContent - Raw content read from the source agent's config file.
 * @param sourceName - Filename of the source artefact (used for file-based types like commands).
 * @returns Translated content, target filename, and optional warnings about lossy or
 *   partial transformations (e.g., dropped HTTP/SSE transport fields). `errors` records
 *   fail-closed validation failures. When `skipWrite` is set the orchestrator surfaces
 *   diagnostics but does not write the file. `extraFiles` lets a translator emit additional
 *   files alongside the primary one (used by skills to carry SKILL.md plus
 *   reference.md / scripts / assets). null when the input is empty or untranslatable.
 */
export type Translator = (
  sourceContent: string,
  sourceName?: string,
) => {
  content: string;
  targetName: string;
  warnings?: string[];
  errors?: string[];
  skipWrite?: boolean;
  extraFiles?: ExtraFile[];
} | null;

// MigrateOptions is defined by the Zod schema in src/config/schema.ts
// and re-exported here for convenience.
export type { MigrateOptions } from "../config/schema";

/**
 * Build a translator that delegates empty-content handling to the wrapper.
 * Every translator must return `null` for empty input so the orchestrator
 * skips writing a stub file; centralising the trim+empty check eliminates
 * the same two lines repeated across every translator and prevents drift
 * when a new translator forgets the guard.
 */
export function defineTranslator(
  fn: (trimmed: string, sourceName: string | undefined) => ReturnType<Translator>,
): Translator {
  return (content, sourceName) => {
    const trimmed = content.trim();
    if (!trimmed) return null;
    return fn(trimmed, sourceName);
  };
}
