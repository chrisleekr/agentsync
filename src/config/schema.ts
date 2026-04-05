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
