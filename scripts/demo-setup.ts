/**
 * Builds an isolated sandbox so the TUI demo records against fake data instead
 * of the operator's real agent configuration.
 *
 * The whole sandbox hinges on one fact: `src/config/paths.ts` resolves every
 * agent path from `homedir()`, which on macOS/Linux returns `$HOME`. Point
 * `$HOME` at `.demo-sandbox/home` and all of AgentSync relocates with it. No
 * production code is touched.
 *
 * Run directly (`bun run scripts/demo-setup.ts`) to leave a ready sandbox in
 * place, or import `setupDemoSandbox()` from the recorder.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { AgentPaths } from "../src/config/paths";

const REPO_ROOT = join(import.meta.dir, "..");
const SANDBOX = join(REPO_ROOT, ".demo-sandbox");
const HOME = join(SANDBOX, "home");
const BARE_REMOTE = join(SANDBOX, "remote.git");
const REAL_HOME = homedir();

/** Git needs an identity to commit; the sandbox HOME has no ~/.gitconfig. */
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "AgentSync Demo",
  GIT_AUTHOR_EMAIL: "demo@agentsync.local",
  GIT_COMMITTER_NAME: "AgentSync Demo",
  GIT_COMMITTER_EMAIL: "demo@agentsync.local",
};

export interface DemoSandbox {
  /** Absolute path to use as `$HOME` when launching the TUI. */
  home: string;
  /** Repo root, so the recorder can point the tape at `src/cli.ts`. */
  repoRoot: string;
}

/** Spawn a command, inheriting the sandbox env; throw on a non-zero exit. */
function run(cmd: string[], extraEnv: Record<string, string> = {}): void {
  const result = Bun.spawnSync(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME, ...GIT_IDENTITY, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const out = new TextDecoder().decode(result.stdout);
    const err = new TextDecoder().decode(result.stderr);
    throw new Error(`Command failed (${cmd.join(" ")}):\n${out}\n${err}`);
  }
}

/**
 * Write a file at an agent path, re-rooted from the real HOME onto the sandbox
 * HOME. `agentPath` comes from `AgentPaths`, so demo seeding cannot drift from
 * the paths the CLI actually resolves at runtime.
 */
function seed(agentPath: string, contents: string): void {
  const full = join(HOME, relative(REAL_HOME, agentPath));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

/**
 * Lay down fake agent configuration across three agents so the TUI dashboard
 * has something representative to show. Paths are derived from `AgentPaths`,
 * never hardcoded, so a change to `src/config/paths.ts` keeps the demo aligned.
 */
function seedAgentConfig(): void {
  // Claude — the most-populated agent in the demo.
  seed(
    AgentPaths.claude.claudeMd,
    "# Global instructions\n\nPrefer small, surgical changes. Explain the why.\n",
  );
  seed(
    AgentPaths.claude.settingsJson,
    `${JSON.stringify({ theme: "dark", model: "claude-opus-4-7" }, null, 2)}\n`,
  );
  seed(
    join(AgentPaths.claude.skillsDir, "code-review", "SKILL.md"),
    "---\nname: code-review\ndescription: Review a diff for correctness and style.\n---\n\nWalk the diff hunk by hunk.\n",
  );
  seed(join(AgentPaths.claude.commandsDir, "ship.md"), "Run the test suite, then open a PR.\n");

  // Cursor — rules only, to show a second agent.
  seed(join(AgentPaths.cursor.rulesDir, "style.md"), "Match the surrounding code style.\n");

  // Codex — top-level guidance file.
  seed(AgentPaths.codex.agentsMd, "# Codex agents\n\nKeep diffs reviewable.\n");
}

/** Build the sandbox from scratch and return the paths the recorder needs. */
export function setupDemoSandbox(): DemoSandbox {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });

  seedAgentConfig();

  // A local bare repo stands in for the GitHub remote: offline, deterministic,
  // and incapable of leaking the demo vault anywhere real.
  run(["git", "init", "--bare", "--initial-branch=main", BARE_REMOTE]);

  // `init` auto-generates the age keypair and registers this machine as a
  // recipient; `push` encrypts the seeded config and commits it to the vault.
  run(["bun", "run", "src/cli.ts", "init", "--remote", BARE_REMOTE]);
  run(["bun", "run", "src/cli.ts", "push"]);

  // Dirty one file after the push so the Sync tab shows a pending change
  // rather than an empty "in sync" state.
  seed(
    AgentPaths.claude.claudeMd,
    "# Global instructions\n\nPrefer small, surgical changes. Explain the why.\n\nAlways run the test suite before pushing.\n",
  );

  return { home: HOME, repoRoot: REPO_ROOT };
}

if (import.meta.main) {
  const sandbox = setupDemoSandbox();
  console.log(`Demo sandbox ready. HOME=${sandbox.home}`);
}
