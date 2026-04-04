import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";

// ─── Mock AgentPaths before dynamic import ────────────────────────────────────

const mockCopilotPaths = {
  instructionsFile: "",
  instructionsDir: "",
  skillsDir: "",
  promptsDir: "",
  agentsDir: "",
  vscodeMcpInSettings: "",
};

mock.module("../../config/paths", () => ({
  AgentPaths: {
    claude: {
      claudeMd: "",
      settingsJson: "",
      commandsDir: "",
      agentsDir: "",
      mcpJson: "",
      credentials: "",
    },
    cursor: { mcpGlobal: "", commandsDir: "", settingsJson: "" },
    codex: {
      root: "",
      agentsMd: "",
      configToml: "",
      rulesDir: "",
      authJson: "",
    },
    copilot: mockCopilotPaths,
    vscode: { mcpJson: "" },
  },
  resolveAgentSyncHome: () => "/tmp/agentsync",
  resolveDaemonSocketPath: () => "/tmp/agentsync/daemon.sock",
}));

type CopilotModule = typeof import("../copilot");
let copilotModule: CopilotModule;

beforeAll(async () => {
  copilotModule = await import("../copilot");
});

// T020 — snapshotCopilot

describe("snapshotCopilot", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    mockCopilotPaths.instructionsFile = join(tmpDir, "instructions");
    mockCopilotPaths.instructionsDir = join(tmpDir, "instructions");
    mockCopilotPaths.skillsDir = join(tmpDir, "skills");
    mockCopilotPaths.promptsDir = join(tmpDir, "prompts");
    mockCopilotPaths.agentsDir = join(tmpDir, "agents");
    mockCopilotPaths.vscodeMcpInSettings = join(tmpDir, "vscode-settings.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty artifacts when no files exist", async () => {
    const result = await copilotModule.snapshotCopilot();
    expect(result.artifacts).toHaveLength(0);
  });

  test("snapshots top-level instructions file", async () => {
    // Note: instructionsFile and instructionsDir are the same path in copilot
    // The file is read if it exists as a file, but readdir would fail on a file path
    // We test instructions dir entries separately
    mkdirSync(mockCopilotPaths.instructionsDir, { recursive: true });
    writeFileSync(
      join(mockCopilotPaths.instructionsDir, "global.instructions.md"),
      "# Global instructions",
      "utf8",
    );

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find(
      (a) => a.vaultPath === "copilot/instructions/global.instructions.md.age",
    );
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("# Global instructions");
  });

  test("snapshots .prompt.md files from prompts dir", async () => {
    mkdirSync(mockCopilotPaths.promptsDir, { recursive: true });
    writeFileSync(join(mockCopilotPaths.promptsDir, "test.prompt.md"), "# Test prompt", "utf8");

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find((a) => a.vaultPath === "copilot/prompts/test.prompt.md.age");
    expect(art).toBeDefined();
  });

  test("snapshots skill directories as base64 tar archives", async () => {
    const skillDir = join(mockCopilotPaths.skillsDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# My skill", "utf8");

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find((a) => a.vaultPath === "copilot/skills/my-skill.tar.age");
    expect(art).toBeDefined();
    // plaintext should be base64-encoded
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(() => Buffer.from(art!.plaintext, "base64")).not.toThrow();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(art!.plaintext.length).toBeGreaterThan(0);
  });

  test("skill without SKILL.md is not snapshotted", async () => {
    const skillDir = join(mockCopilotPaths.skillsDir, "invalid-skill");
    mkdirSync(skillDir, { recursive: true });
    // No SKILL.md — should not be included

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find(
      (a) => a.vaultPath === "copilot/skills/invalid-skill.tar.age",
    );
    expect(art).toBeUndefined();
  });

  test("snapshots top-level instructions file as copilot/instructions.md.age", async () => {
    // Set instructionsFile to a dedicated file path distinct from instructionsDir
    mockCopilotPaths.instructionsFile = join(tmpDir, "instructions.md");
    writeFileSync(mockCopilotPaths.instructionsFile, "# Top-level", "utf8");

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find((a) => a.vaultPath === "copilot/instructions.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("# Top-level");
  });

  test("snapshots agents directories as base64 tar archives", async () => {
    const agentDir = join(mockCopilotPaths.agentsDir, "my-copilot-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "agent.md"), "# Agent", "utf8");

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find(
      (a) => a.vaultPath === "copilot/agents/my-copilot-agent.tar.age",
    );
    expect(art).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(() => Buffer.from(art!.plaintext, "base64")).not.toThrow();
  });
});

// T026 — applyCopilotInstructions / applyCopilotSkill / applyCopilotAgent

describe("apply* functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    mockCopilotPaths.instructionsFile = join(tmpDir, "instructions");
    mockCopilotPaths.instructionsDir = join(tmpDir, "instructions");
    mockCopilotPaths.skillsDir = join(tmpDir, "skills");
    mockCopilotPaths.promptsDir = join(tmpDir, "prompts");
    mockCopilotPaths.agentsDir = join(tmpDir, "agents");
    mockCopilotPaths.vscodeMcpInSettings = join(tmpDir, "vscode-settings.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applyCopilotInstructions writes instructions file", async () => {
    await copilotModule.applyCopilotInstructions("# Instructions");
    const content = await Bun.file(mockCopilotPaths.instructionsFile).text();
    expect(content).toBe("# Instructions");
  });

  test("applyCopilotSkill extracts a tar archive into skills dir", async () => {
    const { archiveDirectory } = await import("../../core/tar");
    // Create a source skill dir to archive
    const srcSkill = join(tmpDir, "src-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# Skill content", "utf8");

    const buf = await archiveDirectory(srcSkill);
    const base64 = buf.toString("base64");

    await copilotModule.applyCopilotSkill("my-skill", base64);

    const extracted = await Bun.file(
      join(mockCopilotPaths.skillsDir, "my-skill", "SKILL.md"),
    ).text();
    expect(extracted).toBe("# Skill content");
  });

  test("applyCopilotAgent extracts a tar archive into agents dir", async () => {
    const { archiveDirectory } = await import("../../core/tar");
    const srcAgent = join(tmpDir, "src-agent");
    mkdirSync(srcAgent, { recursive: true });
    writeFileSync(join(srcAgent, "agent.md"), "# Agent content", "utf8");

    const buf = await archiveDirectory(srcAgent);
    await copilotModule.applyCopilotAgent("my-agent", buf.toString("base64"));

    const extracted = await Bun.file(
      join(mockCopilotPaths.agentsDir, "my-agent", "agent.md"),
    ).text();
    expect(extracted).toBe("# Agent content");
  });

  test("applyCopilotInstructionFile writes to instructions subdir", async () => {
    await copilotModule.applyCopilotInstructionFile("global.instructions.md", "# Instruction file");
    const content = await Bun.file(
      join(mockCopilotPaths.instructionsDir, "global.instructions.md"),
    ).text();
    expect(content).toBe("# Instruction file");
  });

  test("applyCopilotPrompt writes to prompts dir", async () => {
    await copilotModule.applyCopilotPrompt("test.prompt.md", "# Prompt");
    const content = await Bun.file(join(mockCopilotPaths.promptsDir, "test.prompt.md")).text();
    expect(content).toBe("# Prompt");
  });
});

// T028 — dryRun (applyCopilotVault)

describe("applyCopilotVault dryRun", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    mockCopilotPaths.instructionsFile = join(tmpDir, "apply", "instructions");
    mockCopilotPaths.instructionsDir = join(tmpDir, "apply", "instructions");
    mockCopilotPaths.skillsDir = join(tmpDir, "apply", "skills");
    mockCopilotPaths.promptsDir = join(tmpDir, "apply", "prompts");
    mockCopilotPaths.agentsDir = join(tmpDir, "apply", "agents");
    mockCopilotPaths.vscodeMcpInSettings = join(tmpDir, "apply", "vscode-settings.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dryRun=true does not write instructions file", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const vaultDir = join(tmpDir, "vault");
    const copilotVaultDir = join(vaultDir, "copilot");
    mkdirSync(copilotVaultDir, { recursive: true });
    const encrypted = await encryptString("# dry run", [recipient]);
    writeFileSync(join(copilotVaultDir, "instructions.md.age"), encrypted, "utf8");

    await copilotModule.applyCopilotVault(vaultDir, identity, true);

    const exists = await Bun.file(mockCopilotPaths.instructionsFile).exists();
    expect(exists).toBeFalse();
  });

  test("dryRun=false writes instructions.md.age content", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const vaultDir = join(tmpDir, "vault-nodry");
    const copilotVaultDir = join(vaultDir, "copilot");
    mkdirSync(copilotVaultDir, { recursive: true });
    const encrypted = await encryptString("# applied", [recipient]);
    writeFileSync(join(copilotVaultDir, "instructions.md.age"), encrypted, "utf8");

    await copilotModule.applyCopilotVault(vaultDir, identity, false);

    const content = await Bun.file(mockCopilotPaths.instructionsFile).text();
    expect(content).toBe("# applied");
  });

  test("dryRun=false applies instructions/ subdir files", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const vaultDir = join(tmpDir, "vault-instr");
    const instrVaultDir = join(vaultDir, "copilot", "instructions");
    mkdirSync(instrVaultDir, { recursive: true });
    const encrypted = await encryptString("# instr file", [recipient]);
    writeFileSync(join(instrVaultDir, "global.instructions.md.age"), encrypted, "utf8");

    await copilotModule.applyCopilotVault(vaultDir, identity, false);

    const content = await Bun.file(
      join(mockCopilotPaths.instructionsDir, "global.instructions.md"),
    ).text();
    expect(content).toBe("# instr file");
  });
});
