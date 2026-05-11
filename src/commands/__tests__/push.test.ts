/**
 * Tests for performPush focused on the agent-skills-sync feature.
 *
 * These tests use the REAL Copilot adapter (after the walker retrofit at
 * src/agents/copilot.ts) so the warning produced is the exact prefix the
 * push gate must escalate to a fatal abort. They are NOT mocked at the
 * agent-registry layer because the whole point is to prove the
 * walker → snapshot → push gate chain holds end-to-end.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";

// Bun's mock cache occasionally aliases node:fs/promises across files; the
// integration test workaround re-exports the real module under the
// fs/promises alias before any agent code loads. We mirror that here.
{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: deliberate alias to bypass mock cache
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

// Mute @clack/prompts so log output doesn't pollute the test runner.
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

type PushMod = typeof import("../push");
let pushMod: PushMod;

const RUNTIME_ENV_KEYS = ["AGENTSYNC_VAULT_DIR", "AGENTSYNC_KEY_PATH", "AGENTSYNC_MACHINE"];

beforeAll(async () => {
  pushMod = await import("../push");
});

afterAll(() => {
  mock.restore();
});

describe("performPush — never-sync inside skill", () => {
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

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "ns-test-machine");

    // Point the Copilot adapter at a fully isolated tmp $HOME so no real
    // ~/.copilot/skills entry leaks into the test fixture.
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
    process.exitCode = 0;
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

  test("aborts the entire push when a Copilot skill contains a never-sync file", async () => {
    // Build a Copilot skills root with one valid skill plus one dirty skill.
    // `auth.json` is in NEVER_SYNC_PATTERNS (`**/auth.json`).
    const cleanSkill = join(mutableCopilotPaths.skillsDir, "clean-skill");
    mkdirSync(cleanSkill, { recursive: true });
    writeFileSync(join(cleanSkill, "SKILL.md"), "# clean", "utf8");

    const dirtySkill = join(mutableCopilotPaths.skillsDir, "dirty-skill");
    mkdirSync(dirtySkill, { recursive: true });
    writeFileSync(join(dirtySkill, "SKILL.md"), "# dirty", "utf8");
    writeFileSync(join(dirtySkill, "auth.json"), '{"token":"x"}', "utf8");

    const result = await pushMod.performPush({ agent: "copilot" });

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.startsWith("Push aborted"))).toBe(true);
    expect(result.errors.some((e) => e.includes("never-sync inside skill"))).toBe(true);
    // The offending file path should appear in at least one error string so
    // the user can fix it without grepping the codebase.
    expect(result.errors.some((e) => e.includes("auth.json"))).toBe(true);

    // Belt and braces: no skill artifacts should have been written for either
    // skill — the gate aborts before any encryption.
    expect(existsSync(join(machine.vaultDir, "copilot", "skills", "clean-skill.tar.age"))).toBe(
      false,
    );
    expect(existsSync(join(machine.vaultDir, "copilot", "skills", "dirty-skill.tar.age"))).toBe(
      false,
    );
  });
});

describe("performPush — additive default for local deletes", () => {
  // closes the analysis-flagged automated-coverage gap.
  // Uses the same Copilot fixture pattern as the never-sync test above.

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

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "addl-test-machine");

    const copilotHome = join(tmpDir, "copilot-home-additive");
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
    process.exitCode = 0;
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

  test("local skill deletion does NOT mutate the vault artifact", async () => {
    // First push: create one Copilot skill and push it to the vault.
    const skillDir = join(mutableCopilotPaths.skillsDir, "long-lived-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# long-lived", "utf8");
    writeFileSync(join(skillDir, "notes.md"), "# notes", "utf8");

    const firstResult = await pushMod.performPush({ agent: "copilot" });
    expect(firstResult.fatal).toBe(false);
    expect(firstResult.pushed).toBeGreaterThanOrEqual(1);

    const vaultArtifact = join(machine.vaultDir, "copilot", "skills", "long-lived-skill.tar.age");
    expect(existsSync(vaultArtifact)).toBe(true);
    const firstBytes = await readFile(vaultArtifact);
    expect(firstBytes.length).toBeGreaterThan(0);

    // Now delete the local skill directory and push again. The additive
    // default demands that the vault artifact stays exactly as it
    // was — a stray local `rm -rf` must not propagate to other machines.
    await rm(skillDir, { recursive: true, force: true });

    const secondResult = await pushMod.performPush({ agent: "copilot" });
    expect(secondResult.fatal).toBe(false);

    // The vault artifact must still exist with byte-identical content.
    expect(existsSync(vaultArtifact)).toBe(true);
    const secondBytes = await readFile(vaultArtifact);
    expect(Buffer.compare(firstBytes, secondBytes)).toBe(0);
  });
});

describe("performPush — literal secret embedded in markdown body", () => {
  // Closes the issue-#47 gap: markdown bodies (CLAUDE.md, *.prompt.md, skill
  // READMEs) were forwarded straight to encryptString without being scanned
  // for literal credentials. The chokepoint now lives in performPush Phase 1.

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

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "secret-test-machine");

    const copilotHome = join(tmpDir, "copilot-home-secret");
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
    process.exitCode = 0;
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

  test("aborts the entire push when a prompt file body contains a Claude API key", async () => {
    // The repro from issue #47: a literal sk-ant-api03-… credential pasted
    // into a markdown body sails past the adapter-level sanitizer (which
    // only walks structured JSON values) and reaches encryptString.
    mkdirSync(mutableCopilotPaths.promptsDir, { recursive: true });
    const promptPath = join(mutableCopilotPaths.promptsDir, "leaky.prompt.md");
    const fakeKey = `sk-ant-api03-${"A".repeat(48)}`;
    writeFileSync(
      promptPath,
      `# Demo prompt\n\nMy API key is ${fakeKey}\n\nDo not share.\n`,
      "utf8",
    );

    const result = await pushMod.performPush({ agent: "copilot" });

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.errors.some((e) => e.startsWith("Push aborted"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Detected literal secret"))).toBe(true);
    // The offending source path must appear so the user can locate the leak
    // without grepping their config tree.
    expect(result.errors.some((e) => e.includes("leaky.prompt.md"))).toBe(true);

    // Belt and braces: no encrypted artifact written for the prompt.
    expect(existsSync(join(machine.vaultDir, "copilot", "prompts", "leaky.prompt.md.age"))).toBe(
      false,
    );
  });
});
