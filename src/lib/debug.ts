export const isDebug = process.env.AGENTSYNC_DEBUG === "1";

export function debug(msg: string): void {
  if (isDebug) process.stderr.write(`[debug] ${msg}\n`);
}
