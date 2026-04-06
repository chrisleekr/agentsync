/**
 * macOS launchd service installer for the AgentSync daemon.
 *
 * Installs/uninstalls a LaunchAgent plist at:
 *   ~/Library/LaunchAgents/com.agentsync.daemon.plist
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "@clack/prompts";

const execFileAsync = promisify(execFile);

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
    .map((a) => `    <string>${a}</string>`)
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
  const logDir = join(homedir(), "Library", "Logs", "AgentSync");
  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  await mkdir(logDir, { recursive: true });

  // Bootout first — ignore errors (service may not be loaded)
  try {
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
  } catch {
    // Not loaded — expected on first install
  }

  const plist = buildPlist(args, logDir);
  await writeFile(PLIST_PATH, plist, "utf8");

  try {
    await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
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
  try {
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
  } catch {
    // Service may not be loaded — ignore
  }

  try {
    await rm(PLIST_PATH, { force: true });
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
  try {
    await execFileAsync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`]);
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
  if (!(await isRegisteredMacOs())) {
    throw new Error("Service not bootstrapped — run `agentsync daemon install` first.");
  }
  await Promise.race([
    execFileAsync("launchctl", [
      "kickstart",
      "-k",
      `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`,
    ]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Service manager start timed out.")), 10_000),
    ),
  ]);
}

/** Ask launchd to stop the macOS daemon process. */
export async function stopMacOs(): Promise<void> {
  await execFileAsync("launchctl", [
    "kill",
    "SIGTERM",
    `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`,
  ]);
}

/** Check whether the macOS LaunchAgent plist is present on disk. */
export async function isInstalledMacOs(): Promise<boolean> {
  try {
    await readFile(PLIST_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
