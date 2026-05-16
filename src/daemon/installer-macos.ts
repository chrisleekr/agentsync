/**
 * macOS launchd service installer for the AgentSync daemon.
 *
 * Installs/uninstalls a LaunchAgent plist at:
 *   ~/Library/LaunchAgents/com.agentsync.daemon.plist
 *
 * fs/promises and child_process are wired through `fsImpl` / `execImpl`
 * private slots so the test suite can inject map-backed stubs without
 * relying on Bun's `mock.module()`. See installer-linux.ts for the
 * detailed rationale.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "@clack/prompts";

type FsImpl = {
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rm: typeof rm;
  writeFile: typeof writeFile;
};

type ExecImpl = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>;

const realExecFileAsync = promisify(execFile);
const realFs: FsImpl = { mkdir, readFile, rm, writeFile };
const realExec: ExecImpl = async (cmd, args, opts) => {
  const r = (await realExecFileAsync(cmd, args, opts)) as {
    stdout: string | Buffer;
    stderr: string | Buffer;
  };
  return {
    stdout: typeof r.stdout === "string" ? r.stdout : r.stdout.toString("utf8"),
    stderr: typeof r.stderr === "string" ? r.stderr : r.stderr.toString("utf8"),
  };
};

// See installer-linux.ts for why this lives on globalThis instead of a
// per-module closure slot.
const SLOT = "__agentsyncInstallerMacOsTestImpl";
type Slot = { fs?: FsImpl | null; exec?: ExecImpl | null } | undefined;

function fsImpl(): FsImpl {
  return (globalThis as Record<string, unknown>)[SLOT] !== undefined
    ? (((globalThis as Record<string, unknown>)[SLOT] as { fs?: FsImpl | null }).fs ?? realFs)
    : realFs;
}
function execImpl(): ExecImpl {
  return (globalThis as Record<string, unknown>)[SLOT] !== undefined
    ? (((globalThis as Record<string, unknown>)[SLOT] as { exec?: ExecImpl | null }).exec ??
        realExec)
    : realExec;
}

/** @internal Test-only hook. Pass `{ fs: null, exec: null }` to restore. */
export function __setInstallerMacOsImplForTests(deps: {
  fs?: FsImpl | null;
  exec?: ExecImpl | null;
}): void {
  (globalThis as unknown as Record<string, Slot>)[SLOT] = deps;
}

// Public-function override slot — see installer-linux.ts for the rationale.
const FN_SLOT = "__agentsyncInstallerMacOsPublicOverrides";
type PublicOverrides = Partial<{
  installMacOs: typeof installMacOs;
  uninstallMacOs: typeof uninstallMacOs;
  startMacOs: typeof startMacOs;
  stopMacOs: typeof stopMacOs;
  isInstalledMacOs: typeof isInstalledMacOs;
  isRegisteredMacOs: typeof isRegisteredMacOs;
}>;

function getOverride<K extends keyof PublicOverrides>(name: K): PublicOverrides[K] | undefined {
  return (globalThis as unknown as Record<string, PublicOverrides | undefined>)[FN_SLOT]?.[name];
}

/** @internal Test-only hook. Pass `{}` to clear overrides. */
export function __setInstallerMacOsOverridesForTests(overrides: PublicOverrides): void {
  (globalThis as unknown as Record<string, PublicOverrides>)[FN_SLOT] = overrides;
}

/** Escape a string for safe inclusion in XML text content. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const PLIST_LABEL = "com.agentsync.daemon";
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, `${PLIST_LABEL}.plist`);

/**
 * Build the launchd plist for the given executable args array and log directory.
 * Each element of `args` plus the `daemon _run` subcommand is emitted as a
 * separate `<string>` entry — required by launchd.plist(5). A single space-joined
 * string in ProgramArguments[0] is interpreted as the literal binary path and will
 * cause EX_CONFIG (78) on every spawn attempt.
 */
export function buildPlist(args: string[], logDir: string): string {
  const stdoutLog = join(logDir, "agentsync.out.log");
  const stderrLog = join(logDir, "agentsync.err.log");

  const programArgs = [...args, "daemon", "_run"]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${stdoutLog}</string>

  <key>StandardErrorPath</key>
  <string>${stderrLog}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * Extract the service manager's stderr from an error object.
 * Returns only the launchctl stderr line — never an internal stack trace.
 */
export function extractServiceManagerError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) {
      return stderr.trim();
    }
  }
  return String(err);
}

/**
 * Install and bootstrap the macOS LaunchAgent that runs the daemon.
 * Uses bootout → write plist → bootstrap so re-running is idempotent
 * (avoids "Bootstrap failed: 5" on already-registered services).
 */
export async function installMacOs(args: string[]): Promise<void> {
  const override = getOverride("installMacOs");
  if (override) return override(args);
  const logDir = join(homedir(), "Library", "Logs", "AgentSync");

  await fsImpl().mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  await fsImpl().mkdir(logDir, { recursive: true });

  // Bootout first — ignore errors (service may not be loaded)
  try {
    await execImpl()("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
  } catch {
    // Not loaded — expected on first install
  }

  const plist = buildPlist(args, logDir);

  await fsImpl().writeFile(PLIST_PATH, plist, "utf8");

  try {
    await execImpl()("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
  } catch (err) {
    const msg = extractServiceManagerError(err);
    throw new Error(
      `launchd bootstrap failed: ${msg}\nHint: Check that the executable path exists and is not in a temporary directory.`,
    );
  }

  log.success(`Installed launchd service: ${PLIST_LABEL}`);
  log.info(`Plist: ${PLIST_PATH}`);
}

/** Boot out and remove the macOS LaunchAgent definition if it exists. */
export async function uninstallMacOs(): Promise<void> {
  const override = getOverride("uninstallMacOs");
  if (override) return override();
  try {
    await execImpl()("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
  } catch {
    // Service may not be loaded — ignore
  }

  try {
    await fsImpl().rm(PLIST_PATH, { force: true });
  } catch {
    // Already removed
  }

  log.success(`Removed launchd service: ${PLIST_LABEL}`);
}

/**
 * Check whether the macOS LaunchAgent is currently registered with launchd.
 * Runs `launchctl print gui/<uid>/com.agentsync.daemon`; returns true on exit code 0.
 */
export async function isRegisteredMacOs(): Promise<boolean> {
  const override = getOverride("isRegisteredMacOs");
  if (override) return override();
  try {
    await execImpl()("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restart the macOS LaunchAgent immediately.
 * Verifies the service is registered first; applies a 10-second hard timeout on kickstart.
 */
export async function startMacOs(): Promise<void> {
  const override = getOverride("startMacOs");
  if (override) return override();
  if (!(await isRegisteredMacOs())) {
    throw new Error("Service not bootstrapped — run `agentsync daemon install` first.");
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    await execImpl()(
      "launchctl",
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`],
      { signal: controller.signal },
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Service manager start timed out.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Ask launchd to stop the macOS daemon process. */
export async function stopMacOs(): Promise<void> {
  const override = getOverride("stopMacOs");
  if (override) return override();
  await execImpl()("launchctl", [
    "kill",
    "SIGTERM",
    `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`,
  ]);
}

/** Check whether the macOS LaunchAgent plist is present on disk. */
export async function isInstalledMacOs(): Promise<boolean> {
  const override = getOverride("isInstalledMacOs");
  if (override) return override();
  try {
    await fsImpl().readFile(PLIST_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
