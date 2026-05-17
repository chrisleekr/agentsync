import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as currentVersion } from "../../package.json";
import { resolveAgentSyncHome } from "../config/paths";

/** GitHub repo that publishes agentsync releases. */
const REPO = "chrisleekr/agentsync";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Public page from which a standalone binary is replaced by hand. */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

/** How long a successful check is trusted before another network call. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Abort the request rather than stall startup on a slow or dead network. */
const FETCH_TIMEOUT_MS = 3000;

/**
 * How agentsync was installed. Only `npm-global` can be upgraded in place:
 * a `standalone` binary cannot overwrite its own running file, `bunx` already
 * refetches every run, and `dev` is a source checkout updated through git.
 */
export type InstallMethod = "npm-global" | "standalone" | "bunx" | "dev";

interface CacheFile {
  latest: string;
  checkedAt: number;
}

function cachePath(): string {
  return join(resolveAgentSyncHome(), "update-check.json");
}

/**
 * Mirrors the bunx/temp detection in `commands/daemon.ts`. Duplicated rather
 * than imported because `core/` must not depend on a command module.
 */
function isEphemeralPath(filePath: string): boolean {
  if (filePath.includes("bunx-")) return true;
  try {
    return realpathSync(filePath).startsWith(realpathSync(tmpdir()));
  } catch {
    return false;
  }
}

/** Classify the current process so the upgrade action knows what it can do. */
export function detectInstallMethod(): InstallMethod {
  const arg0 = process.argv[0] ?? "";
  const ranThroughBun = arg0.endsWith("bun") || arg0.endsWith("bun.exe");
  // A `bun build --compile` binary runs as itself, not through the bun CLI.
  if (!ranThroughBun) return "standalone";
  const script = process.argv[1] ?? "";
  if (isEphemeralPath(script)) return "bunx";
  if (script.includes("node_modules")) return "npm-global";
  return "dev";
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile;
    if (typeof parsed.latest === "string" && typeof parsed.checkedAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(latest: string): Promise<void> {
  try {
    await mkdir(resolveAgentSyncHome(), { recursive: true });
    const payload: CacheFile = { latest, checkedAt: Date.now() };
    await writeFile(cachePath(), JSON.stringify(payload), "utf8");
  } catch {
    // A cache write failure only costs one extra network call next run.
  }
}

/** Strip a leading `v` from a release tag (`v0.1.9` becomes `0.1.9`). */
function tagToVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

/**
 * True when Bun.semver can compare `v`. Bun.semver.order throws on non-semver
 * input, so a release tag that is not `X.Y.Z` (a manual tag, a date stamp) is
 * rejected here rather than crashing a later comparison or poisoning the cache.
 */
function isComparableVersion(v: string): boolean {
  try {
    Bun.semver.order(v, v);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch the latest published version from GitHub. Returns null on any failure
 * (offline, rate limit, timeout, malformed payload) — an update check must
 * never break startup or a command.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agentsync" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    if (typeof body.tag_name !== "string") return null;
    const version = tagToVersion(body.tag_name);
    // Reject an unparseable tag now so it never reaches the cache or a compare.
    return isComparableVersion(version) ? version : null;
  } catch {
    return null;
  }
}

export interface UpdateStatus {
  /** Version this process is running. */
  current: string;
  /** Latest published version, or null when the check could not complete. */
  latest: string | null;
  /** True only when `latest` is a strictly newer semver than `current`. */
  updateAvailable: boolean;
  method: InstallMethod;
}

/**
 * Resolve the current-versus-latest picture. Uses the 24h cache unless
 * `forceRefresh` is set; a missing or stale cache triggers a network call.
 */
export async function getUpdateStatus(opts?: { forceRefresh?: boolean }): Promise<UpdateStatus> {
  const method = detectInstallMethod();
  let latest: string | null = null;

  if (!opts?.forceRefresh) {
    const cached = await readCache();
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      latest = cached.latest;
    }
  }
  if (latest === null) {
    latest = await fetchLatestVersion();
    if (latest !== null) await writeCache(latest);
  }

  // Guard the compare: `latest` may come from a hand-edited or older-format
  // cache file, and Bun.semver.order throws on anything non-semver.
  const updateAvailable =
    latest !== null && isComparableVersion(latest) && Bun.semver.order(currentVersion, latest) < 0;
  return { current: currentVersion, latest, updateAvailable, method };
}
