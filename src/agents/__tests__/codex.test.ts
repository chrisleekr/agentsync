import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../config/paths";
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
};

const testCodexPaths = AgentPaths.codex as MutableCodexPaths;

type CodexModule = typeof import("../codex");
let codexModule: CodexModule;

beforeAll(async () => {
  codexModule = await import("../codex");
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
});
