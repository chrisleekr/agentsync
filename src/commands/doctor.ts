import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { formatConfigError, loadConfig, resolveConfigPath } from "../config/loader";
import { AgentPaths, resolveAgentSyncHome } from "../config/paths";
import { resolveRuntimeContext } from "./shared";

/** Single diagnostic check row rendered by the doctor command. */
export interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/**
 * Build the readability check rows for the per-agent skills directories
 * introduced by the agent-skills-sync feature. Extracted into its
 * own helper so the rule can be unit-tested without mocking the rest of the
 * doctor pipeline.
 *
 * Each agent gets exactly one row:
 *   - `pass` when the path exists, is a real directory, and is readable
 *   - `warn` when the path does not exist, is unreadable, is a symbolic
 *     link (walker refuses to enumerate symlinked roots), or
 *     exists but is not a directory (e.g. the user accidentally created
 *     `~/.claude/skills` as a regular file instead of a directory)
 *
 * Using `lstat` instead of `stat` keeps this rule in lock-step with the
 * walker at `src/agents/skills-walker.ts:150-151`, which rejects symlinked
 * skills roots silently. Without `lstat`, the doctor would report `pass`
 * for a user who has `~/.claude/skills -> /srv/team-pool`, and `push` would
 * then sync nothing — the two checks must agree.
 *
 * Copilot is intentionally excluded — its skill directory was wired through
 * the original Copilot integration and is therefore covered by the broader
 * Copilot setup, not this feature's new doctor rows.
 */
export async function buildSkillsDirChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const targets: ReadonlyArray<readonly [string, string]> = [
    ["Claude skills directory", AgentPaths.claude.skillsDir],
    ["Codex skills directory", AgentPaths.codex.skillsDir],
    ["Cursor skills directory", AgentPaths.cursor.skillsDir],
  ];

  for (const [name, dir] of targets) {
    try {
      await access(dir, constants.R_OK);
      const info = await lstat(dir);
      if (info.isSymbolicLink()) {
        checks.push({
          name,
          status: "warn",
          detail: `Symlinked skills root is not synced: ${dir}`,
        });
        continue;
      }
      if (!info.isDirectory()) {
        checks.push({
          name,
          status: "warn",
          detail: `Exists but is not a directory: ${dir}`,
        });
        continue;
      }
      checks.push({ name, status: "pass", detail: dir });
    } catch {
      checks.push({
        name,
        status: "warn",
        detail: `Not found or unreadable: ${dir}`,
      });
    }
  }

  return checks;
}

// These identifiers came from daemon installers through v0.1.14. Their
// defining modules were removed in #192, so detection keeps the literals here.
const LEGACY_LAUNCHD_LABEL = "com.agentsync.daemon";
const LEGACY_SYSTEMD_UNIT = "agentsync";
const LEGACY_WINDOWS_TASK = "AgentSync";

type LegacyDaemonQueryExecutor = (command: string, args: readonly string[]) => Promise<unknown>;

interface LegacyDaemonCheckOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  agentSyncHome?: string;
  queryExecutor?: LegacyDaemonQueryExecutor;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isWindowsTaskMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  if (typeof error.code !== "number") return false;
  const code = error.code >>> 0;
  return code === 2 || code === 0x80070002;
}

/** Detect files and registrations left by daemon installers without changing them. */
export async function buildLegacyDaemonCheck({
  platform = process.platform,
  homeDir = homedir(),
  agentSyncHome = resolveAgentSyncHome(),
  queryExecutor = async (command, args) => {
    await promisify(execFile)(command, [...args]);
  },
}: LegacyDaemonCheckOptions = {}): Promise<Check> {
  const name = "Legacy daemon leftovers";
  const found: string[] = [];

  if (platform === "darwin") {
    const plist = join(homeDir, "Library", "LaunchAgents", `${LEGACY_LAUNCHD_LABEL}.plist`);
    if (await pathExists(plist)) {
      found.push(
        `LaunchAgent ${plist} — remove with: launchctl bootout gui/$(id -u)/${LEGACY_LAUNCHD_LABEL}; rm -- ${quotePosixArg(plist)}`,
      );
    }
  } else if (platform === "linux") {
    const unit = join(homeDir, ".config", "systemd", "user", `${LEGACY_SYSTEMD_UNIT}.service`);
    if (await pathExists(unit)) {
      found.push(
        `systemd unit ${unit} — remove with: systemctl --user disable --now ${LEGACY_SYSTEMD_UNIT}; rm -- ${quotePosixArg(unit)}; systemctl --user daemon-reload`,
      );
    }
  } else if (platform === "win32") {
    try {
      await queryExecutor("schtasks", ["/Query", "/TN", LEGACY_WINDOWS_TASK, "/HResult"]);
      found.push(
        `Scheduled task ${LEGACY_WINDOWS_TASK} — run separately: schtasks /End /TN ${LEGACY_WINDOWS_TASK}, then schtasks /Delete /TN ${LEGACY_WINDOWS_TASK} /F`,
      );
    } catch (error) {
      if (!isWindowsTaskMissing(error)) {
        found.push(
          `Could not inspect scheduled task ${LEGACY_WINDOWS_TASK} — run manually: schtasks /Query /TN ${LEGACY_WINDOWS_TASK}`,
        );
      }
    }
  }

  if (platform !== "win32") {
    const socket = join(agentSyncHome, "daemon.sock");
    if (await pathExists(socket)) {
      found.push(`Stale IPC socket ${socket} — remove with: rm -- ${quotePosixArg(socket)}`);
    }
  }

  if (found.length === 0) {
    return {
      name,
      status: "pass",
      detail: "No pre-0.2.0 daemon registration found.",
    };
  }

  return { name, status: "warn", detail: found.join(" | ") };
}

/** Inspect local prerequisites and vault health without changing state. */
export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Run environment diagnostics",
  },
  async run() {
    const checks: Check[] = [];
    const runtime = await resolveRuntimeContext();

    // 1. Private key exists and has correct permissions
    try {
      const info = await stat(runtime.privateKeyPath);
      const mode = info.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        checks.push({
          name: "Private key permissions",
          status: "warn",
          detail: `Expected 600, got ${mode.toString(8)}. Fix: chmod 600 ${runtime.privateKeyPath}`,
        });
      } else {
        checks.push({
          name: "Private key permissions",
          status: "pass",
          detail: `${runtime.privateKeyPath} (mode ${mode.toString(8)})`,
        });
      }
    } catch {
      checks.push({
        name: "Private key",
        status: "fail",
        detail: "Missing. Run: agentsync init --remote <url>",
      });
    }

    // 2. age-encryption module loads
    try {
      await import("age-encryption");
      checks.push({
        name: "age-encryption module",
        status: "pass",
        detail: "Resolves OK",
      });
    } catch (error) {
      checks.push({
        name: "age-encryption module",
        status: "fail",
        detail: `Failed: ${String(error)}`,
      });
    }

    // 3. Claude settings.json readable
    try {
      await access(AgentPaths.claude.settingsJson, constants.R_OK);
      checks.push({
        name: "Claude settings.json",
        status: "pass",
        detail: "Readable",
      });
    } catch {
      checks.push({
        name: "Claude settings.json",
        status: "warn",
        detail: "Not found or unreadable. Claude hook/MCP sync may be partial.",
      });
    }

    // 3a. Per-agent skills directory readability checks. Delegated to a
    // testable helper so the rule has its own unit test.
    checks.push(...(await buildSkillsDirChecks()));

    // 4. Vault config parses correctly against schema
    try {
      const configPath = resolveConfigPath(runtime.vaultDir);
      await loadConfig(configPath);
      checks.push({
        name: "agentsync.toml schema",
        status: "pass",
        detail: configPath,
      });
    } catch (err) {
      checks.push({
        name: "agentsync.toml schema",
        status: "fail",
        detail: formatConfigError(err, resolveConfigPath(runtime.vaultDir)),
      });
    }

    // 5. Git remote reachable (ls-remote)
    try {
      const config = await loadConfig(resolveConfigPath(runtime.vaultDir));
      await promisify(execFile)("git", ["ls-remote", "--exit-code", config.remote.url, "HEAD"], {
        timeout: 10_000,
      });
      checks.push({
        name: "Git remote reachable",
        status: "pass",
        detail: config.remote.url,
      });
    } catch {
      checks.push({
        name: "Git remote reachable",
        status: "warn",
        detail: "Cannot reach remote. Check network / SSH keys.",
      });
    }

    // 6. No credential files in vault (security check)
    const credentialPatterns = ["credentials", "auth.json", ".env", "token"];
    try {
      const allFiles: string[] = [];
      const scanDir = async (dir: string) => {
        const names = await readdir(dir).catch(() => []);
        for (const name of names) {
          const fullPath = join(dir, name);
          const entry = await stat(fullPath).catch(() => null);
          if (!entry) {
            continue;
          }
          if (entry.isDirectory()) {
            await scanDir(fullPath);
          } else {
            allFiles.push(relative(runtime.vaultDir, fullPath).toLowerCase());
          }
        }
      };
      await scanDir(runtime.vaultDir);
      const suspicious = allFiles.filter(
        (f) => credentialPatterns.some((p) => f.includes(p)) && !f.endsWith(".age"),
      );
      if (suspicious.length > 0) {
        checks.push({
          name: "Credential files in vault",
          status: "fail",
          detail: `Unencrypted sensitive files found: ${suspicious.join(", ")}`,
        });
      } else {
        checks.push({
          name: "Credential files in vault",
          status: "pass",
          detail: "None found",
        });
      }
    } catch {
      checks.push({
        name: "Credential files in vault",
        status: "warn",
        detail: "Could not scan vault",
      });
    }

    // 7. No service artifacts left by the removed background daemon
    checks.push(await buildLegacyDaemonCheck());

    // Print results
    // biome-ignore lint/suspicious/noConsole: intentional CLI tabular output
    console.table(checks);

    const hasFailure = checks.some((c) => c.status === "fail");
    const hasWarn = checks.some((c) => c.status === "warn");
    if (hasFailure) {
      log.error("Result: FAIL — action required.");
      process.exitCode = 1;
    } else if (hasWarn) {
      log.warn("Result: WARN — some checks need attention.");
    } else {
      log.success("Result: All checks passed.");
    }
  },
});
