import { z } from "zod";

/**
 * Age public-key (X25519 recipient) format: `age1` HRP followed by the bech32
 * data charset. Enforced everywhere a recipient enters the system so the
 * CLI, vault config, and pulled remote state agree on what "valid" means —
 * otherwise an invalid value only surfaces inside the age library at push
 * time as an opaque error, after the snapshot pipeline has done work.
 */
export const AgePublicKeySchema = z
  .string()
  .regex(
    /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/,
    "Invalid age public key: must start with 'age1' and contain only bech32 characters",
  );

/**
 * Minimal sanity check for the vault's git remote URL. We do not try to
 * fully validate every git URL form (https, ssh, git, scp-style, file)
 * because the user-facing failure is the next `git ls-remote` / `git push`,
 * which gives a precise message. The schema only rejects strings that
 * obviously cannot be a URL at all (no protocol marker and no path
 * separator), so a typo like `branch = "main"` accidentally placed in the
 * URL field fails fast at config load.
 */
const RemoteUrlSchema = z
  .string()
  .min(1)
  .refine((url) => /[:/]/.test(url), {
    message: "remote.url does not look like a git URL (expected ':' or '/')",
  });

/**
 * Current vault format. v2 lays the vault out as `machines/<name>/<agent>/…`
 * and writes `version` as an INTEGER. This is the old-binary hard block: a v1
 * binary's `version: z.string()` schema throws on the integer, so it can never
 * load a v2 vault and write flat dirs beside `machines/`.
 */
export const CURRENT_VAULT_VERSION = 2;

/** Schema for the vault configuration file shared by every command and test. */
export const AgentSyncConfigSchema = z.object({
  version: z.literal(CURRENT_VAULT_VERSION),
  recipients: z
    .record(z.string().min(1), AgePublicKeySchema)
    .refine((r) => Object.keys(r).length > 0, {
      message: "recipients must contain at least one entry — run `agentsync key add` to add one",
    }),
  agents: z.object({
    cursor: z.boolean().default(true),
    claude: z.boolean().default(true),
    codex: z.boolean().default(true),
    copilot: z.boolean().default(true),
    vscode: z.boolean().default(false),
  }),
  remote: z.object({
    url: RemoteUrlSchema,
    branch: z.string().min(1).default("main"),
  }),
  sync: z.object({
    debounceMs: z.number().int().min(50).max(10_000).default(300),
    autoPush: z.boolean().default(true),
  }),
  // Per-agent plugin opt-ins. Optional with safe defaults so existing
  // agentsync.toml files continue to validate without changes.
  claudePlugins: z.preprocess(
    // Back-compat: the opt-in was renamed `syncMarketplace` → `syncPlugins`
    // when plugin sync moved from encrypting the marketplace-catalog tree to a
    // distilled reinstall manifest. Map a legacy key so old configs keep loading.
    (val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        const obj = val as Record<string, unknown>;
        if (!("syncPlugins" in obj) && "syncMarketplace" in obj) {
          const { syncMarketplace, ...rest } = obj;
          return { ...rest, syncPlugins: syncMarketplace };
        }
      }
      return val;
    },
    z
      .object({
        // Capture `~/.claude/plugins/` as a reinstall manifest in the vault.
        // Off by default — the manifest can reference third-party marketplaces,
        // so teams opt in explicitly.
        syncPlugins: z.boolean().default(false),
      })
      .default({ syncPlugins: false }),
  ),
  // Secret-handling policy honoured by the push-time secret scanner and the
  // JSON redactor (`src/core/sanitizer.ts`, resolved via `securityToPolicy`).
  // Optional with safe defaults so existing agentsync.toml files validate
  // unchanged. The schema is not `.strict()`, so an older binary that predates
  // this section ignores it on load rather than failing — no version bump.
  security: z
    .object({
      // How the push-time secret scan behaves:
      //   standard — the built-in high-precision credential patterns (default)
      //   strict   — standard plus JWT detection
      //   off      — waive the ordinary API-token patterns (values ride in
      //              encrypted). The catastrophic tier (the vault's own age
      //              key, PEM private keys) still blocks the push in EVERY mode.
      secretScan: z.enum(["standard", "strict", "off"]).default("standard"),
      // Literal values to exempt from secret detection AND base64 redaction.
      // The escape hatch for a legitimate high-entropy config value that the
      // scanner/redactor would otherwise flag or silently replace.
      allowSecretValues: z.array(z.string()).default([]),
      // When true (default), a whole JSON string value that looks like base64
      // (40+ chars) is replaced with a redaction placeholder. Set false when a
      // config legitimately stores long base64 values that must round-trip.
      redactBase64Values: z.boolean().default(true),
    })
    .default({ secretScan: "standard", allowSecretValues: [], redactBase64Values: true }),
});

/** Normalized runtime shape derived from the validated config schema. */
export type AgentSyncConfig = z.infer<typeof AgentSyncConfigSchema>;

/**
 * Schema for the status payload returned by the daemon's IPC `status` command.
 * All fields crossing the IPC trust boundary are validated with Zod per Constitution IV.
 */
export const DaemonStatusSchema = z.object({
  pid: z.number().int().positive(),
  consecutiveFailures: z.number().int().min(0),
  lastError: z.string().nullable(),
  // Health fields. Optional with defaults so an older daemon's IPC response
  // (which omits them) still validates against a newer client. Timestamps are
  // validated as ISO datetimes so a malformed value fails safeParse (degrading
  // to null) rather than reaching Date.parse as NaN in the dashboard/status.
  lastSuccessAt: z.string().datetime().nullable().default(null),
  startedAt: z.string().datetime().nullable().default(null),
  stuck: z.boolean().default(false),
});

/** Normalized status shape for the daemon IPC status response. */
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

/** Valid agent names accepted by CLI arguments. */
const AgentNameEnum = z.enum(["claude", "cursor", "codex", "copilot", "vscode"]);

/** Valid config types for the migrate command's --type flag. */
const ConfigTypeEnum = z.enum(["global-rules", "mcp", "commands", "skills", "rules"]);

/**
 * Schema for the `migrate` command's CLI arguments.
 * Validated per Constitution Principle IV (CLI arguments cross a trust boundary).
 */
export const MigrateOptionsSchema = z
  .object({
    from: AgentNameEnum,
    to: z.union([AgentNameEnum, z.literal("all")]),
    type: ConfigTypeEnum.optional(),
    name: z.string().optional(),
    dryRun: z.boolean().default(false),
  })
  .refine((opts) => opts.to === "all" || opts.from !== opts.to, {
    message: "Source and target agent must be different",
  })
  .refine((opts) => !opts.name || opts.type !== undefined, {
    message: "--name requires --type to be specified",
  });

/** Validated migrate options shape. */
export type MigrateOptions = z.infer<typeof MigrateOptionsSchema>;
