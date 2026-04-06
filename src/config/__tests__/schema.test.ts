import { describe, expect, test } from "bun:test";
import { AgentSyncConfigSchema, DaemonStatusSchema } from "../schema";

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

describe("DaemonStatusSchema", () => {
  test("parses a valid status payload with all fields", () => {
    const result = DaemonStatusSchema.parse({
      pid: 12345,
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(result.pid).toBe(12345);
    expect(result.consecutiveFailures).toBe(0);
    expect(result.lastError).toBeNull();
  });

  test("parses a valid payload with a non-null lastError string", () => {
    const result = DaemonStatusSchema.parse({
      pid: 99,
      consecutiveFailures: 3,
      lastError: "[pull] remote not reachable",
    });
    expect(result.consecutiveFailures).toBe(3);
    expect(result.lastError).toBe("[pull] remote not reachable");
  });

  test("rejects a negative pid", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: -1,
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects a zero pid", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: 0,
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects a non-integer pid", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: 1.5,
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects a negative consecutiveFailures", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: 100,
      consecutiveFailures: -1,
      lastError: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects a non-integer consecutiveFailures", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: 100,
      consecutiveFailures: 1.7,
      lastError: null,
    });
    expect(result.success).toBe(false);
  });

  test("rejects a numeric lastError (must be string or null)", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: 100,
      consecutiveFailures: 0,
      lastError: 42,
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing required fields", () => {
    const result = DaemonStatusSchema.safeParse({ pid: 100 });
    expect(result.success).toBe(false);
  });

  test("safeParse returns success: true on valid input", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: 1,
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(result.success).toBe(true);
  });

  test("safeParse returns success: false on invalid input without throwing", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: "not-a-number",
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(result.success).toBe(false);
  });

  test("accepts consecutiveFailures of 0 with lastError null — the 'healthy' state", () => {
    const result = DaemonStatusSchema.safeParse({
      pid: 42,
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.consecutiveFailures).toBe(0);
      expect(result.data.lastError).toBeNull();
    }
  });
});