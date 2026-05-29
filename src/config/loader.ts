import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "@iarna/toml";
import { z } from "zod";
import { type AgentSyncConfig, AgentSyncConfigSchema } from "./schema";

/** Read and validate the vault config, stripping TOML symbol metadata before Zod parsing. */
export async function loadConfig(configPath: string): Promise<AgentSyncConfig> {
  const raw = await readFile(configPath, "utf8");
  const parsed = parse(raw) as unknown;
  // @iarna/toml attaches Symbol(type) and Symbol(declared) to every parsed table.
  // Zod v4 z.record() uses Reflect.ownKeys() which includes Symbol keys, causing
  // ZodError 'invalid_key'. structuredClone() strips Symbol-keyed properties.
  return AgentSyncConfigSchema.parse(structuredClone(parsed));
}

/**
 * Persist a validated config object to the canonical agentsync TOML location.
 *
 * agentsync.toml gates every command through loadConfig, and a plain writeFile
 * opens with O_TRUNC: a crash, SIGKILL, OOM-kill, or power loss mid-write leaves
 * the file empty or partial, after which loadConfig throws and the vault bricks.
 *
 * Write to a unique sibling temp file, fsync it, then rename it over the
 * destination. rename(2) is atomic on a single filesystem (the temp sits in the
 * same dir), so a crash always leaves either the old file or the new file fully
 * intact, never a truncated middle — that atomicity is the core guarantee. The
 * temp fsync also forces the bytes to disk before the file is visible under the
 * canonical name, so a reader never sees a rename pointing at unwritten data;
 * this is why the read-after-write in our own tests is safe here even though the
 * deliberately-non-atomic atomicWrite in agents/_utils.ts dropped rename to dodge
 * a Bun-on-tmpfs visibility race. Config needs real durability that atomicWrite
 * forgoes, so we keep the rename and pay for the fsync.
 *
 * The temp name is randomized so two concurrent writers (e.g. overlapping key
 * commands) never share a scratch file and clobber each other's bytes.
 */
export async function writeConfig(configPath: string, config: AgentSyncConfig): Promise<void> {
  const dir = dirname(configPath);
  await mkdir(dir, { recursive: true });
  const serialized = stringify(config as unknown as Parameters<typeof stringify>[0]);
  const tmpPath = `${configPath}.${randomUUID()}.tmp`;
  const handle = await open(tmpPath, "w");
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, configPath);
  } catch (err) {
    // Rename failed, so the destination is untouched. Drop the temp file so a
    // failed write never leaks a partial agentsync.toml temp into the vault tree.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  // Best-effort: persist the directory entry the rename created so the switch to
  // the new file survives power loss, not just the file's contents. Some
  // platforms (Windows) reject fsync on a directory fd, so a failure here is
  // non-fatal — the rename has already happened.
  try {
    const dirHandle = await open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync unsupported on this platform; the atomicity guarantee holds.
  }
}

/** Build the canonical config path inside a vault directory. */
export function resolveConfigPath(vaultDir: string): string {
  return join(vaultDir, "agentsync.toml");
}

/** True when a loadConfig failure is a schema (Zod) or TOML syntax error. */
export function isConfigParseError(err: unknown): boolean {
  return err instanceof z.ZodError || (err instanceof Error && err.name === "TomlError");
}

/**
 * Render a loadConfig failure as a single actionable line instead of a raw
 * Zod/Toml stack trace. loadConfig can throw a ZodError (schema), a TomlError
 * (syntax), or a generic error; each collapses to `<path>: what is wrong` so
 * CLI users and the supervised daemon get a parseable diagnostic rather than a
 * multi-line blob. Zod issues are capped at three to keep the line readable.
 */
export function formatConfigError(err: unknown, configPath: string): string {
  if (err instanceof z.ZodError) {
    const parts = err.issues.slice(0, 3).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    });
    const suffix = err.issues.length > 3 ? ` (+${err.issues.length - 3} more)` : "";
    return `Invalid config in ${configPath}: ${parts.join("; ")}${suffix}`;
  }
  if (err instanceof Error && err.name === "TomlError") {
    // @iarna/toml's message already names the row/col with a caret diagram; its
    // first line carries the human-readable location, so keep just that.
    const firstLine = (err.message.split("\n", 1)[0] ?? "").replace(/:\s*$/, "");
    return `Invalid TOML in ${configPath}: ${firstLine}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Failed to load config ${configPath}: ${message}`;
}
