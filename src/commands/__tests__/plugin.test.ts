import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { machineVaultRoot } from "../../config/paths";
import { encryptString } from "../../core/encryptor";
import {
  createBareRepo,
  createMachineFixture,
  createTmpDir,
  runGit,
  seedVaultRepo,
  type TestMachineFixture,
} from "../../test-helpers/fixtures";
import type { ClaudeRunner } from "../plugin";

const RUNTIME_ENV_KEYS = [
  "AGENTSYNC_VAULT_DIR",
  "AGENTSYNC_KEY_PATH",
  "AGENTSYNC_MACHINE",
  "AGENTSYNC_MACHINE_FILE",
];

const MANIFEST = {
  marketplaces: [{ name: "official", source: "anthropics/official" }],
  plugins: [
    { name: "toolkit", marketplace: "official", scope: "user", enabled: true },
    { name: "extra", marketplace: "official", scope: "user", enabled: false },
  ],
};

/** A ClaudeRunner that records every invocation and can be told to fail. */
function fakeRunner(opts?: { available?: boolean; fail?: (args: string[]) => boolean }): {
  calls: string[][];
  runner: ClaudeRunner;
} {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      available: () => opts?.available ?? true,
      run: (args) => {
        calls.push(args);
        const fail = opts?.fail?.(args) ?? false;
        return { exitCode: fail ? 1 : 0, stdout: "", stderr: fail ? "boom" : "" };
      },
    },
  };
}

describe("plugin list / install", () => {
  let tmpDir: string;
  let machine: TestMachineFixture;
  let pluginMod: typeof import("../plugin");
  const savedEnv: Record<string, string | undefined> = {};

  async function seedManifest(manifest: unknown): Promise<void> {
    const root = machineVaultRoot(machine.vaultDir, machine.machineName);
    await mkdir(join(root, "claude"), { recursive: true });
    await writeFile(
      join(root, "claude", "plugins.manifest.json.age"),
      await encryptString(JSON.stringify(manifest), [machine.recipient]),
      "utf8",
    );
  }

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    const bareRepoPath = await createBareRepo(tmpDir);
    machine = await createMachineFixture(tmpDir, "host-self");
    seedVaultRepo({ machine, bareRepoPath });
    runGit(["config", "user.name", "t"], machine.vaultDir);
    runGit(["config", "user.email", "t@t"], machine.vaultDir);

    for (const k of RUNTIME_ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.AGENTSYNC_VAULT_DIR = machine.vaultDir;
    process.env.AGENTSYNC_KEY_PATH = machine.keyPath;
    process.env.AGENTSYNC_MACHINE = machine.machineName;
    process.env.AGENTSYNC_MACHINE_FILE = machine.machineFilePath;
    pluginMod = await import("../plugin");
  });

  afterEach(async () => {
    for (const k of RUNTIME_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("list returns the decrypted manifest for `self`", async () => {
    await seedManifest(MANIFEST);
    const result = await pluginMod.performPluginList({ fromMachine: "self" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.manifest.marketplaces).toEqual(MANIFEST.marketplaces);
      expect(result.manifest.plugins).toEqual(MANIFEST.plugins);
    }
  });

  test("list is not-found when the machine has no manifest", async () => {
    // The namespace must exist (else it resolves to unknown-machine); only the
    // manifest file is absent.
    await mkdir(join(machineVaultRoot(machine.vaultDir, machine.machineName), "claude"), {
      recursive: true,
    });
    const result = await pluginMod.performPluginList({ fromMachine: "self" });
    expect(result.status).toBe("not-found");
  });

  test("list is unknown-machine for an unseeded namespace", async () => {
    const result = await pluginMod.performPluginList({ fromMachine: "ghost" });
    expect(result.status).toBe("unknown-machine");
  });

  test("install registers the marketplace, installs each plugin, and toggles enabled state", async () => {
    await seedManifest(MANIFEST);
    const { calls, runner } = fakeRunner();
    const result = await pluginMod.performPluginInstall({ fromMachine: "self", runner });

    expect(result.status).toBe("ok");
    if (result.status === "ok")
      expect(result.installed).toEqual(["toolkit@official", "extra@official"]);

    expect(calls).toContainEqual(["plugin", "marketplace", "add", "anthropics/official"]);
    expect(calls).toContainEqual(["plugin", "install", "toolkit@official", "-s", "user"]);
    expect(calls).toContainEqual(["plugin", "enable", "toolkit@official", "-s", "user"]);
    expect(calls).toContainEqual(["plugin", "install", "extra@official", "-s", "user"]);
    // extra is disabled in the manifest → disable, not enable.
    expect(calls).toContainEqual(["plugin", "disable", "extra@official", "-s", "user"]);
  });

  test("install only the named plugin, registering only its marketplace", async () => {
    await seedManifest(MANIFEST);
    const { calls, runner } = fakeRunner();
    const result = await pluginMod.performPluginInstall({
      fromMachine: "self",
      name: "toolkit",
      runner,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.installed).toEqual(["toolkit@official"]);
    expect(calls.some((c) => c.includes("extra@official"))).toBeFalse();
  });

  test("install fails loudly when `claude` is not on PATH", async () => {
    await seedManifest(MANIFEST);
    const { runner } = fakeRunner({ available: false });
    const result = await pluginMod.performPluginInstall({ fromMachine: "self", runner });
    expect(result.status).toBe("claude-missing");
  });

  test("install reports unknown-plugin when the name is not in the manifest", async () => {
    await seedManifest(MANIFEST);
    const { runner } = fakeRunner();
    const result = await pluginMod.performPluginInstall({
      fromMachine: "self",
      name: "nope",
      runner,
    });
    expect(result.status).toBe("unknown-plugin");
    if (result.status === "unknown-plugin") expect(result.available).toContain("toolkit");
  });

  test("install surfaces a failed `claude plugin install` as install-error", async () => {
    await seedManifest(MANIFEST);
    const { runner } = fakeRunner({ fail: (args) => args[1] === "install" });
    const result = await pluginMod.performPluginInstall({ fromMachine: "self", runner });
    expect(result.status).toBe("install-error");
    if (result.status === "install-error") expect(result.plugin).toBe("toolkit@official");
  });

  test("install tolerates a failed `marketplace add` (already registered) and continues", async () => {
    await seedManifest(MANIFEST);
    const { runner } = fakeRunner({ fail: (args) => args[1] === "marketplace" });
    const result = await pluginMod.performPluginInstall({ fromMachine: "self", runner });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.installed.length).toBe(2);
      expect(result.warnings.some((w) => w.includes("marketplace add"))).toBeTrue();
    }
  });
});
