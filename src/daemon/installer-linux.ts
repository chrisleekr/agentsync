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

function buildUnit(executablePath: string): string {
  return `[Unit]
Description=AgentSync daemon — encrypts and syncs AI agent configs
After=network.target

[Service]
Type=simple
ExecStart=${executablePath} daemon _run
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;
}

export async function installLinux(executablePath: string): Promise<void> {
  await mkdir(SYSTEMD_USER_DIR, { recursive: true });
  const unit = buildUnit(executablePath);
  await writeFile(SERVICE_PATH, unit, "utf8");

  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  log.success(`Installed systemd user service: ${SERVICE_NAME}`);
  log.info(`Unit file: ${SERVICE_PATH}`);
}

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

export async function startLinux(): Promise<void> {
  await execFileAsync("systemctl", ["--user", "start", SERVICE_NAME]);
}

export async function stopLinux(): Promise<void> {
  await execFileAsync("systemctl", ["--user", "stop", SERVICE_NAME]);
}

export async function isInstalledLinux(): Promise<boolean> {
  try {
    await readFile(SERVICE_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
