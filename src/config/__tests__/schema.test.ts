import { describe, expect, test } from "bun:test";
import { AgentSyncConfigSchema, AgePublicKeySchema } from "../schema";

// A bech32-only recipient. `age1abc` cannot be used as a fixture because `b`
// is not in the bech32 charset `qpzry9x8gf2tvdw0s3jn54khce6mua7l` that the
// schema now enforces.
const VALID_RECIPIENT = "age1qpzry9x8gf2tvdw0s3jn54khce6mua7l";

const VALID_BASE = {
  version: 2,
  recipients: { local: VALID_RECIPIENT },
  agents: {
    cursor: true,
    claude: true,
    codex: true,
    copilot: true,
    vscode: false,
  },
  remote: { url: "git@github.com:user/vault.git", branch: "main" },
} as const;

describe("AgentSyncConfigSchema", () => {
  test("validates minimal config", () => {
    const parsed = AgentSyncConfigSchema.parse(VALID_BASE);
    expect(parsed.remote.branch).toBe("main");
    expect(parsed.agents.opencode).toBe(false);
  });

  test("accepts an explicit OpenCode vault opt-in", () => {
    const parsed = AgentSyncConfigSchema.parse({
      ...VALID_BASE,
      agents: { ...VALID_BASE.agents, opencode: true },
    });
    expect(parsed.agents.opencode).toBe(true);
  });

  test("applies default branch 'main' when branch is omitted", () => {
    const parsed = AgentSyncConfigSchema.parse({
      ...VALID_BASE,
      remote: { url: "git@github.com:user/vault.git" },
    });
    expect(parsed.remote.branch).toBe("main");
  });

  test("defaults claudePlugins.syncPlugins to false when the section is absent", () => {
    const parsed = AgentSyncConfigSchema.parse(VALID_BASE);
    expect(parsed.claudePlugins.syncPlugins).toBe(false);
  });

  test("defaults the whole security section when absent — back-compat without a version bump", () => {
    // VALID_BASE has no [security], mirroring an agentsync.toml written before
    // the section existed. It must still load, with safe defaults applied.
    const parsed = AgentSyncConfigSchema.parse(VALID_BASE);
    expect(parsed.security).toEqual({
      secretScan: "standard",
      allowSecretValues: [],
      redactBase64Values: true,
    });
  });

  test("fills inner security defaults when the section is partial", () => {
    const parsed = AgentSyncConfigSchema.parse({
      ...VALID_BASE,
      security: { secretScan: "strict" },
    });
    expect(parsed.security.secretScan).toBe("strict");
    expect(parsed.security.allowSecretValues).toEqual([]);
    expect(parsed.security.redactBase64Values).toBe(true);
  });

  test("rejects an invalid security.secretScan value", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      security: { secretScan: "loud" },
    });
    expect(result.success).toBe(false);
  });

  test("maps a legacy claudePlugins.syncMarketplace key to syncPlugins", () => {
    // Back-compat: existing v2 agentsync.toml files predate the rename and must
    // keep loading without a manual edit.
    const parsed = AgentSyncConfigSchema.parse({
      ...VALID_BASE,
      claudePlugins: { syncMarketplace: true },
    });
    expect(parsed.claudePlugins.syncPlugins).toBe(true);
  });

  test("prefers an explicit syncPlugins over a stale legacy syncMarketplace", () => {
    const parsed = AgentSyncConfigSchema.parse({
      ...VALID_BASE,
      claudePlugins: { syncPlugins: false, syncMarketplace: true },
    });
    expect(parsed.claudePlugins.syncPlugins).toBe(false);
  });

  test("rejects config with missing remote", () => {
    const result = AgentSyncConfigSchema.safeParse({
      recipients: { me: VALID_RECIPIENT },
      agents: {
        cursor: true,
        claude: false,
        codex: false,
        copilot: false,
        vscode: false,
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects recipients as array instead of object", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      recipients: [VALID_RECIPIENT],
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty string as recipient value", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      recipients: { me: "" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty recipients map — empty vault is a misconfiguration, not a state", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      recipients: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const message = result.error.issues.map((i) => i.message).join("\n");
      expect(message).toContain("at least one entry");
    }
  });

  test("rejects recipient value without age1 prefix", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      recipients: { me: "notage1xyz" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects recipient value with invalid bech32 characters", () => {
    // 'B' / 'I' / 'O' / '1' are explicitly excluded from the bech32 charset.
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      recipients: { me: "age1BAD" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty branch — would push to empty refspec", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      remote: { url: "git@github.com:user/vault.git", branch: "" },
    });
    expect(result.success).toBe(false);
  });

  test("rejects remote.url that is obviously not a URL", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      remote: { url: "not a url", branch: "main" },
    });
    expect(result.success).toBe(false);
  });

  test("strips unknown top-level fields (Zod default strip mode)", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      unknownField: "xyz",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).unknownField).toBeUndefined();
    }
  });

  test("recipients object must have at least one entry with non-empty key", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      recipients: { "": VALID_RECIPIENT },
    });
    expect(result.success).toBe(false);
  });

  test("version must be the integer 2 (the v2 format)", () => {
    const parsed = AgentSyncConfigSchema.parse(VALID_BASE);
    expect(parsed.version).toBe(2);
  });

  test("rejects a string version — the old-binary block", () => {
    // v1 wrote `version` as a string; the v2 schema must reject it so a v1
    // vault never loads under v2 (and vice versa) without going through upgrade.
    expect(AgentSyncConfigSchema.safeParse({ ...VALID_BASE, version: "2" }).success).toBe(false);
    expect(AgentSyncConfigSchema.safeParse({ ...VALID_BASE, version: "1" }).success).toBe(false);
  });

  test("rejects a missing version", () => {
    const { version: _v, ...withoutVersion } = VALID_BASE;
    expect(AgentSyncConfigSchema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe("AgePublicKeySchema", () => {
  test("accepts a bech32-charset key with age1 prefix", () => {
    expect(AgePublicKeySchema.safeParse("age1qpzry9x8gf2tvdw0s3jn54khce6mua7l").success).toBe(true);
  });

  test("rejects empty string", () => {
    expect(AgePublicKeySchema.safeParse("").success).toBe(false);
  });

  test("rejects missing age1 prefix", () => {
    expect(AgePublicKeySchema.safeParse("notage1xyz").success).toBe(false);
  });

  test("rejects uppercase letters (bech32 is case-segregated)", () => {
    expect(AgePublicKeySchema.safeParse("age1BAD").success).toBe(false);
  });

  test("rejects characters outside the bech32 data charset", () => {
    // 'b' is one of the four bech32-excluded letters (b/i/o/1).
    expect(AgePublicKeySchema.safeParse("age1abc").success).toBe(false);
  });

  test("rejects whitespace around an otherwise-valid key", () => {
    expect(AgePublicKeySchema.safeParse(" age1qpzry9 ").success).toBe(false);
  });
});
