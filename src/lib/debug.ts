/** Toggle for stderr debug logging used by low-level helpers. */
export const isDebug = process.env.AGENTSYNC_DEBUG === "1";

/** Write a single debug line when debug mode is enabled. */
export function debug(msg: string): void {
  if (isDebug) process.stderr.write(`[debug] ${msg}\n`);
}
