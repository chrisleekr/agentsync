import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { log } from "@clack/prompts";
import type { AgentSyncConfig } from "../config/schema";
import { decryptString } from "../core/encryptor";
import { atomicWrite, ensureCommandBackup } from "./_utils";
import { InvalidSkillNameError, validateSkillName } from "./skills-walker";

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
  /** Optional gate on whether this artifact applies for the current config. */
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

/**
 * Standard `DirArtifact.filter` for a skills directory: runs `validateSkillName`
 * and maps `InvalidSkillNameError` to a `{ reason }` skip. Replaces the
 * identical inline try/catch every skill-bearing adapter used to carry.
 * Re-throws any non-`InvalidSkillNameError` so genuine bugs are not swallowed.
 */
export function skillNameFilter(): NonNullable<DirArtifact["filter"]> {
  return (name) => {
    try {
      validateSkillName(name);
      return null;
    } catch (err) {
      if (err instanceof InvalidSkillNameError) {
        return { reason: `invalid skill name — ${err.reason}` };
      }
      throw err;
    }
  };
}

/**
 * Build a `DirArtifact.apply` handler that writes one decrypted file into
 * `dir`: optional name validation, `mkdir -p`, optional `.bak` backup before
 * overwrite, then `atomicWrite`. `backup` defaults to false; only Claude's
 * command/agent/rule writes opt in. `validate` runs before any filesystem
 * touch (Cursor rule names, Copilot agent filenames); it is the pre-write
 * defence-in-depth guard, independent of the build-plan `filter`, which
 * rejects bad names earlier, before decryption.
 */
export function dirWriteApplier(opts: {
  dir: string;
  backup?: boolean;
  validate?: (name: string) => void;
}): (name: string, decrypted: string) => Promise<void> {
  return async (name, decrypted) => {
    opts.validate?.(name);
    await mkdir(opts.dir, { recursive: true });
    const target = join(opts.dir, name);
    if (opts.backup) await ensureCommandBackup(target);
    await atomicWrite(target, decrypted);
  };
}

/**
 * The `apply` half of an adapter: decrypt every vault artifact this agent owns
 * and write it to disk by running its plan. Replaces the one-line
 * `runApplyPlan(buildXPlan(config), …)` each adapter used to redeclare.
 */
export function makeApplyVault(
  buildPlan: (config?: AgentSyncConfig) => ApplyPlan,
): (vaultDir: string, key: string, dryRun: boolean, config?: AgentSyncConfig) => Promise<void> {
  return (vaultDir, key, dryRun, config) => runApplyPlan(buildPlan(config), vaultDir, key, dryRun);
}

/** No plan directive owns the given vault path (the `copy` command's miss). */
export class NoMatchingArtifactError extends Error {
  constructor(
    readonly vaultPath: string,
    readonly reason: string,
  ) {
    super(`No copyable artifact at ${vaultPath}: ${reason}.`);
    this.name = "NoMatchingArtifactError";
  }
}

/**
 * Apply ONE vault artifact identified by its machine-root-relative path (e.g.
 * "claude/CLAUDE.md.age" or "claude/skills/foo.tar.age"). Locates the single
 * plan directive that owns the path, decrypts that file under `machineRoot`,
 * and runs just that directive's apply — reusing the same handlers, JSONC
 * merge, validators, and dry-run behavior as runApplyPlan. This is the `copy`
 * command's primitive; it never writes the local machine's vault. Throws
 * NoMatchingArtifactError when no directive owns the path.
 */
export async function applySingleArtifact(
  plan: ApplyPlan,
  relativeVaultPath: string,
  machineRoot: string,
  key: string,
  dryRun: boolean,
  respectEnabled = false,
): Promise<void> {
  const agentVaultDir = join(machineRoot, plan.agent);
  const prefix = `${plan.agent}/`;
  if (!relativeVaultPath.startsWith(prefix)) {
    throw new NoMatchingArtifactError(relativeVaultPath, `path is not under ${plan.agent}/`);
  }
  const rel = relativeVaultPath.slice(prefix.length);
  const slash = rel.indexOf("/");

  if (slash === -1) {
    // Top-level file artifact: a FileArtifact whose vaultName is this basename.
    const directive = plan.directives.find(
      (d): d is FileArtifact => d.kind === "file" && d.vaultName === rel,
    );
    if (!directive) {
      throw new NoMatchingArtifactError(relativeVaultPath, "no file artifact owns this name");
    }
    // Honour the `enabled` gate (e.g. claude marketplace) only on a directory
    // sweep, where the user named a prefix, not this file — matching what a full
    // apply would skip. An explicit single-file copy ignores it (respectEnabled
    // false), so the user's named request still wins.
    if (respectEnabled && directive.enabled && !directive.enabled()) {
      throw new NoMatchingArtifactError(relativeVaultPath, "sync is disabled for this artifact");
    }
    if (dryRun) {
      log.info(directive.dryRunLabel);
      return;
    }
    const decrypted = await decryptString(await readFile(join(agentVaultDir, rel), "utf8"), key);
    await directive.apply(decrypted);
    return;
  }

  const subdir = rel.slice(0, slash);
  const name = rel.slice(slash + 1);
  if (name.includes("/")) {
    // Deeper nesting (e.g. plugins/<name>/…) is not a simple dir directive.
    throw new NoMatchingArtifactError(relativeVaultPath, "nested artifacts are not copyable");
  }
  const directive = plan.directives.find(
    (d): d is DirArtifact =>
      d.kind === "dir" &&
      d.subdir === subdir &&
      name.endsWith(d.suffix) &&
      (!d.match || d.match(name)),
  );
  if (!directive) {
    throw new NoMatchingArtifactError(relativeVaultPath, `no directory artifact owns ${subdir}/`);
  }
  const bareName = basename(name, directive.suffix === ".tar.age" ? ".tar.age" : ".age");
  if (directive.filter) {
    const skip = directive.filter(bareName);
    if (skip) throw new NoMatchingArtifactError(relativeVaultPath, skip.reason);
  }
  if (dryRun) {
    log.info(`[dry-run] [${plan.agent}] ${directive.dryRunVerb} ${bareName}`);
    return;
  }
  const decrypted = await decryptString(
    await readFile(join(agentVaultDir, subdir, name), "utf8"),
    key,
  );
  await directive.apply(bareName, decrypted);
}
