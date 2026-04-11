import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { extractArchive } from "../../core/tar";
import { createTmpDir } from "../../test-helpers/fixtures";

{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

type MutableCopilotPaths = {
  instructionsFile: string;
  instructionsDir: string;
  skillsDir: string;
  promptsDir: string;
  agentsDir: string;
  vscodeMcpInSettings: string;
};

const testCopilotPaths = AgentPaths.copilot as MutableCopilotPaths;

// Capture the real paths once at module load so afterAll can put them back.
// See claude.test.ts for the full explanation of the cross-file mutation
// bleed this guards against.
const originalCopilotPaths: MutableCopilotPaths = { ...testCopilotPaths };

type CopilotModule = typeof import("../copilot");
let copilotModule: CopilotModule;

beforeAll(async () => {
  copilotModule = await import("../copilot");
});

afterAll(() => {
  Object.assign(testCopilotPaths, originalCopilotPaths);
});

// T020 — snapshotCopilot

describe("snapshotCopilot", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCopilotPaths.instructionsFile = join(tmpDir, "instructions");
    testCopilotPaths.instructionsDir = join(tmpDir, "instructions");
    testCopilotPaths.skillsDir = join(tmpDir, "skills");
    testCopilotPaths.promptsDir = join(tmpDir, "prompts");
    testCopilotPaths.agentsDir = join(tmpDir, "agents");
    testCopilotPaths.vscodeMcpInSettings = join(tmpDir, "vscode-settings.json");
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
    mkdirSync(testCopilotPaths.instructionsDir, { recursive: true });
    writeFileSync(
      join(testCopilotPaths.instructionsDir, "global.instructions.md"),
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
    mkdirSync(testCopilotPaths.promptsDir, { recursive: true });
    writeFileSync(join(testCopilotPaths.promptsDir, "test.prompt.md"), "# Test prompt", "utf8");

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find((a) => a.vaultPath === "copilot/prompts/test.prompt.md.age");
    expect(art).toBeDefined();
  });

  test("snapshots skill directories as base64 tar archives", async () => {
    const skillDir = join(testCopilotPaths.skillsDir, "my-skill");
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
    const skillDir = join(testCopilotPaths.skillsDir, "invalid-skill");
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
    testCopilotPaths.instructionsFile = join(tmpDir, "instructions.md");
    writeFileSync(testCopilotPaths.instructionsFile, "# Top-level", "utf8");

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find((a) => a.vaultPath === "copilot/instructions.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("# Top-level");
  });

  test("snapshots agents directories as base64 tar archives", async () => {
    const agentDir = join(testCopilotPaths.agentsDir, "my-copilot-agent");
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

  // T010 — walker retrofit regression: the new snapshotCopilot must inherit
  // the FR-016 (symlink) and FR-017 (dot-skip) rules from the shared walker.

  test("retrofit: top-level symlinked skill root produces zero artifacts (FR-016)", async () => {
    // Build a "vendored pool" outside the skills root and symlink it in.
    const vendoredTarget = join(tmpDir, "vendored-pool", "vendor-skill");
    mkdirSync(vendoredTarget, { recursive: true });
    writeFileSync(join(vendoredTarget, "SKILL.md"), "# vendored", "utf8");

    mkdirSync(testCopilotPaths.skillsDir, { recursive: true });
    symlinkSync(vendoredTarget, join(testCopilotPaths.skillsDir, "vendored-skill"));

    const result = await copilotModule.snapshotCopilot();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("copilot/skills/"));
    expect(skillArts).toHaveLength(0);
  });

  test("retrofit: top-level .system directory is skipped (FR-017)", async () => {
    const systemSkill = join(testCopilotPaths.skillsDir, ".system", "vendor");
    mkdirSync(systemSkill, { recursive: true });
    writeFileSync(join(systemSkill, "SKILL.md"), "# vendor", "utf8");

    const result = await copilotModule.snapshotCopilot();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("copilot/skills/"));
    expect(skillArts).toHaveLength(0);
  });

  test("retrofit: real skill with interior symlink helper omits the helper (FR-016 inner)", async () => {
    // Vendored helper file outside the skills root.
    const helperTargetDir = join(tmpDir, "vendored-helpers");
    mkdirSync(helperTargetDir, { recursive: true });
    const helperTarget = join(helperTargetDir, "shared.md");
    writeFileSync(helperTarget, "# vendored helper", "utf8");

    // Real skill directory with one real file plus the symlink.
    const skillDir = join(testCopilotPaths.skillsDir, "skill-with-helper");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# real", "utf8");
    writeFileSync(join(skillDir, "real-note.md"), "# real note", "utf8");
    symlinkSync(helperTarget, join(skillDir, "helper.md"));

    const result = await copilotModule.snapshotCopilot();
    const art = result.artifacts.find(
      (a) => a.vaultPath === "copilot/skills/skill-with-helper.tar.age",
    );
    expect(art).toBeDefined();

    // Decrypt-ish: base64 → tar bytes → extract → list entries.
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const tarBuf = Buffer.from(art!.plaintext, "base64");
    const extractDir = join(tmpDir, "extract-retrofit");
    mkdirSync(extractDir, { recursive: true });
    await extractArchive(tarBuf, extractDir);

    const entries = await readdir(extractDir);
    expect(entries).toContain("SKILL.md");
    expect(entries).toContain("real-note.md");
    expect(entries).not.toContain("helper.md");
  });
});

// T026 — applyCopilotInstructions / applyCopilotSkill / applyCopilotAgent

describe("apply* functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCopilotPaths.instructionsFile = join(tmpDir, "instructions");
    testCopilotPaths.instructionsDir = join(tmpDir, "instructions");
    testCopilotPaths.skillsDir = join(tmpDir, "skills");
    testCopilotPaths.promptsDir = join(tmpDir, "prompts");
    testCopilotPaths.agentsDir = join(tmpDir, "agents");
    testCopilotPaths.vscodeMcpInSettings = join(tmpDir, "vscode-settings.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applyCopilotInstructions writes instructions file", async () => {
    await copilotModule.applyCopilotInstructions("# Instructions");
    const content = await Bun.file(testCopilotPaths.instructionsFile).text();
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
      join(testCopilotPaths.skillsDir, "my-skill", "SKILL.md"),
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
      join(testCopilotPaths.agentsDir, "my-agent", "agent.md"),
    ).text();
    expect(extracted).toBe("# Agent content");
  });

  test("applyCopilotInstructionFile writes to instructions subdir", async () => {
    await copilotModule.applyCopilotInstructionFile("global.instructions.md", "# Instruction file");
    const content = await Bun.file(
      join(testCopilotPaths.instructionsDir, "global.instructions.md"),
    ).text();
    expect(content).toBe("# Instruction file");
  });

  test("applyCopilotPrompt writes to prompts dir", async () => {
    await copilotModule.applyCopilotPrompt("test.prompt.md", "# Prompt");
    const content = await Bun.file(join(testCopilotPaths.promptsDir, "test.prompt.md")).text();
    expect(content).toBe("# Prompt");
  });
});

// T028 — dryRun (applyCopilotVault)

describe("applyCopilotVault dryRun", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCopilotPaths.instructionsFile = join(tmpDir, "apply", "instructions");
    testCopilotPaths.instructionsDir = join(tmpDir, "apply", "instructions");
    testCopilotPaths.skillsDir = join(tmpDir, "apply", "skills");
    testCopilotPaths.promptsDir = join(tmpDir, "apply", "prompts");
    testCopilotPaths.agentsDir = join(tmpDir, "apply", "agents");
    testCopilotPaths.vscodeMcpInSettings = join(tmpDir, "apply", "vscode-settings.json");
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

    const exists = await Bun.file(testCopilotPaths.instructionsFile).exists();
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

    const content = await Bun.file(testCopilotPaths.instructionsFile).text();
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
      join(testCopilotPaths.instructionsDir, "global.instructions.md"),
    ).text();
    expect(content).toBe("# instr file");
  });

  // Phase 8 M6 — adversarial filename regression for Copilot.

  test("applyCopilotSkill rejects traversal and hidden skill names", async () => {
    const { InvalidSkillNameError } = await import("../skills-walker");
    const badNames = ["", ".", "..", "../foo", "foo/bar", "foo\\bar", ".hidden", "foo\x00bar"];
    for (const bad of badNames) {
      await expect(copilotModule.applyCopilotSkill(bad, "")).rejects.toBeInstanceOf(
        InvalidSkillNameError,
      );
    }
  });

  // Thread 6 regression — the agents/ loop in applyCopilotVault mirrors the
  // skills/ loop and was missed in the Phase 8 fix. Same basename-strip
  // vector (`...tar.age` → `..`) would let a compromised vault overwrite
  // files in the agent config root via path.join(agentsDir, "..").
  test("applyCopilotAgent rejects traversal and hidden agent names", async () => {
    const { InvalidSkillNameError } = await import("../skills-walker");
    const badNames = ["", ".", "..", "../foo", "foo/bar", "foo\\bar", ".hidden", "foo\x00bar"];
    for (const bad of badNames) {
      await expect(copilotModule.applyCopilotAgent(bad, "")).rejects.toBeInstanceOf(
        InvalidSkillNameError,
      );
    }
  });

  test("applyCopilotVault skips adversarial vault filenames without traversal", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const { archiveDirectory } = await import("../../core/tar");
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const payloadSrc = join(tmpDir, "payload-src");
    mkdirSync(payloadSrc, { recursive: true });
    writeFileSync(join(payloadSrc, "instructions.md"), "LEAKED_PAYLOAD", "utf8");
    const tarBuffer = await archiveDirectory(payloadSrc);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-adversarial");
    const skillsVaultDir = join(vaultDir, "copilot", "skills");
    mkdirSync(skillsVaultDir, { recursive: true });
    writeFileSync(join(skillsVaultDir, "...tar.age"), encrypted, "utf8");

    await copilotModule.applyCopilotVault(vaultDir, identity, false);

    const escapedPayload = join(testCopilotPaths.skillsDir, "..", "instructions.md");
    const leakedExists = await Bun.file(escapedPayload).exists();
    expect(leakedExists).toBeFalse();
  });

  // Thread 6 regression end-to-end: an adversarial file in copilot/agents/
  // must be rejected symmetrically with the skills/ loop above. Distinct
  // payload filename (`AGENT_LEAKED.md`) so a false positive can't be
  // mistaken for the skills-loop assertion's leakage.
  test("applyCopilotVault skips adversarial agent filenames without traversal", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const { archiveDirectory } = await import("../../core/tar");
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const payloadSrc = join(tmpDir, "agent-payload-src");
    mkdirSync(payloadSrc, { recursive: true });
    writeFileSync(join(payloadSrc, "AGENT_LEAKED.md"), "LEAKED_AGENT_PAYLOAD", "utf8");
    const tarBuffer = await archiveDirectory(payloadSrc);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-adversarial-agent");
    const agentsVaultDir = join(vaultDir, "copilot", "agents");
    mkdirSync(agentsVaultDir, { recursive: true });
    writeFileSync(join(agentsVaultDir, "...tar.age"), encrypted, "utf8");

    await copilotModule.applyCopilotVault(vaultDir, identity, false);

    const escapedPayload = join(testCopilotPaths.agentsDir, "..", "AGENT_LEAKED.md");
    const leakedExists = await Bun.file(escapedPayload).exists();
    expect(leakedExists).toBeFalse();
  });
});
