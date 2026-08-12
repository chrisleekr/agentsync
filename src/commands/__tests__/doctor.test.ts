/** Unit tests for doctor check builders that do not need the full CLI pipeline. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { createTmpDir } from "../../test-helpers/fixtures";
import { buildLegacyDaemonCheck, buildSkillsDirChecks } from "../doctor";

type MutablePaths = {
  claude: { skillsDir: string };
  codex: { skillsDir: string };
  cursor: { skillsDir: string };
};
const mutablePaths = AgentPaths as unknown as MutablePaths;

describe("buildSkillsDirChecks", () => {
  let tmpDir: string;
  const saved = {
    claude: mutablePaths.claude.skillsDir,
    codex: mutablePaths.codex.skillsDir,
    cursor: mutablePaths.cursor.skillsDir,
  };

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    mutablePaths.claude.skillsDir = saved.claude;
    mutablePaths.codex.skillsDir = saved.codex;
    mutablePaths.cursor.skillsDir = saved.cursor;
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns one row per supported agent", async () => {
    // Point all three at non-existent paths.
    mutablePaths.claude.skillsDir = join(tmpDir, "missing-claude");
    mutablePaths.codex.skillsDir = join(tmpDir, "missing-codex");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    expect(rows).toHaveLength(3);
    const names = rows.map((r) => r.name);
    expect(names).toContain("Claude skills directory");
    expect(names).toContain("Codex skills directory");
    expect(names).toContain("Cursor skills directory");
  });

  test("reports `pass` when a skills directory is readable", async () => {
    const claudeDir = join(tmpDir, "claude-skills");
    const codexDir = join(tmpDir, "codex-skills");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    mutablePaths.claude.skillsDir = claudeDir;
    mutablePaths.codex.skillsDir = codexDir;
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    const claudeRow = rows.find((r) => r.name === "Claude skills directory");
    const codexRow = rows.find((r) => r.name === "Codex skills directory");
    expect(claudeRow?.status).toBe("pass");
    expect(claudeRow?.detail).toBe(claudeDir);
    expect(codexRow?.status).toBe("pass");
    expect(codexRow?.detail).toBe(codexDir);
  });

  test("reports `warn` when a skills directory is missing", async () => {
    mutablePaths.claude.skillsDir = join(tmpDir, "missing-claude");
    mutablePaths.codex.skillsDir = join(tmpDir, "missing-codex");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    expect(rows.every((r) => r.status === "warn")).toBe(true);
    for (const r of rows) {
      expect(r.detail).toContain("Not found or unreadable");
    }
  });

  test("does NOT include a Copilot row (Copilot is wired through other paths)", async () => {
    mutablePaths.claude.skillsDir = join(tmpDir, "missing");
    mutablePaths.codex.skillsDir = join(tmpDir, "missing");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing");

    const rows = await buildSkillsDirChecks();
    expect(rows.find((r) => r.name.toLowerCase().includes("copilot"))).toBeUndefined();
  });

  // Phase 8 L1 — guard against a misconfigured skillsDir that is a regular
  // file, not a directory. `access(R_OK)` alone passes in that case, so a
  // bare readability check would produce a false-positive `pass` row.
  test("reports `warn` when a skills path exists but is not a directory", async () => {
    const claudeFile = join(tmpDir, "claude-skills-is-a-file");
    writeFileSync(claudeFile, "oops — this should be a directory", "utf8");
    mutablePaths.claude.skillsDir = claudeFile;
    mutablePaths.codex.skillsDir = join(tmpDir, "missing-codex");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    const claudeRow = rows.find((r) => r.name === "Claude skills directory");
    expect(claudeRow?.status).toBe("warn");
    expect(claudeRow?.detail).toContain("not a directory");
  });

  // Parity with the walker's symlink-rejection rule. The walker refuses to
  // enumerate a skills root that is itself a symlink, so doctor must not
  // report `pass` for that same layout. Using `stat` alone would follow the
  // link and see a real directory, hiding the walker's silent refusal from
  // the user.
  test("reports `warn` when a skills path is a symlink", async () => {
    const realRoot = join(tmpDir, "real-claude-skills");
    mkdirSync(realRoot, { recursive: true });
    const linkedRoot = join(tmpDir, "linked-claude-skills");
    await symlink(realRoot, linkedRoot);

    mutablePaths.claude.skillsDir = linkedRoot;
    mutablePaths.codex.skillsDir = join(tmpDir, "missing-codex");
    mutablePaths.cursor.skillsDir = join(tmpDir, "missing-cursor");

    const rows = await buildSkillsDirChecks();
    const claudeRow = rows.find((r) => r.name === "Claude skills directory");
    expect(claudeRow?.status).toBe("warn");
    expect(claudeRow?.detail).toContain("Symlinked skills root");
  });
});

type QueryExecutor = (command: string, args: readonly string[]) => Promise<void>;

describe("buildLegacyDaemonCheck", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("warns with exact removal guidance for a macOS LaunchAgent without removing it", async () => {
    const homeDir = join(tmpDir, "home");
    const agentSyncHome = join(homeDir, ".config", "agentsync");
    const plist = join(homeDir, "Library", "LaunchAgents", "com.agentsync.daemon.plist");
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, "legacy launch agent\n", "utf8");
    const queries: Array<readonly [string, readonly string[]]> = [];
    const queryExecutor: QueryExecutor = async (command, args) => {
      queries.push([command, args]);
    };

    const row = await buildLegacyDaemonCheck({
      platform: "darwin",
      homeDir,
      agentSyncHome,
      queryExecutor,
    });

    expect(row).toEqual({
      name: "Legacy daemon leftovers",
      status: "warn",
      detail:
        `LaunchAgent ${plist} — remove with: ` +
        `launchctl bootout gui/$(id -u)/com.agentsync.daemon; rm -- '${plist}'`,
    });
    expect(queries).toEqual([]);
    expect(readFileSync(plist, "utf8")).toBe("legacy launch agent\n");
  });

  test("warns with exact removal guidance for a Linux user unit without removing it", async () => {
    const homeDir = join(tmpDir, "home");
    const agentSyncHome = join(homeDir, ".config", "agentsync");
    const unit = join(homeDir, ".config", "systemd", "user", "agentsync.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "legacy user unit\n", "utf8");
    const queries: Array<readonly [string, readonly string[]]> = [];
    const queryExecutor: QueryExecutor = async (command, args) => {
      queries.push([command, args]);
    };

    const row = await buildLegacyDaemonCheck({
      platform: "linux",
      homeDir,
      agentSyncHome,
      queryExecutor,
    });

    expect(row).toEqual({
      name: "Legacy daemon leftovers",
      status: "warn",
      detail:
        `systemd unit ${unit} — remove with: ` +
        `systemctl --user disable --now agentsync; rm -- '${unit}'; ` +
        "systemctl --user daemon-reload",
    });
    expect(queries).toEqual([]);
    expect(readFileSync(unit, "utf8")).toBe("legacy user unit\n");
  });

  test("queries and warns with exact removal guidance for a Windows scheduled task", async () => {
    const queries: Array<readonly [string, readonly string[]]> = [];
    const queryExecutor: QueryExecutor = async (command, args) => {
      queries.push([command, args]);
    };

    const row = await buildLegacyDaemonCheck({
      platform: "win32",
      homeDir: join(tmpDir, "home"),
      agentSyncHome: join(tmpDir, "agentsync"),
      queryExecutor,
    });

    expect(queries).toEqual([["schtasks", ["/Query", "/TN", "AgentSync", "/HResult"]]]);
    expect(row).toEqual({
      name: "Legacy daemon leftovers",
      status: "warn",
      detail:
        "Scheduled task AgentSync — run separately: schtasks /End /TN AgentSync, then " +
        "schtasks /Delete /TN AgentSync /F",
    });
  });

  test("treats an absent Windows scheduled task as a passing check without throwing", async () => {
    const queries: Array<readonly [string, readonly string[]]> = [];
    const queryExecutor: QueryExecutor = async (command, args) => {
      queries.push([command, args]);
      throw Object.assign(new Error("ERROR: The system cannot find the file specified."), {
        code: 2,
      });
    };

    const row = await buildLegacyDaemonCheck({
      platform: "win32",
      homeDir: join(tmpDir, "home"),
      agentSyncHome: join(tmpDir, "agentsync"),
      queryExecutor,
    });

    expect(queries).toEqual([["schtasks", ["/Query", "/TN", "AgentSync", "/HResult"]]]);
    expect(row).toEqual({
      name: "Legacy daemon leftovers",
      status: "pass",
      detail: "No pre-0.2.0 daemon registration found.",
    });
  });

  test("warns when the Windows scheduled task cannot be inspected", async () => {
    const queryExecutor: QueryExecutor = async () => {
      throw Object.assign(new Error("Access is denied."), { code: 5 });
    };

    const row = await buildLegacyDaemonCheck({
      platform: "win32",
      homeDir: join(tmpDir, "home"),
      agentSyncHome: join(tmpDir, "agentsync"),
      queryExecutor,
    });

    expect(row).toEqual({
      name: "Legacy daemon leftovers",
      status: "warn",
      detail:
        "Could not inspect scheduled task AgentSync — run manually: " +
        "schtasks /Query /TN AgentSync",
    });
  });

  test("warns for the default non-Windows AgentSync home socket without deleting it", async () => {
    const homeDir = join(tmpDir, "home");
    const agentSyncHome = join(homeDir, ".config", "agentsync");
    const socket = join(agentSyncHome, "daemon.sock");
    mkdirSync(agentSyncHome, { recursive: true });
    writeFileSync(socket, "legacy socket\n", "utf8");

    const row = await buildLegacyDaemonCheck({
      platform: "linux",
      homeDir,
      agentSyncHome,
      queryExecutor: async () => {
        throw new Error("Windows task query must not run on Linux");
      },
    });

    expect(row).toEqual({
      name: "Legacy daemon leftovers",
      status: "warn",
      detail: `Stale IPC socket ${socket} — remove with: rm -- '${socket}'`,
    });
    expect(readFileSync(socket, "utf8")).toBe("legacy socket\n");
  });

  test("warns for a socket under an injected AGENTSYNC_DIR without deleting it", async () => {
    const homeDir = join(tmpDir, "home");
    const agentSyncHome = join(tmpDir, "custom dir;$(echo injected)'quoted");
    const socket = join(agentSyncHome, "daemon.sock");
    mkdirSync(agentSyncHome, { recursive: true });
    writeFileSync(socket, "custom legacy socket\n", "utf8");

    const row = await buildLegacyDaemonCheck({
      platform: "darwin",
      homeDir,
      agentSyncHome,
      queryExecutor: async () => {
        throw new Error("Windows task query must not run on macOS");
      },
    });

    expect(row).toEqual({
      name: "Legacy daemon leftovers",
      status: "warn",
      detail:
        `Stale IPC socket ${socket} — remove with: rm -- ` + `'${socket.replaceAll("'", "'\\''")}'`,
    });
    expect(readFileSync(socket, "utf8")).toBe("custom legacy socket\n");
  });

  test("passes without mutation when the selected platform has no legacy artifacts", async () => {
    const homeDir = join(tmpDir, "home");
    const agentSyncHome = join(tmpDir, "agentsync");
    const nonSelectedPlist = join(homeDir, "Library", "LaunchAgents", "com.agentsync.daemon.plist");
    mkdirSync(dirname(nonSelectedPlist), { recursive: true });
    mkdirSync(agentSyncHome, { recursive: true });
    writeFileSync(nonSelectedPlist, "macOS-only artifact\n", "utf8");
    const queries: Array<readonly [string, readonly string[]]> = [];
    const queryExecutor: QueryExecutor = async (command, args) => {
      queries.push([command, args]);
    };

    const row = await buildLegacyDaemonCheck({
      platform: "linux",
      homeDir,
      agentSyncHome,
      queryExecutor,
    });

    expect(row).toEqual({
      name: "Legacy daemon leftovers",
      status: "pass",
      detail: "No pre-0.2.0 daemon registration found.",
    });
    expect(queries).toEqual([]);
    expect(readFileSync(nonSelectedPlist, "utf8")).toBe("macOS-only artifact\n");
  });
});
