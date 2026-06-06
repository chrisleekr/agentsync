import { resolveDaemonSocketPath } from "../../../config/paths";
import type { DaemonStatus } from "../../../config/schema";
import { DaemonStatusSchema } from "../../../config/schema";
import { IpcClient } from "../../../core/ipc";

/** Thin TUI-facing wrapper around the daemon IPC client. */
export class TuiIpcClient {
  private readonly socketPath: string;

  constructor() {
    this.socketPath = resolveDaemonSocketPath();
  }

  /**
   * Probe the daemon's status. Returns null when the daemon is not running
   * (ECONNREFUSED / ENOENT); throws only on unexpected errors that should
   * surface to the user.
   */
  async status(): Promise<DaemonStatus | null> {
    try {
      const client = new IpcClient();
      const response = await client.send("status", {}, this.socketPath);
      if (!response.ok) return null;
      const parsed = DaemonStatusSchema.safeParse(response.data);
      return parsed.success ? parsed.data : null;
    } catch (err) {
      if (isDaemonOffline(err)) return null;
      throw err;
    }
  }

  async push(): Promise<{ ok: boolean; error?: string }> {
    return this.invoke("push");
  }

  private async invoke(cmd: "push"): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = new IpcClient();
      const response = await client.send(cmd, {}, this.socketPath);
      if (response.ok) return { ok: true };
      return { ok: false, error: response.error ?? "unknown" };
    } catch (err) {
      if (isDaemonOffline(err)) return { ok: false, error: "daemon-offline" };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function isDaemonOffline(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  if (code === "ECONNREFUSED" || code === "ENOENT") return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("ECONNREFUSED") || message.includes("ENOENT");
}
