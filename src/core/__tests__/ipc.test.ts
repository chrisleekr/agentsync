import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir } from "../../test-helpers/fixtures";
import { IpcClient, IpcServer } from "../ipc";

// T029-T032 — IPC server/client communication
// NOTE: macOS has a 104-char hard limit on Unix socket paths.
// os.tmpdir() returns /var/folders/... which is ~50 chars before the filename,
// making the full path exceed 104 chars. We use /tmp directly (always short on macOS).

describe("IpcServer + IpcClient", () => {
  let tmpDir: string;
  let socketPath: string;
  let server: IpcServer;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    // Use a short /tmp path to stay within macOS's 104-char socket path limit.
    socketPath = `/tmp/as-${Math.random().toString(36).slice(2, 10)}.sock`;
    server = new IpcServer();
  });

  afterEach(async () => {
    server.close();
    try {
      await unlink(socketPath);
    } catch {
      // already gone
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  // T029 — happy path roundtrip
  test("registered handler returns { ok: true, data } for a matching command", async () => {
    server.on("ping", async (args) => ({ pong: true, received: args }));
    await server.listen(socketPath);

    const client = new IpcClient();
    const resp = await client.send("ping", { hello: "world" }, socketPath);

    expect(resp.ok).toBe(true);
    expect((resp.data as { pong: boolean }).pong).toBe(true);
    expect((resp.data as { received: unknown }).received).toEqual({
      hello: "world",
    });
  });

  // T030 — unknown command
  test("unknown command returns { ok: false, error } without crashing the server", async () => {
    await server.listen(socketPath);

    const client = new IpcClient();
    const resp = await client.send("nonexistent-cmd", undefined, socketPath);

    expect(resp.ok).toBe(false);
    expect(typeof resp.error).toBe("string");
    expect(resp.error).toContain("Unknown command");
  });

  // T031 — no daemon listening
  test("IpcClient rejects promptly when no server is at the socket path", async () => {
    const client = new IpcClient();
    const nonexistent = join(tmpDir, "does-not-exist.sock");

    await expect(client.send("ping", undefined, nonexistent)).rejects.toThrow();
  });

  // T032 — stale socket recovery
  test("IpcServer.listen removes a stale socket file and starts successfully", async () => {
    // Plant a stale file where the socket will be
    await Bun.write(socketPath, "stale-socket-data");
    expect(await Bun.file(socketPath).exists()).toBe(true);

    server.on("check", async () => "alive");
    await server.listen(socketPath);

    const client = new IpcClient();
    const resp = await client.send("check", undefined, socketPath);

    expect(resp.ok).toBe(true);
    expect(resp.data).toBe("alive");
  });
});
