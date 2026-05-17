/**
 * Records the TUI demo GIF end to end: stand up a fake-data sandbox, run
 * `vhs`, then tear the sandbox down.
 *
 * The sandbox paths reach `vhs` as the AGENTSYNC_DEMO_HOME and
 * AGENTSYNC_DEMO_REPO env vars, never baked into the tape. The tape's
 * `agentsync` shell function reads them to point HOME at the sandbox and
 * locate the CLI source, so `demo/tui.tape` stays static and reviewable.
 *
 * Pass `--keep` to leave the sandbox in place for debugging.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setupDemoSandbox } from "./demo-setup";

const REPO_ROOT = join(import.meta.dir, "..");
const SANDBOX = join(REPO_ROOT, ".demo-sandbox");
const TAPE = join(REPO_ROOT, "demo", "tui.tape");

/** Exit with an install hint if `vhs` is not on PATH. */
function requireVhs(): void {
  // Bun.spawnSync throws (does not return a non-zero exit) when the binary is
  // not found, so a missing `vhs` surfaces as an exception here.
  let exitCode = 1;
  try {
    exitCode = Bun.spawnSync(["vhs", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode;
  } catch {
    exitCode = 1;
  }
  if (exitCode !== 0) {
    console.error(
      "vhs is not installed. Install it first:\n" +
        "  macOS:  brew install vhs\n" +
        "  other:  https://github.com/charmbracelet/vhs#installation",
    );
    process.exit(1);
  }
}

function main(): void {
  const keepSandbox = process.argv.includes("--keep");
  requireVhs();

  console.log("Setting up the demo sandbox...");
  const sandbox = setupDemoSandbox();

  console.log("Recording the TUI tour with vhs...");
  const record = Bun.spawnSync(["vhs", TAPE], {
    cwd: REPO_ROOT,
    // HOME is NOT overridden here: vhs drives a headless browser that caches
    // under the real HOME. The tape's `agentsync` shell function reads these
    // two vars to point HOME at the sandbox and locate the CLI source.
    env: {
      ...process.env,
      AGENTSYNC_DEMO_HOME: sandbox.home,
      AGENTSYNC_DEMO_REPO: sandbox.repoRoot,
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  if (!keepSandbox) {
    rmSync(SANDBOX, { recursive: true, force: true });
  }

  if (record.exitCode !== 0) {
    process.exit(record.exitCode ?? 1);
  }
  console.log("Done. GIF written to docs/demo/tui.gif");
}

main();
