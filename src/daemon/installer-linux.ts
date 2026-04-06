/**
 * Linux systemd user unit installer for the AgentSync daemon.
 *
 * Installs/uninstalls a user service at:
 *   ~/.config/systemd/user/agentsync.service
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "@clack/prompts";

const execFileAsync = promisify(execFile);

const SERVICE_NAME = "agentsync";
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_PATH = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);

/**
 * Build the systemd unit text for the given executable args array.
 * systemd tokenises ExecStart by spaces, so joining args is safe here;
 * the array form is used for interface consistency with macOS and Windows.
 */
export function buildUnit(args: string[]): string {
  const execStart = [...args, "daemon", "_run"].join(" ");
  return `[Unit]
Description=AgentSync daemon — encrypts and syncs AI agent configs
After=network.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;
}

/**
 * Check whether the Linux user service is registered with systemd.
 * Returns true only when `systemctl --user is-enabled agentsync` outputs "enabled".
 */
export async function isRegisteredLinux(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("systemctl", ["--user", "is-enabled", SERVICE_NAME]);
    return stdout.trim() === "enabled";
  } catch {
    return false;
  }
}

/**
 * Install and start the Linux user service that runs the daemon in the background.
 */
export async function installLinux(args: string[]): Promise<void> {
  await mkdir(SYSTEMD_USER_DIR, { recursive: true });
  const unit = buildUnit(args);
  await writeFile(SERVICE_PATH, unit, "utf8");

  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  log.success(`Installed systemd user service: ${SERVICE_NAME}`);
  log.info(`Unit file: ${SERVICE_PATH}`);
}

/** Stop and remove the Linux user service definition if it exists. */
export async function uninstallLinux(): Promise<void> {
  try {
    await execFileAsync("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
  } catch {
    // Not running or not enabled — ignore
  }

  try {
    await rm(SERVICE_PATH, { force: true });
  } catch {
    // Already removed
  }

  try {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  } catch {
    // Best effort
  }

  log.success(`Removed systemd user service: ${SERVICE_NAME}`);
}

/**
 * Start the installed Linux user service.
 * Verifies registration first; applies a 10-second timeout on the start call.
 */
export async function startLinux(): Promise<void> {
  if (!(await isRegisteredLinux())) {
    throw new Error("Service not bootstrapped — run `agentsync daemon install` first.");
  }
  await Promise.race([
    execFileAsync("systemctl", ["--user", "start", SERVICE_NAME]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Service manager start timed out.")), 10_000),
    ),
  ]);
}

/** Stop the installed Linux user service. */
export async function stopLinux(): Promise<void> {
  await execFileAsync("systemctl", ["--user", "stop", SERVICE_NAME]);
}

/** Check whether the Linux user service file is present on disk. */
export async function isInstalledLinux(): Promise<boolean> {
  try {
    await readFile(SERVICE_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
