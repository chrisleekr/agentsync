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

function buildPlist(executablePath: string, logDir: string): string {
  const stdoutLog = join(logDir, "agentsync.out.log");
  const stderrLog = join(logDir, "agentsync.err.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${executablePath}</string>
    <string>daemon</string>
    <string>_run</string>
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

export async function installMacOs(executablePath: string): Promise<void> {
  const logDir = join(homedir(), "Library", "Logs", "AgentSync");
  await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const plist = buildPlist(executablePath, logDir);
  await writeFile(PLIST_PATH, plist, "utf8");

  await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, PLIST_PATH]);
  log.success(`Installed launchd service: ${PLIST_LABEL}`);
  log.info(`Plist: ${PLIST_PATH}`);
}

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

export async function startMacOs(): Promise<void> {
  await execFileAsync("launchctl", [
    "kickstart",
    "-k",
    `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`,
  ]);
}

export async function stopMacOs(): Promise<void> {
  await execFileAsync("launchctl", [
    "kill",
    "SIGTERM",
    `gui/${process.getuid?.() ?? 501}/${PLIST_LABEL}`,
  ]);
}

export async function isInstalledMacOs(): Promise<boolean> {
  try {
    await readFile(PLIST_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
