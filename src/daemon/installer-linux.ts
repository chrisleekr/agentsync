/**
 * Linux systemd user unit installer for the AgentSync daemon.
 *
 * Installs/uninstalls a user service at:
 *   ~/.config/systemd/user/agentsync.service
 *
 * fs/promises and child_process are pulled in via dynamic import inside
 * each function rather than at the top of the file. Top-level destructured
 * imports cache the resolved functions at first module load — Bun's
 * mock.module() then has nothing to update when a test suite registers
 * its own fs/promises mock against an already-cached installer module.
 * Dynamic imports look up the current binding on every call, which is
 * what the test mocks rely on.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@clack/prompts";

const SERVICE_NAME = "agentsync";
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_PATH = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);

async function fsp(): Promise<typeof import("node:fs/promises")> {
  return await import("node:fs/promises");
}

async function execFileAsync(
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const r = (await promisify(execFile)(cmd, args, opts)) as {
    stdout: string | Buffer;
    stderr: string | Buffer;
  };
  return {
    stdout: typeof r.stdout === "string" ? r.stdout : r.stdout.toString("utf8"),
    stderr: typeof r.stderr === "string" ? r.stderr : r.stderr.toString("utf8"),
  };
}

/**
 * Quote a single argument for systemd ExecStart per systemd.syntax(7).
 * Wraps in double quotes and applies C-style escaping for `\` and `"`.
 */
function quoteSystemdArg(arg: string): string {
  return `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the systemd unit text for the given executable args array.
 * Each argument is individually quoted per systemd.syntax(7) to correctly
 * handle paths containing spaces or special characters.
 */
export function buildUnit(args: string[]): string {
  const execStart = [...args, "daemon", "_run"].map(quoteSystemdArg).join(" ");
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
  const { mkdir, writeFile } = await fsp();
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
    const { rm } = await fsp();
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    await execFileAsync("systemctl", ["--user", "start", SERVICE_NAME], {
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Service manager start timed out.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Stop the installed Linux user service. */
export async function stopLinux(): Promise<void> {
  await execFileAsync("systemctl", ["--user", "stop", SERVICE_NAME]);
}

/** Check whether the Linux user service file is present on disk. */
export async function isInstalledLinux(): Promise<boolean> {
  try {
    const { readFile } = await fsp();
    await readFile(SERVICE_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
