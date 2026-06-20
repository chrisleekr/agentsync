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
import { loadConfig, resolveConfigPath, writeConfig } from "../../config/loader";
import { AgentPaths, machineVaultRoot } from "../../config/paths";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  runGit,
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
  mock.module("node:fs/promises", () => ({ ...realFsPromises, default: realFsPromises }));
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
    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "skills",
          "clean-skill.tar.age",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "skills",
          "dirty-skill.tar.age",
        ),
      ),
    ).toBe(false);
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

    const vaultArtifact = join(
      machineVaultRoot(machine.vaultDir, machine.machineName),
      "copilot",
      "skills",
      "long-lived-skill.tar.age",
    );
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
    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "prompts",
          "leaky.prompt.md.age",
        ),
      ),
    ).toBe(false);
  });

  test("honours config.security.secretScan = off — the secret is no longer scanned", async () => {
    // Proves performPush threads the [security] policy into the scan gate: with
    // the scan turned off in vault config, the same leaky body now pushes.
    mkdirSync(mutableCopilotPaths.promptsDir, { recursive: true });
    const promptPath = join(mutableCopilotPaths.promptsDir, "leaky.prompt.md");
    const fakeKey = `sk-ant-api03-${"A".repeat(48)}`;
    writeFileSync(promptPath, `# Demo prompt\n\nMy API key is ${fakeKey}\n`, "utf8");

    const configPath = resolveConfigPath(machine.vaultDir);
    const config = await loadConfig(configPath);
    config.security.secretScan = "off";
    await writeConfig(configPath, config);
    runGit(["commit", "-am", "config: scan off"], machine.vaultDir);
    runGit(["push", "origin", "main"], machine.vaultDir);

    const result = await pushMod.performPush({ agent: "copilot" });
    expect(result.fatal).toBe(false);
    expect(result.pushed).toBeGreaterThan(0);
  });

  test("redact mode still aborts on a secret in a prose body (nothing to redact)", async () => {
    // redact only rewrites structured JSON/TOML values; a markdown body has no
    // field to replace, so the secret-leak boundary must still abort the push.
    mkdirSync(mutableCopilotPaths.promptsDir, { recursive: true });
    const promptPath = join(mutableCopilotPaths.promptsDir, "leaky.prompt.md");
    const fakeKey = `sk-ant-api03-${"A".repeat(48)}`;
    writeFileSync(promptPath, `# Demo prompt\n\nMy API key is ${fakeKey}\n`, "utf8");

    const configPath = resolveConfigPath(machine.vaultDir);
    const config = await loadConfig(configPath);
    config.security.secretScan = "redact";
    await writeConfig(configPath, config);
    runGit(["commit", "-am", "config: redact"], machine.vaultDir);
    runGit(["push", "origin", "main"], machine.vaultDir);

    const result = await pushMod.performPush({ agent: "copilot" });
    expect(result.fatal).toBe(true);
    expect(result.errors.some((e) => e.includes("Detected literal secret"))).toBe(true);
  });

  test("strict mode flags a JWT that standard mode lets through", async () => {
    mkdirSync(mutableCopilotPaths.promptsDir, { recursive: true });
    const promptPath = join(mutableCopilotPaths.promptsDir, "jwt.prompt.md");
    const jwt = `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`;
    writeFileSync(promptPath, `# Demo\n\ntoken ${jwt}\n`, "utf8");

    // standard: a JWT is not a flagged pattern → push succeeds.
    const standard = await pushMod.performPush({ agent: "copilot" });
    expect(standard.fatal).toBe(false);

    // strict: JWT detection turns on → the same body now aborts the push.
    const configPath = resolveConfigPath(machine.vaultDir);
    const config = await loadConfig(configPath);
    config.security.secretScan = "strict";
    await writeConfig(configPath, config);
    runGit(["commit", "-am", "config: strict"], machine.vaultDir);
    runGit(["push", "origin", "main"], machine.vaultDir);

    const strict = await pushMod.performPush({ agent: "copilot" });
    expect(strict.fatal).toBe(true);
    expect(strict.errors.some((e) => e.includes("jwt"))).toBe(true);
  });

  test("allowSecretValues lets an embedded, exempted credential through the gate", async () => {
    mkdirSync(mutableCopilotPaths.promptsDir, { recursive: true });
    const promptPath = join(mutableCopilotPaths.promptsDir, "allow.prompt.md");
    const key = `sk-ant-api03-${"A".repeat(48)}`;
    writeFileSync(promptPath, `# Demo\n\nMy key is ${key} in a sentence.\n`, "utf8");

    const configPath = resolveConfigPath(machine.vaultDir);
    const config = await loadConfig(configPath);
    config.security.allowSecretValues = [key];
    await writeConfig(configPath, config);
    runGit(["commit", "-am", "config: allow key"], machine.vaultDir);
    runGit(["push", "origin", "main"], machine.vaultDir);

    const result = await pushMod.performPush({ agent: "copilot" });
    expect(result.fatal).toBe(false);
    expect(result.pushed).toBeGreaterThan(0);
  });

  test("vaultPaths allowlist skips the secret scan for unselected files", async () => {
    // A secret-bearing prompt sits in one file; a clean instructions file
    // sits in another. With vaultPaths scoped to ONLY the clean file, the
    // push must succeed — the leaky file is not in scope for this op.
    mkdirSync(mutableCopilotPaths.promptsDir, { recursive: true });
    const promptPath = join(mutableCopilotPaths.promptsDir, "leaky.prompt.md");
    const fakeKey = `sk-ant-api03-${"A".repeat(48)}`;
    writeFileSync(
      promptPath,
      `# Demo prompt\n\nMy API key is ${fakeKey}\n\nDo not share.\n`,
      "utf8",
    );

    // Add the clean file in the same agent surface.
    writeFileSync(mutableCopilotPaths.instructionsFile, "# Clean instructions\n", "utf8");

    const result = await pushMod.performPush({
      agent: "copilot",
      vaultPaths: new Set(["copilot/instructions.md.age"]),
    });

    // Push succeeds because the leaky file is filtered out before the scan.
    expect(result.fatal).toBe(false);
    expect(result.pushed).toBeGreaterThan(0);
    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "instructions.md.age",
        ),
      ),
    ).toBe(true);
    // The unselected leaky file was never encrypted.
    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "prompts",
          "leaky.prompt.md.age",
        ),
      ),
    ).toBe(false);
  });

  test("vaultPaths allowlist still aborts when a SELECTED file contains a secret", async () => {
    // Same setup as above, but this time the leaky file IS in the
    // allowlist. The scan must still abort — the gate's job is to prevent
    // encrypted secrets from landing in the vault, not to honour selection.
    mkdirSync(mutableCopilotPaths.promptsDir, { recursive: true });
    const promptPath = join(mutableCopilotPaths.promptsDir, "leaky.prompt.md");
    const fakeKey = `sk-ant-api03-${"A".repeat(48)}`;
    writeFileSync(
      promptPath,
      `# Demo prompt\n\nMy API key is ${fakeKey}\n\nDo not share.\n`,
      "utf8",
    );

    const result = await pushMod.performPush({
      agent: "copilot",
      vaultPaths: new Set(["copilot/prompts/leaky.prompt.md.age"]),
    });

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.errors.some((e) => e.includes("leaky.prompt.md"))).toBe(true);
  });
});

describe("performPush — literal secret embedded inside a skill bundle body", () => {
  // The Phase-1 central scan in performPush deliberately skips `.tar.age`
  // artifacts (base64 of a tar buffer scrambles credential prefixes and
  // overlaps `AKIA…`/`AIza…` shapes). Without per-file scanning at the
  // walker layer, a literal key pasted into SKILL.md would be encrypted
  // and shipped. This test proves the walker warning flows through the
  // existing Phase-1 abort wiring end-to-end.

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
    machine = await createMachineFixture(tmpDir, "bundle-secret-machine");

    const copilotHome = join(tmpDir, "copilot-home-bundle-secret");
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

  test("aborts when a Copilot skill SKILL.md body contains a literal Claude API key", async () => {
    const skillDir = join(mutableCopilotPaths.skillsDir, "leaky-bundle");
    mkdirSync(skillDir, { recursive: true });
    const fakeKey = `sk-ant-api03-${"D".repeat(48)}`;
    const skillMd = join(skillDir, "SKILL.md");
    writeFileSync(skillMd, `# leaky\n\ntoken: ${fakeKey}\n`, "utf8");

    const result = await pushMod.performPush({ agent: "copilot" });

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.errors.some((e) => e.startsWith("Push aborted"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Detected literal secret"))).toBe(true);
    // The offending file path must appear so the user can locate the leak
    // without grepping their config tree.
    expect(result.errors.some((e) => e.includes(skillMd))).toBe(true);

    // No encrypted artifact written for the leaky skill — the walker drops
    // the artifact before encryption.
    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "skills",
          "leaky-bundle.tar.age",
        ),
      ),
    ).toBe(false);
  });
});

describe("performPush — dry-run still runs Phase 1 security gates", () => {
  // Dry-run must enforce the same abort gates as a real push. A clean preview
  // followed by a real-push abort builds false confidence: dry-run is the
  // canonical pre-flight gate, so any path that hides a fatal must be wired
  // back through performPush's Phase 1.

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
    machine = await createMachineFixture(tmpDir, "dry-run-secret-machine");

    const copilotHome = join(tmpDir, "copilot-home-dry-run");
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

  test("aborts a dry-run when a prompt file body contains a Claude API key", async () => {
    mkdirSync(mutableCopilotPaths.promptsDir, { recursive: true });
    const promptPath = join(mutableCopilotPaths.promptsDir, "dry-leaky.prompt.md");
    const fakeKey = `sk-ant-api03-${"B".repeat(48)}`;
    writeFileSync(
      promptPath,
      `# Demo prompt\n\nMy API key is ${fakeKey}\n\nDo not share.\n`,
      "utf8",
    );

    const previews: Array<{ sourcePath: string; skipped: boolean }> = [];
    const result = await pushMod.performPush({
      agent: "copilot",
      dryRun: true,
      onPreview: (entry) => {
        previews.push({ sourcePath: entry.sourcePath, skipped: entry.skipped });
      },
    });

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.errors.some((e) => e.startsWith("Push aborted"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Detected literal secret"))).toBe(true);
    expect(result.errors.some((e) => e.includes("dry-leaky.prompt.md"))).toBe(true);

    // Phase 1 aborts before Phase 2 runs, so the preview callback must not
    // fire for the leaky artifact (otherwise the user sees a clean preview).
    expect(previews).toHaveLength(0);

    // No encrypted artifact written even though the operation was a dry-run.
    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "prompts",
          "dry-leaky.prompt.md.age",
        ),
      ),
    ).toBe(false);
  });

  test("aborts a dry-run when a Copilot skill contains a never-sync file", async () => {
    const cleanSkill = join(mutableCopilotPaths.skillsDir, "clean-skill");
    mkdirSync(cleanSkill, { recursive: true });
    writeFileSync(join(cleanSkill, "SKILL.md"), "# clean", "utf8");

    const dirtySkill = join(mutableCopilotPaths.skillsDir, "dirty-skill");
    mkdirSync(dirtySkill, { recursive: true });
    writeFileSync(join(dirtySkill, "SKILL.md"), "# dirty", "utf8");
    writeFileSync(join(dirtySkill, "auth.json"), '{"token":"x"}', "utf8");

    const previews: Array<{ sourcePath: string; skipped: boolean }> = [];
    const result = await pushMod.performPush({
      agent: "copilot",
      dryRun: true,
      onPreview: (entry) => {
        previews.push({ sourcePath: entry.sourcePath, skipped: entry.skipped });
      },
    });

    expect(result.fatal).toBe(true);
    expect(result.pushed).toBe(0);
    expect(result.errors.some((e) => e.startsWith("Push aborted"))).toBe(true);
    expect(result.errors.some((e) => e.includes("never-sync inside skill"))).toBe(true);
    expect(result.errors.some((e) => e.includes("auth.json"))).toBe(true);

    // Phase 1 aborts before any preview entry is emitted.
    expect(previews).toHaveLength(0);

    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "skills",
          "clean-skill.tar.age",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          machineVaultRoot(machine.vaultDir, machine.machineName),
          "copilot",
          "skills",
          "dirty-skill.tar.age",
        ),
      ),
    ).toBe(false);
  });
});

describe("walkerWarningMatchesSelection — directory boundary", () => {
  test("matches the exact selected skill via trailing slash", async () => {
    const { walkerWarningMatchesSelection } = await import("../push");
    const filter = new Set(["claude/skills/foo.tar.age"]);
    expect(
      walkerWarningMatchesSelection(
        "[Detected literal secret in /Users/x/.claude/skills/foo/SKILL.md]",
        filter,
        "claude",
      ),
    ).toBe(true);
  });

  test("does not match a sibling skill that shares a name prefix", async () => {
    const { walkerWarningMatchesSelection } = await import("../push");
    const filter = new Set(["claude/skills/foo.tar.age"]);
    // Substring match on the bare skillDir would falsely escalate this
    // sibling — the directory-boundary check must reject it.
    expect(
      walkerWarningMatchesSelection(
        "[Detected literal secret in /Users/x/.claude/skills/foo-extra/SKILL.md]",
        filter,
        "claude",
      ),
    ).toBe(false);
  });

  test("ignores warnings for a different agent", async () => {
    const { walkerWarningMatchesSelection } = await import("../push");
    const filter = new Set(["claude/skills/foo.tar.age"]);
    expect(
      walkerWarningMatchesSelection(
        "[Detected literal secret in /Users/x/.codex/skills/foo/SKILL.md]",
        filter,
        "codex",
      ),
    ).toBe(false);
  });
});
