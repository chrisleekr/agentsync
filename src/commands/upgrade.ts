import { log } from "@clack/prompts";
import { defineCommand } from "citty";
import {
  getUpdateStatus,
  type InstallMethod,
  RELEASES_PAGE,
  type UpdateStatus,
} from "../core/version-check";

export interface UpgradeResult {
  /** True only when an in-place upgrade actually ran. */
  upgraded: boolean;
  /** User-facing line describing what happened or what to do next. */
  message: string;
}

/**
 * Guidance for install methods that cannot upgrade themselves: a standalone
 * binary cannot overwrite its own running file, bunx refetches every run, and
 * a dev checkout updates through git.
 */
export function upgradeInstructions(method: InstallMethod, latest: string): string {
  switch (method) {
    case "standalone":
      return `Download v${latest} from ${RELEASES_PAGE} and replace the binary — verify it against SHA256SUMS first.`;
    case "bunx":
      return `bunx always runs the latest — re-run your command to pick up v${latest}.`;
    default:
      return `Running from a source checkout — git pull to reach v${latest}.`;
  }
}

/**
 * Apply an available update. Only `npm-global` installs are upgraded in
 * place, by reinstalling the package globally with the same bun running this
 * process; every other method returns instructions instead.
 */
export async function performUpgrade(status: UpdateStatus): Promise<UpgradeResult> {
  if (!status.updateAvailable || status.latest === null) {
    return { upgraded: false, message: `Already on the latest version (v${status.current}).` };
  }
  if (status.method !== "npm-global") {
    return { upgraded: false, message: upgradeInstructions(status.method, status.latest) };
  }

  // process.execPath is the bun binary here: detectInstallMethod only returns
  // `npm-global` for a bun-launched process, so this branch is bun by construction.
  const proc = Bun.spawnSync(
    [process.execPath, "install", "-g", `@chrisleekr/agentsync@${status.latest}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim() || `exit code ${proc.exitCode}`;
    throw new Error(`Global reinstall failed: ${detail}`);
  }
  return { upgraded: true, message: `Updated to v${status.latest}. Restart agentsync to apply.` };
}

/** Check for and install the latest published version. */
export const upgradeCommand = defineCommand({
  meta: {
    name: "upgrade",
    description: "Check for and install the latest version",
  },
  args: {
    check: {
      type: "boolean",
      description: "Only report whether an update is available, install nothing",
      default: false,
    },
  },
  async run({ args }) {
    const status = await getUpdateStatus({ forceRefresh: true });
    if (status.latest === null) {
      log.warn("Could not reach GitHub to check for updates. Try again later.");
      process.exitCode = 1;
      return;
    }
    if (!status.updateAvailable) {
      log.success(`agentsync v${status.current} is the latest version.`);
      return;
    }
    log.info(`Update available: v${status.current} -> v${status.latest}`);
    if (args.check) return;
    const result = await performUpgrade(status);
    if (result.upgraded) log.success(result.message);
    else log.info(result.message);
  },
});
