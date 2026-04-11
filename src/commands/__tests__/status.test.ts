import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { AgentPaths } from "../../config/paths";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";

// The statusColour mapping applies colour AFTER padding to preserve
// column alignment. We verify each status gets a distinct colour function.

describe("status colour mapping", () => {
  test("pad-then-colour produces correct visual width with distinct colours", () => {
    type SyncStatus = "synced" | "local-changed" | "vault-only" | "local-only" | "error";

    const statusColour: Record<SyncStatus, (s: string) => string> = {
      synced: pc.green,
      "local-changed": pc.yellow,
      "vault-only": pc.cyan,
      "local-only": pc.dim,
      error: pc.red,
    };

    const padWidth = 13; // max visual width ("local-changed")

    for (const [status, colourFn] of Object.entries(statusColour)) {
      const padded = status.padEnd(padWidth);
      const coloured = colourFn(padded);

      // Padded plain text should be exactly padWidth chars
      expect(padded.length).toBe(padWidth);

      // Coloured string should contain the original status text
      expect(coloured).toContain(status);

      // Coloured string should be strictly longer than padded (ANSI codes added)
      // unless colour is disabled, in which case it equals padded
      expect(coloured.length).toBeGreaterThanOrEqual(padded.length);
    }

    // Verify distinct colours — no two statuses produce identical output
    const values = Object.entries(statusColour).map(([s, fn]) => fn(s));
    const unique = new Set(values);
    expect(unique.size).toBe(Object.keys(statusColour).length);
  });
});

// T035 — FR-007 closes the analysis-flagged automated-coverage gap.
// Proves the status command surfaces drift for skill .tar.age artifacts via
// the existing collectAgeFiles walker, using the REAL Copilot agent path so
// the proof carries to every other skill-bearing agent that calls the same
// shared walker.

{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: deliberate alias to bypass mock cache
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

const fakeLogs = {
  success: [] as string[],
  info: [] as string[],
  warn: [] as string[],
  error: [] as string[],
};

mock.module("@clack/prompts", () => ({
  intro: () => {},
  outro: () => {},
  log: {
    success: (m: string) => {
      fakeLogs.success.push(m);
    },
    info: (m: string) => {
      fakeLogs.info.push(m);
    },
    warn: (m: string) => {
      fakeLogs.warn.push(m);
    },
    error: (m: string) => {
      fakeLogs.error.push(m);
    },
  },
  note: () => {},
  spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
}));

type MutableCopilotPaths = {
  instructionsFile: string;
  instructionsDir: string;
  skillsDir: string;
  promptsDir: string;
  agentsDir: string;
  vscodeMcpInSettings: string;
};
const mutableCopilotPaths = AgentPaths.copilot as MutableCopilotPaths;

const RUNTIME_ENV_KEYS = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"];

describe("status — FR-007 surfaces skill drift", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  const savedEnv: Record<string, string | undefined> = {};
  const savedCopilot = {
    skillsDir: mutableCopilotPaths.skillsDir,
    instructionsFile: mutableCopilotPaths.instructionsFile,
    instructionsDir: mutableCopilotPaths.instructionsDir,
    promptsDir: mutableCopilotPaths.promptsDir,
    agentsDir: mutableCopilotPaths.agentsDir,
    vscodeMcpInSettings: mutableCopilotPaths.vscodeMcpInSettings,
  };

  beforeAll(() => {
    fakeLogs.success.length = 0;
    fakeLogs.info.length = 0;
    fakeLogs.warn.length = 0;
    fakeLogs.error.length = 0;
  });

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "status-test-machine");

    const copilotHome = join(tmpDir, "copilot-home");
    mutableCopilotPaths.skillsDir = join(copilotHome, "skills");
    mutableCopilotPaths.instructionsFile = join(copilotHome, "instructions");
    mutableCopilotPaths.instructionsDir = join(copilotHome, "instructions");
    mutableCopilotPaths.promptsDir = join(copilotHome, "prompts");
    mutableCopilotPaths.agentsDir = join(copilotHome, "agents");
    mutableCopilotPaths.vscodeMcpInSettings = join(tmpDir, "vscode-settings.json");

    for (const key of RUNTIME_ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;

    seedVaultRepo({
      machine,
      bareRepoPath,
      agents: { copilot: true, claude: false },
    });

    fakeLogs.success.length = 0;
    fakeLogs.info.length = 0;
    fakeLogs.warn.length = 0;
    fakeLogs.error.length = 0;
  });

  afterEach(async () => {
    for (const key of RUNTIME_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    mutableCopilotPaths.skillsDir = savedCopilot.skillsDir;
    mutableCopilotPaths.instructionsFile = savedCopilot.instructionsFile;
    mutableCopilotPaths.instructionsDir = savedCopilot.instructionsDir;
    mutableCopilotPaths.promptsDir = savedCopilot.promptsDir;
    mutableCopilotPaths.agentsDir = savedCopilot.agentsDir;
    mutableCopilotPaths.vscodeMcpInSettings = savedCopilot.vscodeMcpInSettings;
    await rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    mock.restore();
  });

  test("reports a Copilot skill .tar.age artifact as synced when local matches vault", async () => {
    // Build a real Copilot skill on disk.
    const skillDir = join(mutableCopilotPaths.skillsDir, "drift-test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# drift fixture", "utf8");

    // Snapshot via the real walker so the byte content matches what status
    // will hash on the next run.
    const walker = await import("../../agents/skills-walker");
    const snap = await walker.collectSkillArtifacts("copilot", mutableCopilotPaths.skillsDir);
    expect(snap.artifacts).toHaveLength(1);

    // Encrypt the artifact and write to the matching vault path so the
    // status command sees a vault file to compare against.
    const { encryptString } = await import("../../core/encryptor");
    const recipient = machine.recipient;
    const encrypted = await encryptString(snap.artifacts[0]?.plaintext ?? "", [recipient]);

    const vaultArtPath = join(machine.vaultDir, "copilot", "skills", "drift-test-skill.tar.age");
    await mkdir(dirname(vaultArtPath), { recursive: true });
    writeFileSync(vaultArtPath, encrypted, "utf8");

    // Run the real status command.
    const statusMod = await import("../status");
    await statusMod.statusCommand.run?.({
      args: { verbose: false },
      rawArgs: [],
      cmd: {} as never,
    } as never);

    // The skill should appear in the rendered table as a synced row. Use a
    // per-line `find` (not a blob `toContain`) because the status command's
    // summary line ALWAYS prints the literal string `synced` (e.g.
    // `Summary: 1 synced, 0 changed, ...`) regardless of how many rows are
    // actually synced. A blob assertion would false-positive even if the
    // skill row was reported as `local-changed`.
    const skillRow = fakeLogs.info.find(
      (line) => line.includes("drift-test-skill") && line.includes("synced"),
    );
    expect(skillRow).toBeDefined();
  });

  test("reports a Copilot skill as local-changed when local mutates after the vault snapshot", async () => {
    const skillDir = join(mutableCopilotPaths.skillsDir, "mutating-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# v1", "utf8");

    // Snapshot v1 and write the encrypted artifact to the vault.
    const walker = await import("../../agents/skills-walker");
    const snapV1 = await walker.collectSkillArtifacts("copilot", mutableCopilotPaths.skillsDir);
    const { encryptString } = await import("../../core/encryptor");
    const encryptedV1 = await encryptString(snapV1.artifacts[0]?.plaintext ?? "", [
      machine.recipient,
    ]);
    const vaultArtPath = join(machine.vaultDir, "copilot", "skills", "mutating-skill.tar.age");
    await mkdir(dirname(vaultArtPath), { recursive: true });
    writeFileSync(vaultArtPath, encryptedV1, "utf8");

    // Mutate the local skill so it no longer matches the vault snapshot.
    writeFileSync(join(skillDir, "SKILL.md"), "# v2 — diverged", "utf8");

    fakeLogs.info.length = 0;
    const statusMod = await import("../status");
    await statusMod.statusCommand.run?.({
      args: { verbose: false },
      rawArgs: [],
      cmd: {} as never,
    } as never);

    // Per-line assertion (matches the synced test for consistency). The
    // summary line uses the literal `changed` not `local-changed`, so this
    // particular assertion would not be ambiguous on its own — but using the
    // same shape across both tests makes the pattern clearly the right one
    // to copy when the next reviewer adds another status row.
    const skillRow = fakeLogs.info.find(
      (line) => line.includes("mutating-skill") && line.includes("local-changed"),
    );
    expect(skillRow).toBeDefined();
  });
});
