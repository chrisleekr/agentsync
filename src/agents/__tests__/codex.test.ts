import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
import { archiveDirectory, extractArchive } from "../../core/tar";
import { createTmpDir } from "../../test-helpers/fixtures";

{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

type MutableCodexPaths = {
  root: string;
  agentsMd: string;
  configToml: string;
  rulesDir: string;
  authJson: string;
  skillsDir: string;
};

const testCodexPaths = AgentPaths.codex as MutableCodexPaths;

// Capture the real paths once at module load so afterAll can put them back.
// See claude.test.ts for the full explanation of the cross-file mutation
// bleed this guards against.
const originalCodexPaths: MutableCodexPaths = { ...testCodexPaths };

type CodexModule = typeof import("../codex");
let codexModule: CodexModule;

beforeAll(async () => {
  codexModule = await import("../codex");
});

afterAll(() => {
  Object.assign(testCodexPaths, originalCodexPaths);
});

// T019 — snapshotCodex

describe("snapshotCodex", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCodexPaths.root = tmpDir;
    testCodexPaths.agentsMd = join(tmpDir, "AGENTS.md");
    testCodexPaths.configToml = join(tmpDir, "config.toml");
    testCodexPaths.rulesDir = join(tmpDir, "rules");
    testCodexPaths.authJson = join(tmpDir, "auth.json");
    testCodexPaths.skillsDir = join(tmpDir, "skills");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty artifacts when no files exist", async () => {
    const result = await codexModule.snapshotCodex();
    expect(result.artifacts).toHaveLength(0);
  });

  test("snapshots AGENTS.md when it exists", async () => {
    await writeFile(testCodexPaths.agentsMd, "# My agents\n", "utf8");
    const result = await codexModule.snapshotCodex();
    const art = result.artifacts.find((a) => a.vaultPath === "codex/AGENTS.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("# My agents\n");
  });

  test("snapshots config.toml when it exists", async () => {
    await writeFile(testCodexPaths.configToml, 'model = "gpt-4"\n', "utf8");
    const result = await codexModule.snapshotCodex();
    const art = result.artifacts.find((a) => a.vaultPath === "codex/config.toml.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toContain("gpt-4");
  });

  test("snapshots .md files from rules dir", async () => {
    mkdirSync(testCodexPaths.rulesDir, { recursive: true });
    writeFileSync(join(testCodexPaths.rulesDir, "style.md"), "## Style rules", "utf8");

    const result = await codexModule.snapshotCodex();
    const art = result.artifacts.find((a) => a.vaultPath === "codex/rules/style.md.age");
    expect(art).toBeDefined();
    expect(art?.plaintext).toBe("## Style rules");
  });

  test("does not snapshot auth.json (shouldNeverSync)", async () => {
    await writeFile(testCodexPaths.authJson, '{"token": "secret"}', "utf8");
    // auth.json is in NEVER_SYNC_PATTERNS via "**/auth.json"
    // But snapshotCodex doesn't read auth.json — it only reads AGENTS.md, config.toml, and rules/*.md
    // So this test confirms auth.json is never included
    const result = await codexModule.snapshotCodex();
    const authArt = result.artifacts.find((a) => a.vaultPath.includes("auth.json"));
    expect(authArt).toBeUndefined();
  });

  // T017(1) — US2 Codex skill round-trip happy path (FR-001, FR-003, FR-004)

  test("snapshots a real Codex skill directory as a base64 tar artifact", async () => {
    const skillDir = join(testCodexPaths.skillsDir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# my codex skill", "utf8");
    writeFileSync(join(skillDir, "notes.md"), "# notes", "utf8");

    const result = await codexModule.snapshotCodex();
    const art = result.artifacts.find((a) => a.vaultPath === "codex/skills/my-skill.tar.age");
    expect(art).toBeDefined();
    expect(art?.sourcePath).toBe(skillDir);
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(() => Buffer.from(art!.plaintext, "base64")).not.toThrow();
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    expect(art!.plaintext.length).toBeGreaterThan(0);
  });

  // T017(5) — FR-009 missing-dir case at the agent layer

  test("snapshotCodex does not throw when the skills directory is missing (FR-009)", async () => {
    testCodexPaths.skillsDir = join(tmpDir, "skills-does-not-exist");

    const result = await codexModule.snapshotCodex();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("codex/skills/"));
    expect(skillArts).toHaveLength(0);
    expect(result.warnings.filter((w) => w.startsWith("never-sync"))).toHaveLength(0);
  });

  // T017(6) — FR-016 interior-symlink defense-in-depth at the agent layer

  test("snapshotCodex omits interior symlink helper files from the tar (FR-016 inner)", async () => {
    // Vendored helper outside the skills root.
    const helperTargetParent = join(tmpDir, "vendored-helpers");
    mkdirSync(helperTargetParent, { recursive: true });
    const helperTarget = join(helperTargetParent, "shared.md");
    writeFileSync(helperTarget, "# vendored helper", "utf8");

    const skillDir = join(testCodexPaths.skillsDir, "skill-with-helper");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# real", "utf8");
    writeFileSync(join(skillDir, "real-note.md"), "# real note", "utf8");
    symlinkSync(helperTarget, join(skillDir, "helper.md"));

    const result = await codexModule.snapshotCodex();
    const art = result.artifacts.find(
      (a) => a.vaultPath === "codex/skills/skill-with-helper.tar.age",
    );
    expect(art).toBeDefined();

    // Decode the base64 tar and verify helper.md is absent.
    // biome-ignore lint/style/noNonNullAssertion: asserted by toBeDefined above
    const tarBuf = Buffer.from(art!.plaintext, "base64");
    const extractDir = join(tmpDir, "extract-codex-helper");
    mkdirSync(extractDir, { recursive: true });
    await extractArchive(tarBuf, extractDir);

    const entries = await readdir(extractDir);
    expect(entries).toContain("SKILL.md");
    expect(entries).toContain("real-note.md");
    expect(entries).not.toContain("helper.md");
  });

  // T018 — FR-017 dot-skip regression specific to Codex (.system vendor bundle)

  test("snapshotCodex skips a top-level .system directory (FR-017 dot-skip)", async () => {
    // Real skill alongside a .system/ directory which represents a vendor bundle
    // that Codex may ship with its installer. The dot-skip rule MUST filter this
    // out regardless of whether it contains a valid SKILL.md sentinel.
    const realSkill = join(testCodexPaths.skillsDir, "my-skill");
    mkdirSync(realSkill, { recursive: true });
    writeFileSync(join(realSkill, "SKILL.md"), "# real", "utf8");

    const systemSkill = join(testCodexPaths.skillsDir, ".system", "vendor");
    mkdirSync(systemSkill, { recursive: true });
    writeFileSync(join(systemSkill, "SKILL.md"), "# vendor", "utf8");

    const result = await codexModule.snapshotCodex();
    const skillArts = result.artifacts.filter((a) => a.vaultPath.startsWith("codex/skills/"));
    expect(skillArts).toHaveLength(1);
    expect(skillArts[0]?.vaultPath).toBe("codex/skills/my-skill.tar.age");
  });
});

// T025 — applyCodexAgentsMd / applyCodexConfig / applyCodexRule

describe("apply* functions", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCodexPaths.root = tmpDir;
    testCodexPaths.agentsMd = join(tmpDir, "AGENTS.md");
    testCodexPaths.configToml = join(tmpDir, "config.toml");
    testCodexPaths.rulesDir = join(tmpDir, "rules");
    testCodexPaths.authJson = join(tmpDir, "auth.json");
    testCodexPaths.skillsDir = join(tmpDir, "skills");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("applyCodexAgentsMd writes AGENTS.md", async () => {
    await codexModule.applyCodexAgentsMd("# Agents");
    const content = await Bun.file(testCodexPaths.agentsMd).text();
    expect(content).toBe("# Agents");
  });

  test("applyCodexConfig writes config.toml when no file exists", async () => {
    await codexModule.applyCodexConfig('model = "o3"\n');
    const content = await Bun.file(testCodexPaths.configToml).text();
    expect(content).toContain("o3");
  });

  test("applyCodexConfig merges into existing config (incoming wins)", async () => {
    await writeFile(testCodexPaths.configToml, 'model = "gpt-4"\nlocal_only = true\n', "utf8");
    await codexModule.applyCodexConfig('model = "o3"\n');

    const content = await Bun.file(testCodexPaths.configToml).text();
    // incoming model wins, local_only key is preserved
    expect(content).toContain("o3");
    expect(content).toContain("local_only");
  });

  test("applyCodexRule writes a rule file", async () => {
    await codexModule.applyCodexRule("testing.md", "## Testing rules");
    const content = await Bun.file(join(testCodexPaths.rulesDir, "testing.md")).text();
    expect(content).toBe("## Testing rules");
  });

  // T017(2) — applyCodexSkill direct extraction test

  test("applyCodexSkill extracts a tar archive into the local skills dir", async () => {
    const srcSkill = join(tmpDir, "src-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# codex skill body", "utf8");
    writeFileSync(join(srcSkill, "extra.md"), "# extra", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");

    await codexModule.applyCodexSkill("my-skill", base64);

    const targetSkillDir = join(testCodexPaths.skillsDir, "my-skill");
    const skillMd = await Bun.file(join(targetSkillDir, "SKILL.md")).text();
    const extra = await Bun.file(join(targetSkillDir, "extra.md")).text();
    expect(skillMd).toBe("# codex skill body");
    expect(extra).toBe("# extra");
  });
});

// T028 — dryRun (applyCodexVault)

describe("applyCodexVault dryRun", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testCodexPaths.root = join(tmpDir, "apply");
    testCodexPaths.agentsMd = join(tmpDir, "apply", "AGENTS.md");
    testCodexPaths.configToml = join(tmpDir, "apply", "config.toml");
    testCodexPaths.rulesDir = join(tmpDir, "apply", "rules");
    testCodexPaths.authJson = join(tmpDir, "apply", "auth.json");
    testCodexPaths.skillsDir = join(tmpDir, "apply", "skills");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dryRun=true does not write any files", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const vaultDir = join(tmpDir, "vault");
    const codexVaultDir = join(vaultDir, "codex");
    await mkdir(codexVaultDir, { recursive: true });
    const encrypted = await encryptString("# dry run agents", [recipient]);
    await writeFile(join(codexVaultDir, "AGENTS.md.age"), encrypted, "utf8");

    await codexModule.applyCodexVault(vaultDir, identity, true);

    const exists = await Bun.file(testCodexPaths.agentsMd).exists();
    expect(exists).toBeFalse();
  });

  // T017(3) — applyCodexVault restores a Codex skill from an encrypted artifact

  test("applyCodexVault restores a Codex skill from an encrypted vault artifact", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const srcSkill = join(tmpDir, "src", "round-trip-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# codex round trip", "utf8");
    writeFileSync(join(srcSkill, "guide.md"), "# guide", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-skill-roundtrip");
    const skillsVaultDir = join(vaultDir, "codex", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    await writeFile(join(skillsVaultDir, "round-trip-skill.tar.age"), encrypted, "utf8");

    await codexModule.applyCodexVault(vaultDir, identity, false);

    const restoredSkillDir = join(testCodexPaths.skillsDir, "round-trip-skill");
    const restoredSkill = await Bun.file(join(restoredSkillDir, "SKILL.md")).text();
    const restoredGuide = await Bun.file(join(restoredSkillDir, "guide.md")).text();
    expect(restoredSkill).toBe("# codex round trip");
    expect(restoredGuide).toBe("# guide");
  });

  // T017(4) — applyCodexVault dryRun=true must NOT touch the local skills dir

  test("applyCodexVault dryRun=true does not extract skill artifacts", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const srcSkill = join(tmpDir, "src", "dry-run-skill");
    mkdirSync(srcSkill, { recursive: true });
    writeFileSync(join(srcSkill, "SKILL.md"), "# codex dry run skill", "utf8");

    const tarBuffer = await archiveDirectory(srcSkill);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-skill-dryrun");
    const skillsVaultDir = join(vaultDir, "codex", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    await writeFile(join(skillsVaultDir, "dry-run-skill.tar.age"), encrypted, "utf8");

    await codexModule.applyCodexVault(vaultDir, identity, true);

    const restoredSkillDir = join(testCodexPaths.skillsDir, "dry-run-skill");
    const exists = await Bun.file(join(restoredSkillDir, "SKILL.md")).exists();
    expect(exists).toBeFalse();
  });

  // Phase 8 M6 — adversarial filename regression for Codex.

  test("applyCodexSkill rejects traversal and hidden skill names", async () => {
    const { InvalidSkillNameError } = await import("../skills-walker");
    const badNames = ["", ".", "..", "../foo", "foo/bar", "foo\\bar", ".hidden", "foo\x00bar"];
    for (const bad of badNames) {
      await expect(codexModule.applyCodexSkill(bad, "")).rejects.toBeInstanceOf(
        InvalidSkillNameError,
      );
    }
  });

  test("applyCodexVault skips adversarial vault filenames without traversal", async () => {
    const { generateIdentity, identityToRecipient, encryptString } = await import(
      "../../core/encryptor"
    );
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);

    const payloadSrc = join(tmpDir, "payload-src");
    mkdirSync(payloadSrc, { recursive: true });
    writeFileSync(join(payloadSrc, "AGENTS.md"), "LEAKED_PAYLOAD", "utf8");
    const tarBuffer = await archiveDirectory(payloadSrc);
    const base64 = tarBuffer.toString("base64");
    const encrypted = await encryptString(base64, [recipient]);

    const vaultDir = join(tmpDir, "vault-adversarial");
    const skillsVaultDir = join(vaultDir, "codex", "skills");
    await mkdir(skillsVaultDir, { recursive: true });
    await writeFile(join(skillsVaultDir, "...tar.age"), encrypted, "utf8");

    await codexModule.applyCodexVault(vaultDir, identity, false);

    const escapedPayload = join(testCodexPaths.skillsDir, "..", "AGENTS.md");
    const leakedExists = await Bun.file(escapedPayload).exists();
    expect(leakedExists).toBeFalse();
  });
});
