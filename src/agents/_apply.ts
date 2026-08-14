import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { log } from "@clack/prompts";
import type { AgentSyncConfig } from "../config/schema";
import { decryptString } from "../core/encryptor";
import { atomicWrite, ensureCommandBackup } from "./_utils";
import { InvalidSkillNameError, validateSkillName } from "./skills-walker";

/** Read .age (or .tar.age) files from a vault subdirectory, ignoring missing dirs. */
export async function readAgeFiles(
  dir: string,
  suffix: ".age" | ".tar.age" = ".age",
  recursive = false,
): Promise<{ name: string; fullPath: string }[]> {
  const files: { name: string; fullPath: string }[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(current, entry.name);
      if (recursive && entry.isDirectory()) {
        await walk(fullPath, name);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push({ name, fullPath });
      }
    }
  }
  try {
    await walk(dir, "");
    return files.sort((a, b) => a.name.localeCompare(b.name));
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
  /** Exact path inside the agent's vault root, e.g. "CLAUDE.md.age". */
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
  /** Preserve nested paths below `subdir` instead of accepting direct children only. */
  recursive?: boolean;
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

/** Decrypted vault content staged for whole-batch validation before restore. */
export interface DecryptedVaultArtifact {
  vaultPath: string;
  plaintext: string;
}

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
  /** Validate the complete selected batch before the first target write. */
  preflight?: (relativeVaultPaths: readonly string[]) => Promise<void>;
  /** Validate every decrypted payload in a selected batch before the first target write. */
  preflightPayloads?: (artifacts: readonly DecryptedVaultArtifact[]) => Promise<void>;
}

function stripArtifactSuffix(name: string, suffix: ".age" | ".tar.age"): string {
  return name.slice(0, -suffix.length);
}

async function vaultFileIfExists(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Vault artifact '${path}' must be a regular file`);
    }
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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
  const selected =
    plan.preflight || plan.preflightPayloads ? await readAgeFiles(agentVaultDir, ".age", true) : [];

  if (plan.preflight) {
    await plan.preflight(selected.map(({ name }) => `${plan.agent}/${name}`));
  }

  let preparedPlaintext: Map<string, string> | undefined;
  if (!dryRun && plan.preflightPayloads) {
    const artifacts: DecryptedVaultArtifact[] = [];
    preparedPlaintext = new Map();
    for (const { name, fullPath } of selected) {
      const plaintext = await decryptString(await readFile(fullPath, "utf8"), key);
      preparedPlaintext.set(name, plaintext);
      artifacts.push({
        vaultPath: `${plan.agent}/${name}`,
        plaintext,
      });
    }
    await plan.preflightPayloads(artifacts);
  }
  const payloadFor = async (name: string, fullPath: string): Promise<string> => {
    if (!preparedPlaintext) return decryptString(await readFile(fullPath, "utf8"), key);
    if (!preparedPlaintext.has(name)) {
      throw new Error(`Validated vault payload '${plan.agent}/${name}' is no longer selected`);
    }
    return preparedPlaintext.get(name) as string;
  };

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
      const fullPath = d.vaultName.includes("/")
        ? await vaultFileIfExists(join(agentVaultDir, ...d.vaultName.split("/")))
        : fileByName.get(d.vaultName);
      if (!fullPath) continue;
      if (d.enabled && !d.enabled()) continue;
      if (dryRun) {
        log.info(d.dryRunLabel);
        continue;
      }
      const decrypted = await payloadFor(d.vaultName, fullPath);
      await d.apply(decrypted);
    } else if (d.kind === "dir") {
      const files = await readAgeFiles(
        join(agentVaultDir, ...d.subdir.split("/")),
        d.suffix,
        d.recursive,
      );
      for (const { name, fullPath } of files) {
        if (d.match && !d.match(name)) continue;
        const bareName = stripArtifactSuffix(name, d.suffix);
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
        const relativeVaultPath = `${d.subdir}/${name}`;
        const decrypted = await payloadFor(relativeVaultPath, fullPath);
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
 * Reject a vault-derived dir-entry name that could escape the target directory
 * once joined: empty, `.`/`..`, or any name carrying a path separator (`/`, or
 * `\` which is a separator on Windows) or control character. This is the
 * baseline traversal guard every `dirWriteApplier` runs before it writes, so a
 * crafted vault entry like `..\\..\\evil.md.age` cannot place a file outside the
 * agent's directory. Leading dots are deliberately allowed: the snapshot walk
 * round-trips dotfile `.md` entries (`collectMarkdownDir` does not dot-skip), so
 * rejecting them here would break a legitimate round-trip.
 */
function assertSafeDirEntryName(name: string): void {
  if (name === "" || name === "." || name === "..") {
    throw new Error(`Unsafe vault entry name: ${JSON.stringify(name)}`);
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x2f || code === 0x5c) {
      throw new Error(`Unsafe vault entry name: ${JSON.stringify(name)}`);
    }
  }
}

/**
 * Build a `DirArtifact.apply` handler that writes one decrypted file into
 * `dir`: optional per-adapter name validation, then the baseline traversal
 * guard, optional `.bak` backup before overwrite, then `atomicWrite` (which
 * creates `dir` on demand). `backup` defaults to false; only Claude's
 * command/agent/rule writes opt in. The stricter per-adapter `validate` (Cursor
 * rule names, Copilot agent filenames) runs first so its message wins, but
 * `assertSafeDirEntryName` always runs as the universal backstop — it catches
 * what a per-adapter check misses, e.g. a Windows `\` separator that POSIX
 * `basename` treats as a literal character. Both run before any filesystem
 * touch, and both are independent of the build-plan `filter`, which rejects bad
 * names even earlier, before decryption.
 */
export function dirWriteApplier(opts: {
  dir: string;
  backup?: boolean;
  validate?: (name: string) => void;
}): (name: string, decrypted: string) => Promise<void> {
  return async (name, decrypted) => {
    opts.validate?.(name);
    assertSafeDirEntryName(name);
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
  runPreflight = true,
  preparedPlaintext?: string,
): Promise<void> {
  if (runPreflight) await plan.preflight?.([relativeVaultPath]);
  const agentVaultDir = join(machineRoot, plan.agent);
  const prefix = `${plan.agent}/`;
  if (!relativeVaultPath.startsWith(prefix)) {
    throw new NoMatchingArtifactError(relativeVaultPath, `path is not under ${plan.agent}/`);
  }
  const rel = relativeVaultPath.slice(prefix.length);
  if (!rel || rel.includes("\\")) {
    throw new NoMatchingArtifactError(relativeVaultPath, "path is not a safe vault-relative path");
  }
  const resolved = resolve(agentVaultDir, ...rel.split("/"));
  const containment = relative(resolve(agentVaultDir), resolved);
  if (containment === ".." || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
    throw new NoMatchingArtifactError(relativeVaultPath, "path escapes the agent vault root");
  }

  const fileDirective = plan.directives.find(
    (d): d is FileArtifact => d.kind === "file" && d.vaultName === rel,
  );
  if (fileDirective) {
    // Honour the `enabled` gate (e.g. claude marketplace) only on a directory
    // sweep, where the user named a prefix, not this file — matching what a full
    // apply would skip. An explicit single-file copy ignores it (respectEnabled
    // false), so the user's named request still wins.
    if (respectEnabled && fileDirective.enabled && !fileDirective.enabled()) {
      throw new NoMatchingArtifactError(relativeVaultPath, "sync is disabled for this artifact");
    }
    if (dryRun) {
      log.info(fileDirective.dryRunLabel);
      return;
    }
    const decrypted =
      preparedPlaintext ?? (await decryptString(await readFile(resolved, "utf8"), key));
    if (runPreflight) {
      await plan.preflightPayloads?.([{ vaultPath: relativeVaultPath, plaintext: decrypted }]);
    }
    await fileDirective.apply(decrypted);
    return;
  }

  let directive: DirArtifact | undefined;
  let name = "";
  let rejectedNestedPath = rel.split("/").length > 2;
  for (const candidate of plan.directives) {
    if (candidate.kind !== "dir" || !rel.startsWith(`${candidate.subdir}/`)) continue;
    const candidateName = rel.slice(candidate.subdir.length + 1);
    if (!candidate.recursive && candidateName.includes("/")) {
      rejectedNestedPath = true;
      continue;
    }
    if (!candidateName.endsWith(candidate.suffix)) {
      continue;
    }
    if (candidate.match && !candidate.match(candidateName)) continue;
    directive = candidate;
    name = candidateName;
    break;
  }
  if (!directive) {
    throw new NoMatchingArtifactError(
      relativeVaultPath,
      rejectedNestedPath
        ? "nested paths are not supported"
        : "no directory artifact owns this path",
    );
  }
  const bareName = stripArtifactSuffix(name, directive.suffix);
  if (directive.filter) {
    const skip = directive.filter(bareName);
    if (skip) throw new NoMatchingArtifactError(relativeVaultPath, skip.reason);
  }
  if (dryRun) {
    log.info(`[dry-run] [${plan.agent}] ${directive.dryRunVerb} ${bareName}`);
    return;
  }
  const decrypted =
    preparedPlaintext ?? (await decryptString(await readFile(resolved, "utf8"), key));
  if (runPreflight) {
    await plan.preflightPayloads?.([{ vaultPath: relativeVaultPath, plaintext: decrypted }]);
  }
  await directive.apply(bareName, decrypted);
}
