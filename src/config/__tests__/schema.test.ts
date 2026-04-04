import { describe, expect, test } from "bun:test";
import { AgentSyncConfigSchema } from "../schema";

const VALID_BASE = {
  version: "1",
  recipients: { local: "age1abc" },
  agents: {
    cursor: true,
    claude: true,
    codex: true,
    copilot: true,
    vscode: false,
  },
  remote: { url: "git@github.com:user/vault.git", branch: "main" },
  sync: {
    debounceMs: 300,
    autoPush: true,
    autoPull: true,
    pullIntervalMs: 300_000,
  },
} as const;

describe("AgentSyncConfigSchema", () => {
  test("validates minimal config", () => {
    const parsed = AgentSyncConfigSchema.parse(VALID_BASE);
    expect(parsed.remote.branch).toBe("main");
  });

  test("applies default branch 'main' when branch is omitted", () => {
    const parsed = AgentSyncConfigSchema.parse({
      ...VALID_BASE,
      remote: { url: "git@github.com:user/vault.git" },
    });
    expect(parsed.remote.branch).toBe("main");
  });

  test("rejects config with missing remote", () => {
    const result = AgentSyncConfigSchema.safeParse({
      recipients: { me: "age1xxx" },
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
      recipients: ["age1xxx"],
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

  test("rejects debounceMs below minimum (50)", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      sync: {
        debounceMs: 10,
        autoPush: true,
        autoPull: true,
        pullIntervalMs: 300_000,
      },
    });
    expect(result.success).toBe(false);
  });

  test("rejects debounceMs above maximum (10000)", () => {
    const result = AgentSyncConfigSchema.safeParse({
      ...VALID_BASE,
      sync: {
        debounceMs: 99_999,
        autoPush: true,
        autoPull: true,
        pullIntervalMs: 300_000,
      },
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
      recipients: { "": "age1abc" },
    });
    expect(result.success).toBe(false);
  });

  test("version field accepts any string", () => {
    const parsed = AgentSyncConfigSchema.parse({ ...VALID_BASE, version: "2" });
    expect(parsed.version).toBe("2");
  });

  test("defaults version to '1' when omitted", () => {
    const { version: _v, ...withoutVersion } = VALID_BASE;
    const parsed = AgentSyncConfigSchema.parse(withoutVersion);
    expect(parsed.version).toBe("1");
  });
});
