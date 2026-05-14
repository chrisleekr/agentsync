import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { AgentPaths } from "../../../config/paths";
import { createAgeIdentity, createTmpDir } from "../../../test-helpers/fixtures";

{
  const require = createRequire(import.meta.url);
  const realFsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

type MutableVsCodePaths = {
  mcpJson: string;
};

const testVsCodePaths = AgentPaths.vscode as MutableVsCodePaths;

type VsCodeModule = typeof import("..");
let vsCodeModule: VsCodeModule;

beforeAll(async () => {
  vsCodeModule = await import("..");
});

// ── snapshotVsCode ─────────────────────────────────────────────────────

describe("snapshotVsCode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testVsCodePaths.mcpJson = join(tmpDir, "mcp.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("returns empty artifacts when mcp.json does not exist", async () => {
    const { snapshotVsCode } = vsCodeModule;
    const result = await snapshotVsCode();
    expect(result.artifacts).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  test("captures mcp.json as vscode/mcp.json.age", async () => {
    const { snapshotVsCode } = vsCodeModule;
    const mcp = {
      mcpServers: {
        "test-server": { command: "bun", args: ["run", "server.ts"] },
      },
    };
    await writeFile(testVsCodePaths.mcpJson, JSON.stringify(mcp), "utf8");

    const result = await snapshotVsCode();
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].vaultPath).toBe("vscode/mcp.json.age");

    const parsed = JSON.parse(result.artifacts[0].plaintext.trim()) as Record<string, unknown>;
    expect((parsed.mcpServers as Record<string, { command: string }>)["test-server"].command).toBe(
      "bun",
    );
  });

  test("redacts HTTP transport Authorization header value in vscode-shape mcp.json", async () => {
    const { snapshotVsCode } = vsCodeModule;
    // VS Code official shape: top-level `servers` with `type: "http"` and
    // `headers.Authorization`. The header value carries a github-style PAT
    // so the redaction pattern fires deterministically.
    const mcp = {
      servers: {
        remote: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Authorization: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" },
        },
      },
    };
    await writeFile(testVsCodePaths.mcpJson, JSON.stringify(mcp), "utf8");

    const result = await snapshotVsCode();
    const artifact = result.artifacts[0];
    const parsed = JSON.parse(artifact.plaintext.trim()) as {
      servers: { remote: { headers: Record<string, string> } };
    };
    const authVal = parsed.servers.remote.headers.Authorization;
    // The literal secret must be replaced by the redaction placeholder
    expect(authVal).not.toContain("ghp_abcdefghij");
    expect(authVal).toContain("REDACTED");
    expect(result.warnings.some((w) => w.includes("Detected"))).toBe(true);
    // Shape is preserved (top-level servers, not re-shaped to mcpServers)
    expect((parsed as Record<string, unknown>).mcpServers).toBeUndefined();
  });

  test("redacts embedded API key in mcp.json and emits warning", async () => {
    const { snapshotVsCode } = vsCodeModule;
    const mcp = {
      mcpServers: {
        "openai-server": {
          command: "node",
          env: { OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz123456" },
        },
      },
    };
    await writeFile(testVsCodePaths.mcpJson, JSON.stringify(mcp), "utf8");

    const result = await snapshotVsCode();
    const artifact = result.artifacts[0];
    const parsed = JSON.parse(artifact.plaintext.trim()) as {
      mcpServers: { "openai-server": { env: Record<string, string> } };
    };
    const apiKeyVal = parsed.mcpServers["openai-server"].env.OPENAI_API_KEY;

    // The literal secret must be replaced by a redaction placeholder
    expect(apiKeyVal).not.toContain("sk-proj-");
    expect(apiKeyVal).toContain("REDACTED");

    // A warning must surface to the caller
    expect(result.warnings.some((w) => w.includes("Detected"))).toBe(true);
  });
});

// ── applyVsCodeMcp ─────────────────────────────────────────────────────

describe("applyVsCodeMcp", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testVsCodePaths.mcpJson = join(tmpDir, "mcp.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes content to the mcpJson path atomically", async () => {
    const { applyVsCodeMcp } = vsCodeModule;
    const content = `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`;
    await applyVsCodeMcp(content);
    expect(await Bun.file(testVsCodePaths.mcpJson).text()).toBe(content);
  });
});

// ── dryRun vault apply ─────────────────────────────────────────────────

describe("applyVsCodeVault dryRun", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    testVsCodePaths.mcpJson = join(tmpDir, "mcp.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("dryRun=true does not write any local files", async () => {
    const { applyVsCodeVault } = vsCodeModule;
    const { encryptString } = await import("../../../core/encryptor");
    const { identity, recipient } = await createAgeIdentity();

    const vaultDir = join(tmpDir, "vault");
    const vsCodeVaultDir = join(vaultDir, "vscode");
    await mkdir(vsCodeVaultDir, { recursive: true });

    const encrypted = await encryptString(`${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, [
      recipient,
    ]);
    await writeFile(join(vsCodeVaultDir, "mcp.json.age"), encrypted, "utf8");

    await applyVsCodeVault(vaultDir, identity, true);

    // mcp.json must NOT be created on dryRun
    expect(await Bun.file(testVsCodePaths.mcpJson).exists()).toBe(false);
  });
});
