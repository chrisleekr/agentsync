/**
 * src/core/ipc.ts
 *
 * Minimal Unix socket / Windows named-pipe IPC for daemon ↔ CLI communication.
 *
 * Protocol: newline-delimited JSON messages.
 *   Request:  { id: string; cmd: string; args?: unknown }
 *   Response: { id: string; ok: boolean; data?: unknown; error?: string }
 */

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { resolveDaemonSocketPath } from "../config/paths";

/** Request envelope sent from CLI clients to the daemon IPC server. */
export interface IpcRequest {
  id: string;
  cmd: string;
  args?: unknown;
}

/** Response envelope returned by the daemon IPC server. */
export interface IpcResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Async daemon handler registered for one IPC command name. */
export type CommandHandler = (args: unknown) => Promise<unknown>;

/** Minimal newline-delimited JSON IPC server used by the background daemon. */
export class IpcServer {
  private server: Server | null = null;
  private readonly handlers = new Map<string, CommandHandler>();

  /** Register a handler for one command name. */
  on(cmd: string, handler: CommandHandler): void {
    this.handlers.set(cmd, handler);
  }

  /** Start listening on the daemon socket or named pipe. */
  async listen(socketPath = resolveDaemonSocketPath()): Promise<void> {
    // Remove a stale socket file left by a previous crash so we don't get EADDRINUSE.
    try {
      await unlink(socketPath);
    } catch {
      // Socket didn't exist — that's fine.
    }
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket));
      this.server.on("error", reject);
      this.server.listen(socketPath, () => resolve());
    });
  }

  /** Stop accepting new IPC connections. */
  close(): void {
    this.server?.close();
  }

  private handleConnection(socket: Socket): void {
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        void this.handleMessage(socket, line);
        idx = buffer.indexOf("\n");
      }
    });
  }

  private async handleMessage(socket: Socket, line: string): Promise<void> {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      return;
    }

    const handler = this.handlers.get(req.cmd);
    let resp: IpcResponse;

    if (!handler) {
      resp = { id: req.id, ok: false, error: `Unknown command: ${req.cmd}` };
    } else {
      try {
        const data = await handler(req.args);
        resp = { id: req.id, ok: true, data };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resp = { id: req.id, ok: false, error: msg };
      }
    }

    socket.write(`${JSON.stringify(resp)}\n`);
  }
}

/** Minimal IPC client used by CLI commands to talk to the daemon. */
export class IpcClient {
  /** Send one command to the daemon and await the matching response envelope. */
  async send(
    cmd: string,
    args?: unknown,
    socketPath = resolveDaemonSocketPath(),
  ): Promise<IpcResponse> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      const id = randomUUID();
      let buffer = "";

      socket.setEncoding("utf8");

      socket.on("connect", () => {
        const req: IpcRequest = { id, cmd, args };
        socket.write(`${JSON.stringify(req)}\n`);
      });

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          try {
            const resp = JSON.parse(line) as IpcResponse;
            if (resp.id === id) {
              socket.destroy();
              resolve(resp);
            }
          } catch {
            // ignore malformed lines
          }
          idx = buffer.indexOf("\n");
        }
      });

      socket.on("error", reject);

      // Timeout after 5 seconds
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error("IPC request timed out"));
      });
    });
  }
}
