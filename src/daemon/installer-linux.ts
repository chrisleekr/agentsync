/**
 * Linux systemd user unit installer for the AgentSync daemon.
 *
 * Installs/uninstalls a user service at:
 *   ~/.config/systemd/user/agentsync.service
 *
 * fs/promises and child_process are wired through `fsImpl` / `execImpl`
 * private slots so the test suite can inject map-backed stubs without
 * relying on `mock.module()`. Bun's mock layer does not retro-update
 * module bindings already captured by a cached importer (e.g. when
 * daemon.test.ts loads installer-linux before installer-linux.test.ts
 * mocks fs/promises), so direct injection is the only reliable path.
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

// Inject through globalThis instead of a module-local slot so this works
// even when Bun's import cache hands two different test files separate
// instances of this module — they all read from the same global. The
// per-instance closure was unreliable on CI.
const SLOT = "__agentsyncInstallerLinuxTestImpl";
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
export function __setInstallerLinuxImplForTests(deps: {
  fs?: FsImpl | null;
  exec?: ExecImpl | null;
}): void {
  (globalThis as unknown as Record<string, Slot>)[SLOT] = deps;
}

const SERVICE_NAME = "agentsync";
const SYSTEMD_USER_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_PATH = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);

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
    const { stdout } = await execImpl()("systemctl", ["--user", "is-enabled", SERVICE_NAME]);
    return stdout.trim() === "enabled";
  } catch {
    return false;
  }
}

/**
 * Install and start the Linux user service that runs the daemon in the background.
 */
export async function installLinux(args: string[]): Promise<void> {
  await fsImpl().mkdir(SYSTEMD_USER_DIR, { recursive: true });
  const unit = buildUnit(args);
  await fsImpl().writeFile(SERVICE_PATH, unit, "utf8");

  await execImpl()("systemctl", ["--user", "daemon-reload"]);
  await execImpl()("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  log.success(`Installed systemd user service: ${SERVICE_NAME}`);
  log.info(`Unit file: ${SERVICE_PATH}`);
}

/** Stop and remove the Linux user service definition if it exists. */
export async function uninstallLinux(): Promise<void> {
  try {
    await execImpl()("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
  } catch {
    // Not running or not enabled — ignore
  }

  try {
    await fsImpl().rm(SERVICE_PATH, { force: true });
  } catch {
    // Already removed
  }

  try {
    await execImpl()("systemctl", ["--user", "daemon-reload"]);
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
    await execImpl()("systemctl", ["--user", "start", SERVICE_NAME], {
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
  await execImpl()("systemctl", ["--user", "stop", SERVICE_NAME]);
}

/** Check whether the Linux user service file is present on disk. */
export async function isInstalledLinux(): Promise<boolean> {
  try {
    await fsImpl().readFile(SERVICE_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}
