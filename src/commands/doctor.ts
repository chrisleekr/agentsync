import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { loadConfig, resolveConfigPath } from "../config/loader";
import { AgentPaths } from "../config/paths";
import { resolveRuntimeContext } from "./shared";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

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
        detail: `Invalid: ${String(err)}`,
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

    if (daemonServicePath) {
      try {
        await access(daemonServicePath, constants.R_OK);
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
