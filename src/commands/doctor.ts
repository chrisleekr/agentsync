import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { formatConfigError, loadConfig, resolveConfigPath } from "../config/loader";
import { AgentPaths } from "../config/paths";
import { type DaemonState, formatAge, readDaemonState } from "../daemon/state";
import { resolveRuntimeContext } from "./shared";

/** Single diagnostic check row rendered by the doctor command. */
export interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/** A successful sync older than this is reported as stale by `doctor`. */
const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

/**
 * Build the daemon sync-health row from the durable state file. A divergence
 * (`stuck`) fails; a stale or never-succeeded last-sync warns ONLY when the
 * daemon is installed (otherwise the user is not relying on auto-sync); a
 * recent success passes. Extracted so the rule is unit-testable.
 */
export async function buildDaemonHealthCheck(daemonInstalled: boolean): Promise<Check> {
  const state: DaemonState = await readDaemonState();
  const name = "Daemon sync health";

  if (state.stuck) {
    return {
      name,
      status: "fail",
      detail: `Auto-sync STUCK (vault diverged). Reset the vault, then it resumes. Last error: ${state.lastError ?? "unknown"}`,
    };
  }

  if (state.lastSuccessAt === null) {
    if (!daemonInstalled) {
      return { name, status: "pass", detail: "Daemon not installed; no auto-sync expected." };
    }
    return {
      name,
      status: "warn",
      detail:
        "Daemon installed but has never recorded a successful sync. Check: agentsync daemon status",
    };
  }

  const ageMs = Date.now() - Date.parse(state.lastSuccessAt);
  if (daemonInstalled && ageMs > STALE_SYNC_MS) {
    return {
      name,
      status: "warn",
      detail: `Last successful sync was ${formatAge(ageMs)} ago (stale). Check: agentsync daemon status`,
    };
  }
  return { name, status: "pass", detail: `Last successful sync ${formatAge(ageMs)} ago.` };
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

/** Inspect local prerequisites, vault health, and service wiring without changing state. */
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

    // 7. Daemon service file exists
    const platform = process.platform;
    let daemonServicePath: string | null = null;
    if (platform === "darwin") {
      daemonServicePath = join(homedir(), "Library", "LaunchAgents", "com.agentsync.daemon.plist");
    } else if (platform === "linux") {
      daemonServicePath = join(homedir(), ".config", "systemd", "user", "agentsync.service");
    }

    let daemonInstalled = false;
    if (daemonServicePath) {
      try {
        await access(daemonServicePath, constants.R_OK);
        daemonInstalled = true;
        checks.push({
          name: "Daemon service file",
          status: "pass",
          detail: daemonServicePath,
        });
      } catch {
        checks.push({
          name: "Daemon service file",
          status: "warn",
          detail: "Not installed. Run: agentsync daemon install",
        });
      }
    }

    // 8. Daemon sync health from the durable state file. A backup daemon that
    // fails silently is the worst failure mode, so surface a stale or stuck
    // last-sync loudly here rather than only on an explicit `daemon status`.
    checks.push(await buildDaemonHealthCheck(daemonInstalled));

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
