import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import { type PluginManifest, parsePluginManifest } from "../agents/claude/plugin-manifest";
import { machineVaultRoot } from "../config/paths";
import { decryptString } from "../core/encryptor";
import { GitClient } from "../core/git";
import { listMachines } from "./copy";
import { loadPrivateKey, loadVaultConfigOrExit, resolveRuntimeContext } from "./shared";

/** Machine-root-relative path of the plugin reinstall manifest. */
const MANIFEST_REL = join("claude", "plugins.manifest.json.age");

/**
 * Injectable wrapper around the `claude` CLI so the install core is unit
 * testable without the binary. The default implementation shells out via
 * Bun.spawnSync, mirroring how skill.ts invokes `git`.
 */
export interface ClaudeRunner {
  /** Whether the `claude` binary is resolvable on PATH. */
  available(): boolean;
  /** Run `claude <args>` synchronously and capture the outcome. */
  run(args: string[]): { exitCode: number; stdout: string; stderr: string };
}

const defaultClaudeRunner: ClaudeRunner = {
  available: () => Bun.which("claude") !== null,
  run: (args) => {
    const r = Bun.spawnSync(["claude", ...args]);
    return {
      exitCode: r.exitCode,
      stdout: new TextDecoder().decode(r.stdout),
      stderr: new TextDecoder().decode(r.stderr),
    };
  },
};

/** Outcome of loading a machine's manifest from the vault. */
type ManifestLoad =
  | { status: "ok"; machine: string; manifest: PluginManifest }
  | { status: "unknown-machine"; provided: string; available: string[] }
  | { status: "not-found"; machine: string }
  | { status: "reconcile-error"; error: string }
  | { status: "error"; error: string };

/**
 * Reconcile fast-forward-only, resolve the source machine, then decrypt and
 * parse its plugin manifest. Shared by `plugin list` and `plugin install`.
 */
async function loadManifest(fromMachine: string): Promise<ManifestLoad> {
  const runtime = await resolveRuntimeContext();
  const config = await loadVaultConfigOrExit(runtime.vaultDir);

  const git = new GitClient(runtime.vaultDir);
  try {
    await git.reconcileWithRemote({
      remote: "origin",
      branch: config.remote.branch,
      allowMissingRemote: true,
    });
  } catch (err) {
    return { status: "reconcile-error", error: err instanceof Error ? err.message : String(err) };
  }

  const machine = fromMachine === "self" ? runtime.machineName : fromMachine;
  const machines = await listMachines(runtime.vaultDir);
  if (!machines.includes(machine)) {
    return { status: "unknown-machine", provided: fromMachine, available: machines };
  }

  const path = join(machineVaultRoot(runtime.vaultDir, machine), MANIFEST_REL);
  let encrypted: string;
  try {
    encrypted = await readFile(path, "utf8");
  } catch {
    return { status: "not-found", machine };
  }
  try {
    const key = await loadPrivateKey(runtime.privateKeyPath);
    const manifest = parsePluginManifest(await decryptString(encrypted, key));
    return { status: "ok", machine, manifest };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export type PluginListResult = ManifestLoad;

/** Read a machine's plugin manifest (no side effects). */
export async function performPluginList(options: {
  fromMachine: string;
}): Promise<PluginListResult> {
  return loadManifest(options.fromMachine);
}

/** Discriminated result of `plugin install`. */
export type PluginInstallResult =
  | { status: "ok"; machine: string; installed: string[]; warnings: string[] }
  | { status: "claude-missing" }
  | { status: "unknown-machine"; provided: string; available: string[] }
  | { status: "not-found"; machine: string }
  | { status: "unknown-plugin"; name: string; available: string[] }
  | { status: "reconcile-error"; error: string }
  | { status: "install-error"; plugin: string; error: string }
  | { status: "error"; error: string };

/**
 * Reinstall the plugins recorded in `fromMachine`'s manifest by invoking the
 * local `claude` CLI: register each referenced marketplace, install each plugin
 * at its recorded scope, then enable/disable per the manifest. A missing
 * `claude` binary fails loudly rather than silently skipping. `marketplace add`
 * is best-effort (it errors when already registered); the subsequent `install`
 * exit code is the real gate.
 *
 * Tradeoffs (surfaced in command help + docs): reinstall fetches the latest
 * version — there is no version pin — and local edits to plugin files are not
 * preserved.
 */
export async function performPluginInstall(options: {
  fromMachine: string;
  name?: string;
  runner?: ClaudeRunner;
}): Promise<PluginInstallResult> {
  const claude = options.runner ?? defaultClaudeRunner;
  if (!claude.available()) return { status: "claude-missing" };

  const loaded = await loadManifest(options.fromMachine);
  if (loaded.status !== "ok") return loaded;
  const { manifest, machine } = loaded;

  let targets = manifest.plugins;
  if (options.name !== undefined) {
    targets = manifest.plugins.filter((p) => p.name === options.name);
    if (targets.length === 0) {
      return {
        status: "unknown-plugin",
        name: options.name,
        available: [...new Set(manifest.plugins.map((p) => p.name))],
      };
    }
  }

  const warnings: string[] = [];

  // Register only the marketplaces the chosen plugins reference.
  const needed = new Set(targets.map((t) => t.marketplace));
  for (const m of manifest.marketplaces) {
    if (!needed.has(m.name)) continue;
    const r = claude.run(["plugin", "marketplace", "add", m.source]);
    if (r.exitCode !== 0) {
      warnings.push(
        `marketplace add ${m.name} (${m.source}) exited ${r.exitCode}: ${r.stderr.trim()} — continuing (it may already be registered)`,
      );
    }
  }

  const installed: string[] = [];
  for (const p of targets) {
    const ref = `${p.name}@${p.marketplace}`;
    const ins = claude.run(["plugin", "install", ref, "-s", p.scope]);
    if (ins.exitCode !== 0) {
      return {
        status: "install-error",
        plugin: ref,
        error: ins.stderr.trim() || `exit ${ins.exitCode}`,
      };
    }
    const verb = p.enabled ? "enable" : "disable";
    const tog = claude.run(["plugin", verb, ref, "-s", p.scope]);
    if (tog.exitCode !== 0) {
      warnings.push(`${verb} ${ref} exited ${tog.exitCode}: ${tog.stderr.trim()}`);
    }
    installed.push(ref);
  }

  return { status: "ok", machine, installed, warnings };
}

/** Map a non-ok manifest load to the right log line + exit code. */
function reportLoadFailure(machine: string, result: Exclude<ManifestLoad, { status: "ok" }>): void {
  switch (result.status) {
    case "unknown-machine":
      log.error(
        `Unknown machine: ${result.provided}. Available: ${result.available.join(", ") || "(none)"}`,
      );
      break;
    case "not-found":
      log.error(
        `No plugin manifest for ${result.machine}. Run \`agentsync push\` with [claudePlugins] syncPlugins = true on that machine first.`,
      );
      break;
    case "reconcile-error":
    case "error":
      log.error(result.error);
      break;
  }
  process.exitCode = 1;
}

export const pluginCommand = defineCommand({
  meta: {
    name: "plugin",
    description: "List or reinstall a machine's Claude plugins from its vault manifest",
  },
  subCommands: {
    list: defineCommand({
      meta: {
        name: "list",
        description: "Print the plugin manifest recorded for a machine",
      },
      args: {
        machine: {
          type: "positional",
          required: true,
          description: "Source machine namespace, or `self`",
        },
      },
      async run({ args }) {
        const result = await performPluginList({ fromMachine: String(args.machine) });
        if (result.status !== "ok") {
          reportLoadFailure(String(args.machine), result);
          return;
        }
        const { manifest } = result;
        log.info(`Marketplaces (${manifest.marketplaces.length}):`);
        for (const m of manifest.marketplaces) log.message(`  ${m.name} → ${m.source}`);
        log.info(`Plugins (${manifest.plugins.length}):`);
        for (const p of manifest.plugins) {
          log.message(
            `  ${p.name}@${p.marketplace} [${p.scope}] ${p.enabled ? "enabled" : "disabled"}`,
          );
        }
      },
    }),
    install: defineCommand({
      meta: {
        name: "install",
        description:
          "Reinstall a machine's plugins via the local `claude` CLI. Fetches the latest version (no pin); local plugin-file edits are not preserved.",
      },
      args: {
        machine: {
          type: "positional",
          required: true,
          description: "Source machine namespace, or `self`",
        },
        name: {
          type: "positional",
          required: false,
          description: "Install only this plugin (defaults to all in the manifest)",
        },
      },
      async run({ args }) {
        const result = await performPluginInstall({
          fromMachine: String(args.machine),
          name: args.name !== undefined ? String(args.name) : undefined,
        });
        switch (result.status) {
          case "ok": {
            log.success(`Installed ${result.installed.length} plugin(s) from ${result.machine}`);
            for (const w of result.warnings) log.warn(w);
            return;
          }
          case "claude-missing":
            log.error("`claude` is not on PATH. Install the Claude Code CLI, then re-run.");
            process.exitCode = 1;
            return;
          case "unknown-plugin":
            log.error(
              `Plugin not in manifest: ${result.name}. Available: ${result.available.join(", ") || "(none)"}`,
            );
            process.exitCode = 1;
            return;
          case "install-error":
            log.error(`claude plugin install ${result.plugin} failed: ${result.error}`);
            process.exitCode = 1;
            return;
          default:
            reportLoadFailure(String(args.machine), result);
            return;
        }
      },
    }),
  },
});
