import { describe, expect, test } from "bun:test";
import { AGENTSYNC_HOME_PLACEHOLDER } from "../path-portability";
import {
  ALWAYS_BLOCK_PATTERNS,
  EMBEDDED_SECRET_PATTERNS,
  NEVER_SYNC_PATTERNS,
  redactionEnvNameForPath,
  redactSecretLiterals,
  type SecretPolicy,
  sanitizeAndNormalizeJson,
  scanForSecrets,
  securityToPolicy,
  shouldNeverSync,
} from "../sanitizer";

describe("sanitizer", () => {
  test("redacts obvious secret-like values", () => {
    const result = redactSecretLiterals({
      token: "sk-abcdefghijklmnopqrstuvwxyz123456",
    });
    const value = result.value as { token: string };
    expect(value.token.startsWith("$AGENTSYNC_REDACTED")).toBeTrue();
    expect(result.warnings.length).toBe(1);
  });

  test("never sync excludes sensitive files", () => {
    expect(shouldNeverSync("/tmp/.codex/auth.json")).toBeTrue();
    expect(shouldNeverSync("/tmp/.claude/.credentials.json")).toBeTrue();
    expect(shouldNeverSync("/tmp/normal/file.md")).toBeFalse();
  });

  // ─── NEVER_SYNC_PATTERNS boundary cases ───────────────────────────────────

  test("NEVER_SYNC_PATTERNS is a non-empty array", () => {
    expect(NEVER_SYNC_PATTERNS.length).toBeGreaterThan(0);
  });

  test("**/auth.json matches nested auth.json", () => {
    expect(shouldNeverSync("/home/user/.codex/auth.json")).toBeTrue();
    expect(shouldNeverSync("auth.json")).toBeTrue();
  });

  test("**/.credentials.json matches nested .credentials.json", () => {
    expect(shouldNeverSync("/home/user/.claude/.credentials.json")).toBeTrue();
  });

  test("**/history.jsonl matches history.jsonl anywhere", () => {
    expect(shouldNeverSync("/home/user/.claude/history.jsonl")).toBeTrue();
  });

  test("**/sessions/** matches files inside sessions dir", () => {
    expect(shouldNeverSync("/home/user/.claude/sessions/abc.json")).toBeTrue();
    expect(shouldNeverSync("/home/user/.claude/sessions/nested/file")).toBeTrue();
  });

  test("**/.claude/statsig/** matches files inside statsig dir", () => {
    expect(shouldNeverSync("/home/user/.claude/statsig/data.json")).toBeTrue();
  });

  test("**/*.local.md matches local-only markdown files", () => {
    expect(shouldNeverSync("/home/user/.claude/notes.local.md")).toBeTrue();
    expect(shouldNeverSync("private.local.md")).toBeTrue();
  });

  test("**/.claude/settings.local.json is blocked", () => {
    expect(shouldNeverSync("/home/user/.claude/settings.local.json")).toBeTrue();
  });

  test("**/agentsync.toml is blocked", () => {
    expect(shouldNeverSync("/vault/agentsync.toml")).toBeTrue();
  });

  test("**/*.age is blocked", () => {
    expect(shouldNeverSync("/vault/claude/CLAUDE.md.age")).toBeTrue();
    expect(shouldNeverSync("file.age")).toBeTrue();
  });

  test("CLAUDE.md is NOT blocked", () => {
    expect(shouldNeverSync("/home/user/.claude/CLAUDE.md")).toBeFalse();
  });

  test("settings.json (not .local) is NOT blocked", () => {
    expect(shouldNeverSync("/home/user/.claude/settings.json")).toBeFalse();
  });

  // ─── redactionEnvNameForPath ───────────────────────────────────────────────

  test("redactionEnvNameForPath returns AGENTSYNC_REDACTED_ prefix", () => {
    const name = redactionEnvNameForPath("/home/user/.claude/settings.json");
    expect(name).toBe("AGENTSYNC_REDACTED_SETTINGS_JSON");
  });

  test("redactionEnvNameForPath handles hyphens and dots", () => {
    const name = redactionEnvNameForPath("/path/to/mcp.json");
    expect(name).toBe("AGENTSYNC_REDACTED_MCP_JSON");
  });

  test("redactionEnvNameForPath uses only the basename", () => {
    const a = redactionEnvNameForPath("/very/deep/path/config.toml");
    const b = redactionEnvNameForPath("config.toml");
    expect(a).toBe(b);
  });

  // ─── redactSecretLiterals — deep nesting and non-redacted pass-through ─────

  test("does not redact short non-secret strings", () => {
    const result = redactSecretLiterals({ key: "hello" });
    const value = result.value as { key: string };
    expect(value.key).toBe("hello");
    expect(result.warnings).toHaveLength(0);
  });

  test("redacts deeply nested secret value", () => {
    const input = { a: { b: { c: { apiKey: `sk-${"x".repeat(30)}` } } } };
    const result = redactSecretLiterals(input, "root");
    const deep = (result.value as typeof input).a.b.c;
    expect(deep.apiKey.startsWith("$AGENTSYNC_REDACTED")).toBeTrue();
    expect(result.warnings).toHaveLength(1);
  });

  test("handles array of values — redacts secrets, passes safe strings", () => {
    const input = ["safe-string", `sk-${"x".repeat(30)}`];
    const result = redactSecretLiterals(input, "arr");
    const value = result.value as string[];
    expect(value[0]).toBe("safe-string");
    expect(value[1]?.startsWith("$AGENTSYNC_REDACTED")).toBeTrue();
  });

  test("passes through null / boolean / number unchanged with zero warnings", () => {
    expect(redactSecretLiterals(null).warnings).toHaveLength(0);
    expect(redactSecretLiterals(42).warnings).toHaveLength(0);
    expect(redactSecretLiterals(true).warnings).toHaveLength(0);
  });

  test("EMBEDDED_SECRET_PATTERNS is non-empty so scanForSecrets has rules to run", () => {
    expect(EMBEDDED_SECRET_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of EMBEDDED_SECRET_PATTERNS) {
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.pattern).toBeInstanceOf(RegExp);
    }
  });

  test("scanForSecrets returns no warnings on plain prose", () => {
    const prose =
      "AgentSync syncs your local agent configuration through an encrypted vault. " +
      "Read README.md for setup. Path: /home/user/.claude/CLAUDE.md is fine.";
    expect(scanForSecrets(prose, "/home/user/.claude/CLAUDE.md")).toEqual([]);
  });

  test("scanForSecrets returns no warnings on empty input", () => {
    expect(scanForSecrets("", "/tmp/empty.md")).toEqual([]);
  });

  test.each<[string, string]>([
    ["anthropic-api-key", `sk-ant-api03-${"A".repeat(48)}`],
    ["openai-project-key", `sk-proj-${"a".repeat(48)}`],
    ["github-classic-pat", `ghp_${"x".repeat(36)}`],
    ["github-fine-grained-pat", `github_pat_${"y".repeat(82)}`],
    ["gitlab-pat", `glpat-${"z".repeat(20)}`],
    ["aws-access-key", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["google-api-key", `AIza${"a".repeat(35)}`],
    ["slack-token-bot", `xoxb-${"abc123".repeat(2)}`],
    ["slack-token-user", `xoxp-${"abc123".repeat(2)}`],
    ["slack-token-app", `xoxa-${"abc123".repeat(2)}`],
    ["slack-token-refresh", `xoxr-${"abc123".repeat(2)}`],
    ["slack-token-session", `xoxs-${"abc123".repeat(2)}`],
    ["age-secret-key", `AGE-SECRET-KEY-1${"A".repeat(58)}`],
  ])("scanForSecrets detects %s embedded in prose", (expectedName, sampleSecret) => {
    const body = `Note from setup: my key is ${sampleSecret}. Do not share.`;
    const warnings = scanForSecrets(body, "/tmp/leaky.md");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.startsWith("Detected literal secret"))).toBe(true);
    expect(warnings.some((w) => w.includes("/tmp/leaky.md"))).toBe(true);
    // The matching pattern's name (or the slack-token base name for the
    // Slack probes — all five variants share one regex) must appear in at
    // least one warning.
    const stem = expectedName.startsWith("slack-token") ? "slack-token" : expectedName;
    expect(warnings.some((w) => w.includes(stem))).toBe(true);
  });

  test("scanForSecrets catches Gap 2 — secrets embedded in JSON-stringified env values", () => {
    // The original `redactSecretLiterals` only matches whole-string JSON
    // values. A prose-style env value like "the key is sk-ant-…" sails
    // through unanchored. The central scan in performPush sees the full
    // stringified JSON and must catch it.
    const mcpJson = JSON.stringify({
      mcpServers: {
        acme: {
          env: { GREETING: `my key is sk-ant-api03-${"A".repeat(48)} thanks` },
        },
      },
    });
    const warnings = scanForSecrets(mcpJson, "/home/user/.claude.json");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes("anthropic-api-key"))).toBe(true);
  });

  test("redactSecretLiterals rewrites an age secret key pasted as a whole JSON value", () => {
    // An MCP env block like { AGENTSYNC_KEY: "AGE-SECRET-KEY-1..." } must be
    // redacted, not just aborted, so the rest of the structured config survives.
    const ageKey = `AGE-SECRET-KEY-1${"A".repeat(58)}`;
    const input = { env: { AGENTSYNC_KEY: ageKey } };
    const result = redactSecretLiterals(input);
    const value = result.value as { env: { AGENTSYNC_KEY: string } };
    expect(value.env.AGENTSYNC_KEY).not.toBe(ageKey);
    expect(value.env.AGENTSYNC_KEY.startsWith("$AGENTSYNC_REDACTED")).toBeTrue();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets does NOT false-positive on long alphanumeric runs in prose", () => {
    const prose =
      "Commit 0123456789abcdef0123456789abcdef0123456789abcdef contains a fix. " +
      "The build hash AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA passed CI. " +
      "Branch feature-xyz merged at 2026-05-11.";
    expect(scanForSecrets(prose, "/tmp/notes.md")).toEqual([]);
  });

  test("sanitizeAndNormalizeJson rewrites home paths and redacts literal secrets", () => {
    const home = "/Users/alpha";
    const raw = JSON.stringify({
      cwd: `${home}/proj`,
      env: { TOKEN: "sk-AAAAAAAAAAAAAAAAAAAAAA" },
    });
    const out = sanitizeAndNormalizeJson(raw, "test", home);
    const parsed = JSON.parse(out.value) as { cwd: string; env: { TOKEN: string } };
    expect(parsed.cwd).toBe(`${AGENTSYNC_HOME_PLACEHOLDER}/proj`);
    expect(parsed.env.TOKEN).not.toBe("sk-AAAAAAAAAAAAAAAAAAAAAA");
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  test("sanitizeAndNormalizeJson throws on invalid JSON without silent fallback", () => {
    expect(() => sanitizeAndNormalizeJson("not json", "test")).toThrow();
  });

  test("sanitizeAndNormalizeJson appends trailing newline for diff stability", () => {
    const out = sanitizeAndNormalizeJson(JSON.stringify({ a: 1 }), "test", "/home/x");
    expect(out.value.endsWith("\n")).toBe(true);
  });
});

describe("secret policy", () => {
  const strict: SecretPolicy = { mode: "strict", allow: [], redactBase64: true };
  const off: SecretPolicy = { mode: "off", allow: [], redactBase64: true };

  test("securityToPolicy maps the [security] config and defaults to standard", () => {
    expect(securityToPolicy(undefined).mode).toBe("standard");
    expect(
      securityToPolicy({
        secretScan: "strict",
        allowSecretValues: ["x"],
        redactBase64Values: false,
      }),
    ).toEqual({ mode: "strict", allow: ["x"], redactBase64: false });
  });

  test("ALWAYS_BLOCK_PATTERNS is exactly the catastrophic tier", () => {
    expect(ALWAYS_BLOCK_PATTERNS.map((p) => p.name).sort()).toEqual([
      "age-secret-key",
      "private-key-pem",
    ]);
  });

  test("scanForSecrets detects a PEM private-key header in every mode, off included", () => {
    const body = "key:\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n";
    const hit = (p?: SecretPolicy) =>
      scanForSecrets(body, "/tmp/x", p).some((w) => w.includes("private-key-pem"));
    expect(hit()).toBe(true); // standard (default)
    expect(hit(strict)).toBe(true);
    expect(hit(off)).toBe(true); // catastrophic tier survives `off`
  });

  test("the vault's own age key blocks the push in every mode", () => {
    const ageKey = `AGE-SECRET-KEY-1${"A".repeat(58)}`;
    const blocks = (p?: SecretPolicy) =>
      scanForSecrets(`identity: ${ageKey}`, "/tmp/x", p).some((w) =>
        w.includes("age-secret-key"),
      );
    expect(blocks()).toBe(true); // standard
    expect(blocks(strict)).toBe(true);
    expect(blocks(off)).toBe(true); // catastrophic tier survives `off`
  });

  test("allowSecretValues can NOT exempt a catastrophic-tier value", () => {
    // Regression guard for the central guarantee: the allow-list silences
    // ordinary tokens, never the age key / PEM that decrypt the vault.
    const ageKey = `AGE-SECRET-KEY-1${"A".repeat(58)}`;
    const exempt: SecretPolicy = { mode: "off", allow: [ageKey], redactBase64: true };
    expect(scanForSecrets(ageKey, "/tmp/x", exempt)).toEqual([
      "Detected literal secret (age-secret-key) in /tmp/x",
    ]);
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const exemptPem: SecretPolicy = { mode: "standard", allow: [pem], redactBase64: true };
    expect(scanForSecrets(pem, "/tmp/x", exemptPem).some((w) => w.includes("private-key-pem"))).toBe(
      true,
    );
  });

  test("scanForSecrets flags a JWT only in strict mode", () => {
    const jwt = `eyJ${"a".repeat(12)}.eyJ${"b".repeat(12)}.${"c".repeat(12)}`;
    const body = `token: ${jwt}`;
    expect(scanForSecrets(body, "/tmp/x")).toEqual([]); // standard: not flagged
    expect(scanForSecrets(body, "/tmp/x", strict).some((w) => w.includes("jwt"))).toBe(true);
  });

  test("mode 'off' waives ordinary API-token patterns and redaction", () => {
    const secret = `ghp_${"a".repeat(36)}`;
    expect(scanForSecrets(`x ${secret}`, "/tmp/x", off)).toEqual([]);
    const redacted = redactSecretLiterals({ token: secret }, "root", off);
    expect((redacted.value as { token: string }).token).toBe(secret);
    expect(redacted.warnings).toHaveLength(0);
  });

  test("an allow-listed decoy does not mask a real secret of the same shape later", () => {
    // Regression: a non-global match would only check the FIRST occurrence, so
    // an allow-listed value earlier in the text could hide a real secret later.
    const decoy = `ghp_${"a".repeat(36)}`;
    const real = `ghp_${"b".repeat(36)}`;
    const policy: SecretPolicy = { mode: "standard", allow: [decoy], redactBase64: true };
    const warnings = scanForSecrets(`example: ${decoy}\nreal key: ${real}`, "/tmp/x", policy);
    expect(warnings.some((w) => w.includes("github-classic-pat"))).toBe(true);
  });

  test("allowSecretValues exempts a value from both the scan and the redactor", () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const policy: SecretPolicy = { mode: "standard", allow: [secret], redactBase64: true };
    expect(scanForSecrets(secret, "/tmp/x", policy)).toEqual([]);
    const redacted = redactSecretLiterals({ token: secret }, "root", policy);
    expect((redacted.value as { token: string }).token).toBe(secret);
  });

  test("redactBase64 false keeps a long base64 value while still redacting real keys", () => {
    const base64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5"; // 48 base64 chars
    const realKey = `ghp_${"a".repeat(36)}`;
    const keep: SecretPolicy = { mode: "standard", allow: [], redactBase64: false };
    const out = redactSecretLiterals({ blob: base64, tok: realKey }, "root", keep).value as {
      blob: string;
      tok: string;
    };
    expect(out.blob).toBe(base64); // base64 catch-all disabled
    expect(out.tok).toContain("REDACTED"); // a real key prefix still redacts
  });
});
