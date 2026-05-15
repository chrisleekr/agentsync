import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "@clack/prompts";
import { decryptString } from "../core/encryptor";

/** Read .age (or .tar.age) files from a vault subdirectory, ignoring missing dirs. */
export async function readAgeFiles(
  dir: string,
  suffix: ".age" | ".tar.age" = ".age",
): Promise<{ name: string; fullPath: string }[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith(suffix))
      .map((name) => ({ name, fullPath: join(dir, name) }));
  } catch {
    return [];
  }
}

/**
 * Apply a single decrypted top-level file to disk via a handler. Skipped
 * silently when `enabled()` returns false (used by claude marketplace).
 */
export interface FileArtifact {
  kind: "file";
  /** Exact basename inside the agent's vault root, e.g. "CLAUDE.md.age". */
  vaultName: string;
  /** Single line emitted in dry-run mode. */
  dryRunLabel: string;
  apply: (decrypted: string) => Promise<void>;
  /** Optional gate (e.g. config.claudePlugins.syncMarketplace). */
  enabled?: () => boolean;
}

/**
 * Apply every .age (or .tar.age) entry in a subdirectory. Each entry's
 * basename (sans suffix) becomes the handler's first argument.
 */
export interface DirArtifact {
  kind: "dir";
  subdir: string;
  suffix: ".age" | ".tar.age";
  /**
   * Optional name predicate applied BEFORE suffix-stripping. Useful when an
   * adapter cares only about a specific compound suffix (e.g. copilot's
   * `*.instructions.md.age`) — return false for any vault file that should
   * be silently skipped.
   */
  match?: (fileName: string) => boolean;
  /** Dry-run prefix: `[dry-run] [<agent>] <dryRunVerb> <basename>` */
  dryRunVerb: string;
  apply: (name: string, decrypted: string) => Promise<void>;
  /** Optional pre-decrypt filter on the stripped basename. */
  filter?: (name: string) => null | { reason: string };
}

/**
 * Opaque escape hatch for adapters whose layout doesn't fit the file/dir
 * pattern (currently: Claude's nested plugins subtree).
 */
export interface EscapeHatch {
  kind: "custom";
  run: (agentVaultDir: string, key: string, dryRun: boolean) => Promise<void>;
}

export type ApplyDirective = FileArtifact | DirArtifact | EscapeHatch;

export interface ApplyPlan {
  agent: string;
  directives: ApplyDirective[];
  /**
   * When true, top-level .age files in the agent vault root that don't match
   * any `FileArtifact.vaultName` are logged as `Unrecognised vault file
   * skipped`. Cursor opts in to surface drift between adapter versions; other
   * adapters keep the silent default.
   */
  warnOnUnknownTopLevel?: boolean;
}

/**
 * Walk the vault, decrypt each artifact in the order the plan lists them,
 * and dispatch to the directive that owns the basename. Missing
 * subdirectories are silently skipped — the snapshot side may not have
 * produced them on this machine, and that's not an error.
 */
export async function runApplyPlan(
  plan: ApplyPlan,
  vaultDir: string,
  key: string,
  dryRun: boolean,
): Promise<void> {
  const agentVaultDir = join(vaultDir, plan.agent);

  // Top-level .age files are scanned once, then matched against each
  // FileArtifact in plan order. This preserves the existing behaviour where
  // an unrecognised top-level file is silently skipped.
  const topFiles = await readAgeFiles(agentVaultDir, ".age");
  const fileByName = new Map(topFiles.map((f) => [f.name, f.fullPath]));
  if (plan.warnOnUnknownTopLevel) {
    const known = new Set(
      plan.directives.filter((d): d is FileArtifact => d.kind === "file").map((d) => d.vaultName),
    );
    for (const { name } of topFiles) {
      if (!known.has(name)) log.warn(`[${plan.agent}] Unrecognised vault file skipped: ${name}`);
    }
  }

  for (const d of plan.directives) {
    if (d.kind === "file") {
      const fullPath = fileByName.get(d.vaultName);
      if (!fullPath) continue;
      if (d.enabled && !d.enabled()) continue;
      if (dryRun) {
        log.info(d.dryRunLabel);
        continue;
      }
      const encrypted = await readFile(fullPath, "utf8");
      const decrypted = await decryptString(encrypted, key);
      await d.apply(decrypted);
    } else if (d.kind === "dir") {
      const files = await readAgeFiles(join(agentVaultDir, d.subdir), d.suffix);
      for (const { name, fullPath } of files) {
        if (d.match && !d.match(name)) continue;
        const bareName = basename(name, d.suffix === ".tar.age" ? ".tar.age" : ".age");
        if (d.filter) {
          const skip = d.filter(bareName);
          if (skip) {
            log.warn(`[${plan.agent}] Skipping ${d.subdir}/${name}: ${skip.reason}`);
            continue;
          }
        }
        if (dryRun) {
          log.info(`[dry-run] [${plan.agent}] ${d.dryRunVerb} ${bareName}`);
          continue;
        }
        const encrypted = await readFile(fullPath, "utf8");
        const decrypted = await decryptString(encrypted, key);
        await d.apply(bareName, decrypted);
      }
    } else {
      await d.run(agentVaultDir, key, dryRun);
    }
  }
}

/**
 * Helper that builds a top-level `FileArtifact` with a default dry-run
 * label of `[dry-run] [<agent>] would apply <vaultName-without-.age>`.
 * Callers can override `dryRunLabel` when the existing string has been
 * stable in logs and users rely on it.
 */
export function defineFileArtifact(d: Omit<FileArtifact, "kind">): FileArtifact {
  return { kind: "file", ...d };
}
