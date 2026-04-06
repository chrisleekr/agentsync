import { z } from "zod";

/** Schema for the vault configuration file shared by every command and test. */
export const AgentSyncConfigSchema = z.object({
  version: z.string().default("1"),
  recipients: z.record(z.string().min(1), z.string().min(1)),
  agents: z.object({
    cursor: z.boolean().default(true),
    claude: z.boolean().default(true),
    codex: z.boolean().default(true),
    copilot: z.boolean().default(true),
    vscode: z.boolean().default(false),
  }),
  remote: z.object({
    url: z.string().min(1),
    branch: z.string().default("main"),
  }),
  sync: z.object({
    debounceMs: z.number().int().min(50).max(10_000).default(300),
    autoPush: z.boolean().default(true),
    autoPull: z.boolean().default(true),
    pullIntervalMs: z.number().int().min(1_000).default(300_000),
  }),
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
});

/** Normalized status shape for the daemon IPC status response. */
export type DaemonStatus = z.infer<typeof DaemonStatusSchema>;

/** Valid agent names accepted by CLI arguments. */
const AgentNameEnum = z.enum(["claude", "cursor", "codex", "copilot", "vscode"]);

/** Valid config types for the migrate command's --type flag. */
const ConfigTypeEnum = z.enum(["global-rules", "mcp", "commands"]);

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
