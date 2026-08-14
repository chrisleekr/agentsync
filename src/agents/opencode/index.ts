import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import {
  AgentPaths,
  type OpenCodeConfigOrigin,
  type OpenCodeConfigRoot,
  resolveOpenCodeConfigRoots,
} from "../../config/paths";
import type { AgentSyncConfig } from "../../config/schema";
import { scanForSecrets, securityToPolicy, shouldNeverSync } from "../../core/sanitizer";
import {
  type ArchiveInspectionLimits,
  archiveDirectory,
  extractArchive,
  listArchiveEntries,
  type TarEntry,
} from "../../core/tar";
import { OPEN_CODE_SKILL_FLAGS, openCodeBooleanFlag } from "../../opencode/runtime-flags";
import { openCodeSkillContractErrors } from "../../opencode/skill-contract";
import {
  type ApplyPlan,
  type DecryptedVaultArtifact,
  defineFileArtifact,
  makeApplyVault,
} from "../_apply";
import type { SnapshotArtifact, SnapshotResult } from "../_utils";
import { NEVER_SYNC_WARNING_PREFIX } from "../skills-walker";
import { annotateSnapshotWarning } from "../snapshot-safety";
import { mergeOpenCodeJsonc, parseOpenCodeJsonc, sanitizeOpenCodeJsonc } from "./jsonc";

export type OpenCodeSnapshotResult = SnapshotResult;

type RootName = "command" | "commands" | "agent" | "agents" | "skill" | "skills";
type MarkdownKind = "command" | "agent";

interface MarkdownSource {
  kind: MarkdownKind;
  origin: OpenCodeConfigOrigin;
  rootName: RootName;
  relativePath: string;
  sourcePath: string;
}

interface SkillSource {
  origin: OpenCodeConfigOrigin;
  rootName: "skill" | "skills";
  relativeDir: string;
  sourcePath: string;
}

const UNSUPPORTED_ENVIRONMENT = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_TUI_CONFIG",
  "OPENCODE_PERMISSION",
  "OPENCODE_TEST_HOME",
] as const;

const UNSUPPORTED_TRUTHY_ENVIRONMENT = [
  "OPENCODE_DISABLE_AUTOCOMPACT",
  "OPENCODE_DISABLE_PRUNE",
] as const;

/** Fixed bounds for untrusted skill bundles, well above ordinary text-and-script packages. */
const OPEN_CODE_SKILL_ARCHIVE_LIMITS = {
  maxEntries: 4_096,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxPathBytes: 4_096,
  maxExpandedBytes: 96 * 1024 * 1024,
} as const satisfies ArchiveInspectionLimits;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function assertOpenCodeEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const active = UNSUPPORTED_ENVIRONMENT.filter((name) =>
    name === "OPENCODE_TEST_HOME" ? env[name] !== undefined : (env[name]?.length ?? 0) > 0,
  );
  const activeTruthy = UNSUPPORTED_TRUTHY_ENVIRONMENT.filter((name) => {
    const value = env[name]?.toLowerCase();
    return value === "true" || value === "1";
  });
  const errors: string[] = [];
  if (active.length > 0) {
    errors.push(
      `OpenCode vault backup cannot represent active ${active.join(", ")}; unset ${active.join(", ")} before push, status, or copy`,
    );
  }
  if (activeTruthy.length > 0) {
    errors.push(
      `OpenCode vault backup cannot represent active ${activeTruthy.join(", ")}; unset ${activeTruthy.join(", ")} before push, status, or copy`,
    );
  }
  if (env.OPENCODE_CONFIG_DIR === "") {
    errors.push(
      "OpenCode vault backup cannot represent an exported-empty OPENCODE_CONFIG_DIR; unset it or set a non-empty directory before push, status, or copy",
    );
  }
  for (const flag of OPEN_CODE_SKILL_FLAGS) {
    try {
      openCodeBooleanFlag(flag, env);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(errors.join("; "));
}

function normalizedIdentity(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function portableSegmentError(segment: string): string | undefined {
  if (!segment || segment === "." || segment === "..") return "reserved path segment";
  if (segment.includes("/") || segment.includes("\\")) return "path separator";
  if (/\p{Cc}/u.test(segment)) return "control character";
  if (/[:*?"<>|]/.test(segment)) return "Windows-reserved character";
  if (segment.endsWith(".") || segment.endsWith(" ")) return "Windows-reserved suffix";
  const stem = (segment.split(".")[0] ?? "").toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM(?:[1-9]|[¹²³])|LPT(?:[1-9]|[¹²³]))$/.test(stem)) {
    return "Windows-reserved device name";
  }
  return undefined;
}

function assertPortableRelativePath(path: string, label: string): void {
  if (!path || path.startsWith("/") || path.includes("\\")) {
    throw new Error(`${label} '${path}' is not a safe relative path`);
  }
  for (const segment of path.split("/")) {
    const reason = portableSegmentError(segment);
    if (reason) throw new Error(`${label} '${path}' contains a ${reason}: '${segment}'`);
  }
}

function assertRealDirectory(
  path: string,
  label: string,
  info: Awaited<ReturnType<typeof lstat>>,
): void {
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} '${path}' must be a real directory`);
  }
}

async function assertExistingDirectoryComponents(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const filesystemRoot = parsePath(absolute).root;
  let current = filesystemRoot;
  for (const segment of relative(filesystemRoot, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await lstatIfExists(current);
    if (!info) return;
    assertRealDirectory(current, label, info);
  }
}

async function assertConfigRoot(root: OpenCodeConfigRoot): Promise<boolean> {
  await assertExistingDirectoryComponents(root.dir, "OpenCode config root component");
  const info = await lstatIfExists(root.dir);
  if (!info) return false;
  assertRealDirectory(root.dir, "OpenCode config root", info);
  return true;
}

function assertDistinctRoots(roots: readonly OpenCodeConfigRoot[]): void {
  if (roots.length < 2) return;
  const [first, second] = roots.map((root) => resolve(root.dir));
  if (!first || !second) return;
  const firstKey = normalizedIdentity(toPosix(first)).replace(/\/$/, "");
  const secondKey = normalizedIdentity(toPosix(second)).replace(/\/$/, "");
  if (
    firstKey === secondKey ||
    firstKey.startsWith(`${secondKey}/`) ||
    secondKey.startsWith(`${firstKey}/`)
  ) {
    throw new Error(
      `OpenCode default and OPENCODE_CONFIG_DIR roots must not contain one another: '${first}' and '${second}'`,
    );
  }
}

async function assertNoUnsupportedGlobalSources(
  roots: readonly OpenCodeConfigRoot[],
): Promise<void> {
  const commonExcludedRoots = [
    { names: ["plugin", "plugins"], suffixes: [".ts", ".js"] },
    { names: ["mode", "modes"], suffixes: [".md"] },
    { names: ["tool", "tools"], suffixes: [".ts", ".js"] },
  ] as const;
  const defaultOnlyExcludedRoots = [{ names: ["themes"], suffixes: [".json"] }] as const;
  for (const root of roots) {
    const excludedRoots =
      root.origin === "default"
        ? [...commonExcludedRoots, ...defaultOnlyExcludedRoots]
        : commonExcludedRoots;
    for (const excluded of excludedRoots) {
      for (const name of excluded.names) {
        const sourceRoot = join(root.dir, name);
        const info = await lstatIfExists(sourceRoot);
        if (!info) continue;
        if (info.isSymbolicLink()) {
          throw new Error(
            `OpenCode excluded source root '${sourceRoot}' must not be a symbolic link`,
          );
        }
        if (!info.isDirectory()) continue;
        const entries = await readdir(sourceRoot, { withFileTypes: true });
        const active = entries.find((entry) =>
          excluded.suffixes.some((suffix) => entry.name.endsWith(suffix)),
        );
        if (active) {
          if (active.isSymbolicLink() || !active.isFile()) {
            throw new Error(
              `OpenCode excluded source '${join(sourceRoot, active.name)}' must be a regular file`,
            );
          }
          throw new Error(
            `OpenCode global '${join(sourceRoot, active.name)}' is active but excluded from vault backup; remove or relocate it before backup`,
          );
        }
      }
    }
  }
}

async function assertNoUnsupportedHomeOpenCodeSource(
  roots: readonly OpenCodeConfigRoot[],
): Promise<void> {
  const homeRoot = resolve(AgentPaths.opencode.homeConfigDir);
  if (roots.some((root) => resolve(root.dir) === homeRoot)) return;

  await assertExistingDirectoryComponents(homeRoot, "OpenCode home source component");
  const info = await lstatIfExists(homeRoot);
  if (!info) return;
  assertRealDirectory(homeRoot, "OpenCode home source", info);

  for (const name of ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"] as const) {
    const source = join(homeRoot, name);
    if (await lstatIfExists(source)) {
      throw new Error(
        `OpenCode home source '${source}' is active but excluded from filesystem vault backup; move it into a configured OpenCode root before push, status, or copy`,
      );
    }
  }

  const unsupportedRoot = [{ origin: "custom" as const, dir: homeRoot }];
  await assertNoUnsupportedGlobalSources(unsupportedRoot);
  for (const kind of ["command", "agent"] as const) {
    const source = (await discoverMarkdownSources(unsupportedRoot, kind))[0];
    if (source) {
      throw new Error(
        `OpenCode home ${kind} '${source.sourcePath}' is active but excluded from filesystem vault backup; move it into a configured OpenCode root before push, status, or copy`,
      );
    }
  }
  const skill = (await discoverSkillSources(unsupportedRoot))[0];
  if (skill) {
    throw new Error(
      `OpenCode home skill '${skill.sourcePath}' is active but excluded from filesystem vault backup; move it into a configured OpenCode root before push, status, or copy`,
    );
  }
}

export function resolveManagedOpenCodeSourcePaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  username: string,
): string[] {
  const pathApi = platform === "win32" ? win32 : posix;
  const overrideDir = env.OPENCODE_TEST_MANAGED_CONFIG_DIR;
  const managedDir =
    overrideDir ||
    (platform === "darwin"
      ? "/Library/Application Support/opencode"
      : platform === "win32"
        ? win32.join(env.ProgramData || "C:\\ProgramData", "opencode")
        : "/etc/opencode");
  const sources = [
    pathApi.join(managedDir, "opencode.json"),
    pathApi.join(managedDir, "opencode.jsonc"),
  ];
  if (platform === "darwin") {
    sources.push(
      posix.join("/Library/Managed Preferences", username, "ai.opencode.managed.plist"),
      posix.join("/Library/Managed Preferences", "ai.opencode.managed.plist"),
    );
  }
  return sources;
}

async function assertNoManagedOpenCodeSources(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let username = "user";
  try {
    username = userInfo().username || username;
  } catch {}
  const sources = resolveManagedOpenCodeSourcePaths(process.platform, env, username);
  for (const source of sources) {
    if (await lstatIfExists(source)) {
      throw new Error(
        `OpenCode managed config '${source}' is active but excluded from filesystem vault backup`,
      );
    }
  }
}

async function containsSkill(root: string, visited = new Set<string>()): Promise<boolean> {
  const info = await lstatIfExists(root);
  if (!info) return false;
  if (info.isFile()) return basename(root) === "SKILL.md";
  if (!info.isDirectory() && !info.isSymbolicLink()) return false;

  let canonical: string;
  try {
    canonical = await realpath(root);
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
  const target = await lstatIfExists(canonical);
  if (!target) return false;
  if (target.isFile()) return basename(root) === "SKILL.md";
  if (!target.isDirectory()) return false;
  if (visited.has(canonical)) return false;
  visited.add(canonical);

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (await containsSkill(join(root, entry.name), visited)) return true;
  }
  return false;
}

async function assertNoActiveExternalSkills(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (openCodeBooleanFlag("OPENCODE_DISABLE_EXTERNAL_SKILLS", env)) return;
  const candidates = [AgentPaths.codex.userSkillsDir];
  if (
    !openCodeBooleanFlag("OPENCODE_DISABLE_CLAUDE_CODE", env) &&
    !openCodeBooleanFlag("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", env)
  ) {
    candidates.push(AgentPaths.claude.skillsDir);
  }
  for (const path of candidates) {
    if (await containsSkill(path)) {
      throw new Error(
        `OpenCode discovers external skills under '${path}', but this adapter backs up only OpenCode-native skills; disable external skill discovery or remove the external source`,
      );
    }
  }
}

async function assertNoActiveClaudePrompt(
  roots: readonly OpenCodeConfigRoot[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (
    openCodeBooleanFlag("OPENCODE_DISABLE_CLAUDE_CODE", env) ||
    openCodeBooleanFlag("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", env)
  ) {
    return;
  }
  const activeRoot = roots.at(-1) as OpenCodeConfigRoot;
  if (
    (await readRegularFileIfExists(
      join(activeRoot.dir, "AGENTS.md"),
      "OpenCode global AGENTS.md",
    )) !== null
  ) {
    return;
  }
  if (
    (await readRegularFileIfExists(
      AgentPaths.claude.claudeMd,
      "OpenCode external Claude prompt",
    )) !== null
  ) {
    throw new Error(
      `OpenCode discovers external instructions from '${AgentPaths.claude.claudeMd}', but this adapter backs up only the active global AGENTS.md; disable Claude prompt discovery or add AGENTS.md to the active OpenCode config root`,
    );
  }
}

async function readRegularFileIfExists(path: string, label: string): Promise<Buffer | null> {
  await assertExistingDirectoryComponents(dirname(path), `${label} directory component`);
  const before = await lstatIfExists(path);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} '${path}' must be a regular file`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} '${path}' must be a regular file`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readRegularTextIfExists(path: string, label: string): Promise<string | null> {
  return (await readRegularFileIfExists(path, label))?.toString("utf8") ?? null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isConfigured(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function assertRepresentableConfig(
  parsed: Record<string, unknown>,
  sourcePath: string,
  kind: "main" | "tui",
): void {
  if (isConfigured(parsed.plugin)) {
    throw new Error(
      `OpenCode config '${sourcePath}' enables executable plugins, which vault backup deliberately excludes`,
    );
  }
  if (isConfigured(parsed.theme) || isConfigured(parsed.tools)) {
    throw new Error(
      `OpenCode config '${sourcePath}' declares excluded theme or tool configuration`,
    );
  }
  if (kind === "tui") return;

  for (const field of ["command", "agent", "mode"] as const) {
    if (isConfigured(parsed[field])) {
      throw new Error(
        `OpenCode config '${sourcePath}' declares inline '${field}' entries; only filesystem command and agent artifacts are supported`,
      );
    }
  }

  if (isConfigured(parsed.instructions)) {
    throw new Error(
      `OpenCode config '${sourcePath}' declares additional instruction sources; only global AGENTS.md is supported`,
    );
  }
  if (isConfigured(parsed.references) || isConfigured(parsed.reference)) {
    throw new Error(
      `OpenCode config '${sourcePath}' declares external references, which vault backup deliberately excludes`,
    );
  }
  if (parsed.skills !== undefined) {
    if (!isPlainObject(parsed.skills)) {
      throw new Error(`OpenCode config '${sourcePath}' has malformed 'skills' configuration`);
    }
    if (isConfigured(parsed.skills.paths) || isConfigured(parsed.skills.urls)) {
      throw new Error(
        `OpenCode config '${sourcePath}' declares external skill paths or URLs; only native skill bundles are supported`,
      );
    }
  }

  function containsFileReference(value: unknown): boolean {
    if (typeof value === "string") return /\{file:[^}]+\}/.test(value);
    if (Array.isArray(value)) return value.some(containsFileReference);
    if (!isPlainObject(value)) return false;
    return Object.entries(value).some(
      ([key, child]) => /\{file:[^}]+\}/.test(key) || containsFileReference(child),
    );
  }
  if (containsFileReference(parsed)) {
    throw new Error(
      `OpenCode config '${sourcePath}' contains an external {file:...} reference, which vault backup cannot make portable`,
    );
  }
}

async function discoverMarkdownSources(
  roots: readonly OpenCodeConfigRoot[],
  kind: MarkdownKind,
): Promise<MarkdownSource[]> {
  const sources: MarkdownSource[] = [];
  const identities = new Map<string, string>();
  for (const root of roots) {
    for (const rootName of [kind, `${kind}s`] as const) {
      const sourceRoot = join(root.dir, rootName);
      await assertExistingDirectoryComponents(sourceRoot, `OpenCode ${kind} root component`);
      const rootInfo = await lstatIfExists(sourceRoot);
      if (!rootInfo) continue;
      assertRealDirectory(sourceRoot, `OpenCode ${kind} root`, rootInfo);

      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const entryPath = join(dir, entry.name);
          if (entry.isSymbolicLink()) {
            throw new Error(`OpenCode ${kind} source '${entryPath}' must not be a symbolic link`);
          }
          if (entry.isDirectory()) {
            const reason = portableSegmentError(entry.name);
            if (reason) {
              throw new Error(
                `OpenCode ${kind} source directory '${entryPath}' contains a ${reason}`,
              );
            }
            await walk(entryPath);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const relativePath = toPosix(relative(sourceRoot, entryPath));
          assertPortableRelativePath(relativePath, `OpenCode ${kind} source path`);
          const identity = relativePath.slice(0, -".md".length);
          const key = normalizedIdentity(identity);
          const existing = identities.get(key);
          if (existing) {
            throw new Error(
              `Duplicate OpenCode ${kind} identity '${identity}' in '${existing}' and '${entryPath}'`,
            );
          }
          identities.set(key, entryPath);
          sources.push({
            kind,
            origin: root.origin,
            rootName,
            relativePath,
            sourcePath: entryPath,
          });
        }
      }
      await walk(sourceRoot);
    }
  }
  return sources;
}

async function discoverSkillSources(roots: readonly OpenCodeConfigRoot[]): Promise<SkillSource[]> {
  const sources: SkillSource[] = [];
  const identities = new Map<string, string>();
  for (const root of roots) {
    for (const rootName of ["skill", "skills"] as const) {
      const sourceRoot = join(root.dir, rootName);
      await assertExistingDirectoryComponents(sourceRoot, "OpenCode skill root component");
      const rootInfo = await lstatIfExists(sourceRoot);
      if (!rootInfo) continue;
      assertRealDirectory(sourceRoot, "OpenCode skill root", rootInfo);

      async function walk(dir: string): Promise<void> {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const entryPath = join(dir, entry.name);
          if (entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())) {
            continue;
          }
          if (entry.isSymbolicLink()) {
            throw new Error(`OpenCode skill source '${entryPath}' must not be a symbolic link`);
          }
          if (entry.isDirectory()) {
            const reason = portableSegmentError(entry.name);
            if (reason)
              throw new Error(`OpenCode skill directory '${entryPath}' contains a ${reason}`);
            await walk(entryPath);
            continue;
          }
          if (!entry.isFile() || entry.name !== "SKILL.md") continue;
          const skillDir = dirname(entryPath);
          const relativeDir = toPosix(relative(sourceRoot, skillDir));
          assertPortableRelativePath(relativeDir, "OpenCode skill path");
          const content = await readRegularTextIfExists(entryPath, "OpenCode SKILL.md source");
          if (content === null) throw new Error(`OpenCode skill '${entryPath}' disappeared`);
          const name = basename(skillDir);
          const errors = openCodeSkillContractErrors(content, name);
          if (errors.length > 0) {
            throw new Error(`OpenCode skill '${entryPath}': ${errors.join("; ")}`);
          }
          const key = normalizedIdentity(name);
          const existing = identities.get(key);
          if (existing) {
            throw new Error(
              `Duplicate OpenCode skill identity '${name}' in '${existing}' and '${entryPath}'`,
            );
          }
          identities.set(key, entryPath);
          sources.push({
            origin: root.origin,
            rootName,
            relativeDir,
            sourcePath: skillDir,
          });
        }
      }
      await walk(sourceRoot);
    }
  }
  return sources;
}

function isNestedUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function excludedSkillSubtrees(source: SkillSource, allSkillRoots: readonly string[]): string[] {
  const nestedRoots = allSkillRoots.filter((candidate) =>
    isNestedUnder(source.sourcePath, candidate),
  );
  return nestedRoots.map((candidate) => toPosix(relative(source.sourcePath, candidate)));
}

async function assertSkillSourceEntryTypes(
  sourceRoot: string,
  excluded: readonly string[],
  directory: string = sourceRoot,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const relativePath = toPosix(relative(sourceRoot, entryPath));
    if (excluded.some((path) => relativePath === path || relativePath.startsWith(`${path}/`))) {
      continue;
    }
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) {
      throw new Error(`OpenCode skill source '${entryPath}' must not be a symbolic link`);
    }
    if (info.isDirectory()) {
      await assertSkillSourceEntryTypes(sourceRoot, excluded, entryPath);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`OpenCode skill source '${entryPath}' must be a regular file or directory`);
    }
    if (info.nlink > 1) {
      throw new Error(`OpenCode skill source '${entryPath}' must not be a hard link`);
    }
  }
}

interface RetainedSkillArchiveOptions {
  label: string;
  logicalRoot: string;
  expectedName: string;
  vaultPath: string;
  policy: ReturnType<typeof securityToPolicy>;
}

async function inspectRetainedSkillArchive(
  archive: Buffer,
  options: RetainedSkillArchiveOptions,
): Promise<{ entries: TarEntry[]; warnings: string[] }> {
  const entries = await listArchiveEntries(archive, {
    strict: true,
    includeDirectories: true,
    limits: OPEN_CODE_SKILL_ARCHIVE_LIMITS,
  });
  const skillManifests = entries.filter(
    (entry) =>
      entry.type === "file" && (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
  );
  if (skillManifests.length !== 1 || skillManifests[0]?.path !== "SKILL.md") {
    throw new Error(
      `${options.label} must retain exactly one SKILL.md at archive root and no nested SKILL.md`,
    );
  }
  const contractErrors = openCodeSkillContractErrors(
    skillManifests[0].content.toString("utf8"),
    options.expectedName,
  );
  if (contractErrors.length > 0) {
    throw new Error(`${options.label}: ${contractErrors.join("; ")}`);
  }
  const warnings: string[] = [];
  for (const entry of entries) {
    assertPortableRelativePath(entry.path, "OpenCode retained skill entry");
    if (entry.type !== "file") continue;
    const logicalPath = join(options.logicalRoot, ...entry.path.split("/"));
    if (shouldNeverSync(logicalPath)) {
      warnings.push(
        annotateSnapshotWarning(`${NEVER_SYNC_WARNING_PREFIX}${logicalPath}`, options.vaultPath),
      );
    }
    warnings.push(
      ...scanForSecrets(entry.content.toString("utf8"), logicalPath, options.policy).map(
        (warning) => annotateSnapshotWarning(warning, options.vaultPath),
      ),
    );
  }
  return { entries, warnings };
}

function configVaultPath(origin: OpenCodeConfigOrigin, name: string): string {
  return `opencode/${origin}/${name}.age`;
}

/** Snapshot exactly the supported global OpenCode surfaces. */
export async function snapshotOpenCode(config?: AgentSyncConfig): Promise<OpenCodeSnapshotResult> {
  assertOpenCodeEnvironment();
  await assertNoManagedOpenCodeSources();
  const roots = resolveOpenCodeConfigRoots();
  assertDistinctRoots(roots);
  for (const root of roots) await assertConfigRoot(root);
  await assertNoUnsupportedHomeOpenCodeSource(roots);
  await assertNoUnsupportedGlobalSources(roots);
  await assertNoActiveExternalSkills();
  await assertNoActiveClaudePrompt(roots);

  const policy = securityToPolicy(config?.security);
  const artifacts: SnapshotArtifact[] = [];
  const warnings: string[] = [];

  for (const root of roots) {
    if (root.origin === "default") {
      for (const legacyName of ["config.json", "config"] as const) {
        const legacyPath = join(root.dir, legacyName);
        if ((await readRegularFileIfExists(legacyPath, "OpenCode legacy config source")) !== null) {
          throw new Error(
            `OpenCode legacy config '${legacyPath}' is active but unsupported; consolidate it into opencode.json or opencode.jsonc before backup`,
          );
        }
      }
    }
    for (const name of ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"] as const) {
      const sourcePath = join(root.dir, name);
      const raw = await readRegularTextIfExists(sourcePath, "OpenCode JSONC source");
      if (raw === null) continue;
      const kind = name.startsWith("tui.") ? "tui" : "main";
      const parsed = parseOpenCodeJsonc(raw, `OpenCode config '${sourcePath}'`);
      assertRepresentableConfig(parsed, sourcePath, kind);
      const sanitized = sanitizeOpenCodeJsonc(raw, name, homedir(), policy);
      const artifact = {
        vaultPath: configVaultPath(root.origin, name),
        sourcePath,
        plaintext: sanitized.value,
        warnings: sanitized.warnings,
      };
      artifacts.push(artifact);
      warnings.push(...sanitized.warnings);
    }
  }

  const activeRoot = roots.at(-1) as OpenCodeConfigRoot;
  const agentsMdPath = join(activeRoot.dir, "AGENTS.md");
  const agentsMd = await readRegularTextIfExists(agentsMdPath, "OpenCode global AGENTS.md");
  if (agentsMd !== null) {
    artifacts.push({
      vaultPath: configVaultPath(activeRoot.origin, "AGENTS.md"),
      sourcePath: agentsMdPath,
      plaintext: agentsMd,
      warnings: [],
    });
  }

  for (const kind of ["command", "agent"] as const) {
    for (const source of await discoverMarkdownSources(roots, kind)) {
      const content = await readRegularTextIfExists(source.sourcePath, `OpenCode ${kind} source`);
      if (content === null) throw new Error(`OpenCode ${kind} '${source.sourcePath}' disappeared`);
      artifacts.push({
        vaultPath: `opencode/${source.origin}/${source.rootName}/${source.relativePath}.age`,
        sourcePath: source.sourcePath,
        plaintext: content,
        warnings: [],
      });
    }
  }

  const skills = await discoverSkillSources(roots);
  const allSkillRoots = skills.map((skill) => resolve(skill.sourcePath));
  for (const skill of skills) {
    const excluded = excludedSkillSubtrees(skill, allSkillRoots);
    await assertSkillSourceEntryTypes(skill.sourcePath, excluded);
    const archive = await archiveDirectory(skill.sourcePath, {
      exclude: (path) => excluded.some((entry) => path === entry || path.startsWith(`${entry}/`)),
    });
    const vaultPath = `opencode/${skill.origin}/${skill.rootName}/${skill.relativeDir}.tar.age`;
    const { warnings: archiveWarnings } = await inspectRetainedSkillArchive(archive, {
      label: `OpenCode skill '${skill.sourcePath}'`,
      logicalRoot: skill.sourcePath,
      expectedName: basename(skill.relativeDir),
      vaultPath,
      policy,
    });
    if (archiveWarnings.length > 0) {
      warnings.push(...archiveWarnings);
      continue;
    }
    artifacts.push({
      vaultPath,
      sourcePath: skill.sourcePath,
      plaintext: archive.toString("base64"),
      warnings: [],
    });
  }

  artifacts.sort((left, right) => left.vaultPath.localeCompare(right.vaultPath));
  warnings.sort();
  return { artifacts, warnings };
}

interface ParsedVaultArtifact {
  kind: "config" | "tui" | "rules" | "command" | "agent" | "skill";
  origin: OpenCodeConfigOrigin;
  rootName?: RootName;
  relativePath: string;
  targetRoot: string;
  targetPath: string;
}

function rootForOrigin(origin: OpenCodeConfigOrigin): string {
  const root = resolveOpenCodeConfigRoots().find((candidate) => candidate.origin === origin);
  if (!root) {
    throw new Error(
      "OpenCode custom-origin restore requires OPENCODE_CONFIG_DIR on the destination",
    );
  }
  return root.dir;
}

function parseVaultArtifact(relativeVaultPath: string): ParsedVaultArtifact | null {
  const prefix = "opencode/";
  if (!relativeVaultPath.startsWith(prefix)) return null;
  const segments = relativeVaultPath.slice(prefix.length).split("/");
  const origin = segments.shift();
  if (origin !== "default" && origin !== "custom") return null;
  const targetRoot = rootForOrigin(origin);
  const first = segments.shift();
  if (!first) return null;

  const fileKinds = {
    "opencode.json.age": "config",
    "opencode.jsonc.age": "config",
    "tui.json.age": "tui",
    "tui.jsonc.age": "tui",
    "AGENTS.md.age": "rules",
  } as const;
  if (segments.length === 0 && first in fileKinds) {
    const name = first.slice(0, -".age".length);
    return {
      kind: fileKinds[first as keyof typeof fileKinds],
      origin,
      relativePath: name,
      targetRoot,
      targetPath: join(targetRoot, name),
    };
  }

  if (!["command", "commands", "agent", "agents", "skill", "skills"].includes(first)) {
    return null;
  }
  const rootName = first as RootName;
  const encodedPath = segments.join("/");
  const skill = rootName === "skill" || rootName === "skills";
  const suffix = skill ? ".tar.age" : ".age";
  if (!encodedPath.endsWith(suffix)) return null;
  const relativePath = encodedPath.slice(0, -suffix.length);
  if (!skill && !relativePath.endsWith(".md")) return null;
  assertPortableRelativePath(relativePath, "OpenCode vault artifact path");
  return {
    kind: skill ? "skill" : rootName.startsWith("command") ? "command" : "agent",
    origin,
    rootName,
    relativePath,
    targetRoot,
    targetPath: join(targetRoot, rootName, ...relativePath.split("/")),
  };
}

function containedTarget(rootPath: string, targetPath: string, label: string): string {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} '${targetPath}' escapes '${root}'`);
  }
  return target;
}

async function assertNoCaseEquivalentComponents(
  rootPath: string,
  targetPath: string,
): Promise<void> {
  const root = resolve(rootPath);
  const target = containedTarget(root, targetPath, "OpenCode target");
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    const info = await lstatIfExists(current);
    if (!info) return;
    assertRealDirectory(current, "OpenCode target directory", info);
    const entries = await readdir(current);
    const collision = entries.find(
      (entry) => entry !== segment && normalizedIdentity(entry) === normalizedIdentity(segment),
    );
    if (collision) {
      throw new Error(
        `OpenCode target path collision: '${join(current, collision)}' and '${join(current, segment)}'`,
      );
    }
    current = join(current, segment);
  }
}

async function assertTreeHasNoLinks(root: string): Promise<void> {
  const info = await lstatIfExists(root);
  if (!info) return;
  assertRealDirectory(root, "OpenCode skill target", info);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`OpenCode skill target '${entryPath}' must not be a symbolic link`);
    }
    if (entry.isDirectory()) await assertTreeHasNoLinks(entryPath);
  }
}

async function preflightFileTarget(rootPath: string, targetPath: string): Promise<number> {
  const target = containedTarget(rootPath, targetPath, "OpenCode file target");
  await assertExistingDirectoryComponents(dirname(target), "OpenCode target directory component");
  await assertNoCaseEquivalentComponents(rootPath, target);
  const info = await lstatIfExists(target);
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw new Error(`OpenCode target '${target}' must be a regular file`);
  }
  return info ? info.mode & 0o777 : 0o600;
}

async function preflightDirectoryTarget(rootPath: string, targetPath: string): Promise<void> {
  const target = containedTarget(rootPath, targetPath, "OpenCode directory target");
  await assertExistingDirectoryComponents(dirname(target), "OpenCode target directory component");
  await assertNoCaseEquivalentComponents(rootPath, target);
  const info = await lstatIfExists(target);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error(`OpenCode target '${target}' must be a real directory`);
  }
}

async function preflightSkillTarget(rootPath: string, targetPath: string): Promise<void> {
  const target = containedTarget(rootPath, targetPath, "OpenCode skill target");
  await assertExistingDirectoryComponents(target, "OpenCode skill target component");
  await assertNoCaseEquivalentComponents(rootPath, target);
  await assertTreeHasNoLinks(target);
}

async function ensureContainedDirectories(rootPath: string, targetDir: string): Promise<void> {
  const root = resolve(rootPath);
  const target = resolve(targetDir);
  if (target !== root) containedTarget(root, target, "OpenCode directory target");
  await assertExistingDirectoryComponents(target, "OpenCode target directory component");

  const missing: string[] = [];
  let current = target;
  while (!(await lstatIfExists(current))) {
    missing.unshift(current);
    const parent = dirname(current);
    if (parent === current) throw new Error(`Cannot create OpenCode target directory '${target}'`);
    current = parent;
  }
  assertRealDirectory(current, "OpenCode target directory component", await lstat(current));
  for (const path of missing) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    assertRealDirectory(path, "OpenCode target directory component", await lstat(path));
  }
}

async function stageContainedWrite(
  rootPath: string,
  targetPath: string,
  content: string,
): Promise<void> {
  const mode = await preflightFileTarget(rootPath, targetPath);
  await ensureContainedDirectories(rootPath, dirname(targetPath));
  await preflightFileTarget(rootPath, targetPath);
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    if (process.platform !== "win32") await handle.chmod(mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await preflightFileTarget(rootPath, targetPath);
    await rename(tempPath, targetPath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function applyJsoncArtifact(
  origin: OpenCodeConfigOrigin,
  name: "opencode.json" | "opencode.jsonc" | "tui.json" | "tui.jsonc",
  content: string,
): Promise<void> {
  const root = rootForOrigin(origin);
  const target = join(root, name);
  const incoming = parseOpenCodeJsonc(content, `OpenCode ${name} vault artifact`);
  assertRepresentableConfig(incoming, target, name.startsWith("tui.") ? "tui" : "main");
  const existing = await readRegularTextIfExists(target, "OpenCode JSONC target");
  const merged = mergeOpenCodeJsonc(existing, content, name, homedir());
  await stageContainedWrite(root, target, merged);
}

async function applyMarkdownArtifact(
  origin: OpenCodeConfigOrigin,
  rootName: "command" | "commands" | "agent" | "agents",
  relativePath: string,
  content: string,
): Promise<void> {
  assertPortableRelativePath(relativePath, "OpenCode Markdown target path");
  const root = rootForOrigin(origin);
  await stageContainedWrite(root, join(root, rootName, ...relativePath.split("/")), content);
}

async function applySkillArtifact(
  origin: OpenCodeConfigOrigin,
  rootName: "skill" | "skills",
  relativeDir: string,
  base64Tar: string,
  policy: ReturnType<typeof securityToPolicy>,
): Promise<void> {
  assertPortableRelativePath(relativeDir, "OpenCode skill target path");
  const root = rootForOrigin(origin);
  const target = join(root, rootName, ...relativeDir.split("/"));
  await preflightSkillTarget(root, target);

  const archive = await validateSkillPayload(
    relativeDir,
    target,
    base64Tar,
    policy,
    `opencode/${origin}/${rootName}/${relativeDir}.tar.age`,
  );
  await ensureContainedDirectories(root, target);
  await preflightSkillTarget(root, target);
  await extractArchive(archive, target);
}

async function validateSkillPayload(
  relativeDir: string,
  target: string,
  base64Tar: string,
  policy: ReturnType<typeof securityToPolicy>,
  vaultPath: string,
): Promise<Buffer> {
  const archive = Buffer.from(base64Tar, "base64");
  const { entries, warnings } = await inspectRetainedSkillArchive(archive, {
    label: `OpenCode skill archive '${relativeDir}'`,
    logicalRoot: target,
    expectedName: basename(relativeDir),
    vaultPath,
    policy,
  });
  if (warnings.length > 0) {
    throw new Error(`OpenCode skill archive '${relativeDir}' is unsafe: ${warnings.join("; ")}`);
  }

  for (const entry of entries) {
    assertPortableRelativePath(entry.path, "OpenCode skill archive entry");
    const entryTarget = join(target, ...entry.path.split("/"));
    if (entry.type === "directory") await preflightDirectoryTarget(target, entryTarget);
    else await preflightFileTarget(target, entryTarget);
  }
  return archive;
}

async function preflightOpenCodeBatch(relativeVaultPaths: readonly string[]): Promise<void> {
  assertOpenCodeEnvironment();
  const roots = resolveOpenCodeConfigRoots();
  assertDistinctRoots(roots);
  await assertNoUnsupportedHomeOpenCodeSource(roots);
  const targets = relativeVaultPaths.map((vaultPath) => {
    const target = parseVaultArtifact(vaultPath);
    if (!target) throw new Error(`Unsupported OpenCode vault artifact '${vaultPath}'`);
    return target;
  });
  const logical = new Map<string, string>();
  const physical = new Map<string, { directory: boolean; path: string }>();

  const targetKinds = new Set(targets.map((target) => target.kind));
  for (const kind of ["command", "agent"] as const) {
    if (!targetKinds.has(kind)) continue;
    for (const source of await discoverMarkdownSources(roots, kind)) {
      const identity = source.relativePath.slice(0, -".md".length);
      logical.set(`${kind}:${normalizedIdentity(identity)}`, source.sourcePath);
    }
  }
  if (targetKinds.has("skill")) {
    for (const source of await discoverSkillSources(roots)) {
      logical.set(`skill:${normalizedIdentity(basename(source.relativeDir))}`, source.sourcePath);
    }
  }

  for (const target of targets) {
    const physicalKey = normalizedIdentity(resolve(target.targetPath));
    const existingPhysical = physical.get(physicalKey);
    if (existingPhysical && resolve(existingPhysical.path) !== resolve(target.targetPath)) {
      throw new Error(
        `OpenCode restore target collision: '${existingPhysical.path}' and '${target.targetPath}'`,
      );
    }
    const directory = target.kind === "skill";
    for (const [otherKey, other] of physical) {
      if (
        (!other.directory && physicalKey.startsWith(`${otherKey}${sep}`)) ||
        (!directory && otherKey.startsWith(`${physicalKey}${sep}`))
      ) {
        throw new Error(
          `OpenCode restore target file/directory collision: '${other.path}' and '${target.targetPath}'`,
        );
      }
    }
    physical.set(physicalKey, { directory, path: target.targetPath });

    if (target.kind === "command" || target.kind === "agent" || target.kind === "skill") {
      const identity =
        target.kind === "skill"
          ? basename(target.relativePath)
          : target.relativePath.slice(0, -".md".length);
      const key = `${target.kind}:${normalizedIdentity(identity)}`;
      const existing = logical.get(key);
      if (existing && resolve(existing) !== resolve(target.targetPath)) {
        throw new Error(
          `Duplicate OpenCode ${target.kind} identity '${identity}' in '${existing}' and '${target.targetPath}'`,
        );
      }
      logical.set(key, target.targetPath);
    }

    if (target.kind === "skill") await preflightSkillTarget(target.targetRoot, target.targetPath);
    else await preflightFileTarget(target.targetRoot, target.targetPath);
  }
}

async function preflightOpenCodePayloads(
  artifacts: readonly DecryptedVaultArtifact[],
  policy: ReturnType<typeof securityToPolicy>,
): Promise<void> {
  for (const artifact of artifacts) {
    const target = parseVaultArtifact(artifact.vaultPath);
    if (!target) throw new Error(`Unsupported OpenCode vault artifact '${artifact.vaultPath}'`);
    if (target.kind === "config" || target.kind === "tui") {
      const incoming = parseOpenCodeJsonc(
        artifact.plaintext,
        `OpenCode ${target.relativePath} vault artifact`,
      );
      assertRepresentableConfig(
        incoming,
        target.targetPath,
        target.kind === "tui" ? "tui" : "main",
      );
      const existing = await readRegularTextIfExists(target.targetPath, "OpenCode JSONC target");
      mergeOpenCodeJsonc(existing, artifact.plaintext, target.relativePath, homedir());
      continue;
    }
    if (target.kind === "skill") {
      await validateSkillPayload(
        target.relativePath,
        target.targetPath,
        artifact.plaintext,
        policy,
        artifact.vaultPath,
      );
    }
  }
}

function relativePathFilter(name: string): null | { reason: string } {
  try {
    assertPortableRelativePath(name, "OpenCode vault artifact path");
    return null;
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Declarative explicit-restore plan for stable default/custom vault origins. */
export function buildOpenCodePlan(config?: AgentSyncConfig): ApplyPlan {
  const policy = securityToPolicy(config?.security);
  const directives: ApplyPlan["directives"] = [];
  for (const origin of ["default", "custom"] as const) {
    for (const name of ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"] as const) {
      directives.push(
        defineFileArtifact({
          vaultName: `${origin}/${name}.age`,
          dryRunLabel: `[dry-run] [opencode] would apply ${origin}/${name}`,
          apply: (content) => applyJsoncArtifact(origin, name, content),
        }),
      );
    }
    directives.push(
      defineFileArtifact({
        vaultName: `${origin}/AGENTS.md.age`,
        dryRunLabel: `[dry-run] [opencode] would apply ${origin}/AGENTS.md`,
        apply: (content) =>
          stageContainedWrite(
            rootForOrigin(origin),
            join(rootForOrigin(origin), "AGENTS.md"),
            content,
          ),
      }),
    );
    for (const rootName of ["command", "commands", "agent", "agents"] as const) {
      directives.push({
        kind: "dir",
        subdir: `${origin}/${rootName}`,
        suffix: ".age",
        recursive: true,
        match: (name) => name.endsWith(".md.age"),
        dryRunVerb: `would write ${rootName.startsWith("command") ? "command" : "agent"}:`,
        apply: (name, content) => applyMarkdownArtifact(origin, rootName, name, content),
        filter: relativePathFilter,
      });
    }
    for (const rootName of ["skill", "skills"] as const) {
      directives.push({
        kind: "dir",
        subdir: `${origin}/${rootName}`,
        suffix: ".tar.age",
        recursive: true,
        dryRunVerb: "would extract skill:",
        apply: (name, content) => applySkillArtifact(origin, rootName, name, content, policy),
        filter: relativePathFilter,
      });
    }
  }
  return {
    agent: "opencode",
    directives,
    preflight: preflightOpenCodeBatch,
    preflightPayloads: (artifacts) => preflightOpenCodePayloads(artifacts, policy),
  };
}

export const applyOpenCodeVault = makeApplyVault(buildOpenCodePlan);
