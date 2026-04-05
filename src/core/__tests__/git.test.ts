import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBareRepo,
  createDivergentHistoryFixture,
  createTmpDir,
} from "../../test-helpers/fixtures";
import { GitClient, type GitReconciliationError } from "../git";

// T036 — GitClient clone, init, commit, push, pull, currentBranch

// Ensure git is configured for test commits.
// Only set if the user.email key is missing to avoid overwriting real config.
beforeAll(() => {
  const emailCheck = Bun.spawnSync(["git", "config", "--global", "user.email"]);
  if (emailCheck.exitCode !== 0) {
    Bun.spawnSync(["git", "config", "--global", "user.email", "agentsync-test@example.com"]);
    Bun.spawnSync(["git", "config", "--global", "user.name", "AgentSync Test"]);
  }
});

describe("GitClient", () => {
  let tmpDir: string;
  let bareRepoPath: string;

  beforeEach(async () => {
    tmpDir = await createTmpDir();
    bareRepoPath = await createBareRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("isInitialized returns false for a plain directory, true after init()", async () => {
    const workDir = join(tmpDir, "work");
    await mkdir(workDir, { recursive: true });
    const git = new GitClient(workDir);

    expect(await git.isInitialized()).toBe(false);
    await git.init();
    expect(await git.isInitialized()).toBe(true);
  });

  test("commit() returns true when files have changed, false when nothing to commit", async () => {
    const workDir = join(tmpDir, "work");
    await mkdir(workDir, { recursive: true });
    const git = new GitClient(workDir);
    await git.init();

    await writeFile(join(workDir, "README.md"), "# test", "utf8");
    const committed = await git.commit({ message: "initial" });
    expect(committed).toBe(true);

    // Nothing changed — second commit must return false
    const notCommitted = await git.commit({ message: "empty" });
    expect(notCommitted).toBe(false);
  });

  test("push + pull roundtrip via a local bare repo", async () => {
    const workDir1 = join(tmpDir, "work1");
    const workDir2 = join(tmpDir, "work2");
    await mkdir(workDir1, { recursive: true });

    // ── Initialise work1 and push to the bare remote ──────────────────────────
    const git1 = new GitClient(workDir1);
    await git1.init();
    await git1.addRemote("origin", bareRepoPath);
    await writeFile(join(workDir1, "data.txt"), "original", "utf8");
    await git1.commit({ message: "init" });

    const branch = await git1.currentBranch();
    await git1.push("origin", branch, ["--set-upstream"]);

    // ── Clone work2 from the bare remote ──────────────────────────────────────
    const git2 = await GitClient.clone(bareRepoPath, workDir2, branch);
    expect(await git2.isInitialized()).toBe(true);

    // ── Push an update from work1 and pull it in work2 ────────────────────────
    await writeFile(join(workDir1, "data.txt"), "updated", "utf8");
    await git1.commit({ message: "update" });
    await git1.push("origin", branch);

    await git2.pull("origin", branch);
    const content = await Bun.file(join(workDir2, "data.txt")).text();
    expect(content).toBe("updated");
  });

  test("inspectRemoteBranch reports an empty remote branch before first push", async () => {
    const workDir = join(tmpDir, "work");
    await mkdir(workDir, { recursive: true });

    const git = new GitClient(workDir);
    const state = await git.inspectRemoteBranch(bareRepoPath, "main");

    expect(state.exists).toBe(false);
    expect(state.headCommit).toBeNull();
  });

  test("reconcileWithRemote bootstraps an existing remote into an empty local repo", async () => {
    const primaryDir = join(tmpDir, "primary");
    const secondaryDir = join(tmpDir, "secondary");
    await mkdir(primaryDir, { recursive: true });
    await mkdir(secondaryDir, { recursive: true });

    const git1 = new GitClient(primaryDir);
    await git1.init();
    await git1.setHeadBranch("main");
    await git1.ensureRemote("origin", bareRepoPath);
    await writeFile(join(primaryDir, "data.txt"), "seed", "utf8");
    await git1.commit({ message: "seed" });
    await git1.push("origin", "main", ["--set-upstream"]);

    const git2 = new GitClient(secondaryDir);
    await git2.init();
    await git2.setHeadBranch("main");
    await git2.ensureRemote("origin", bareRepoPath);

    const result = await git2.reconcileWithRemote({ remote: "origin", branch: "main" });

    expect(result.status).toBe("bootstrapped-existing");
    const content = await Bun.file(join(secondaryDir, "data.txt")).text();
    expect(content).toBe("seed");
  });

  test("reconcileWithRemote fast-forwards when the local branch is behind", async () => {
    const workDir1 = join(tmpDir, "work1");
    const workDir2 = join(tmpDir, "work2");
    await mkdir(workDir1, { recursive: true });

    const git1 = new GitClient(workDir1);
    await git1.init();
    await git1.setHeadBranch("main");
    await git1.ensureRemote("origin", bareRepoPath);
    await writeFile(join(workDir1, "data.txt"), "one", "utf8");
    await git1.commit({ message: "one" });
    await git1.push("origin", "main", ["--set-upstream"]);

    const git2 = await GitClient.clone(bareRepoPath, workDir2, "main");
    await writeFile(join(workDir1, "data.txt"), "two", "utf8");
    await git1.commit({ message: "two" });
    await git1.push("origin", "main");

    const result = await git2.reconcileWithRemote({ remote: "origin", branch: "main" });

    expect(result.status).toBe("fast-forwarded");
    const content = await Bun.file(join(workDir2, "data.txt")).text();
    expect(content).toBe("two");
  });

  test("reconcileWithRemote throws a typed error when local and remote history diverge", async () => {
    const { secondaryDir } = await createDivergentHistoryFixture(tmpDir, "main");
    const git = new GitClient(secondaryDir);

    await expect(
      git.reconcileWithRemote({ remote: "origin", branch: "main" }),
    ).rejects.toMatchObject({
      name: "GitReconciliationError",
      code: "DIVERGED_HISTORY",
    } satisfies Partial<GitReconciliationError>);
  });

  test("currentBranch() returns a non-empty string after the first commit", async () => {
    const workDir = join(tmpDir, "work");
    await mkdir(workDir, { recursive: true });
    const git = new GitClient(workDir);
    await git.init();
    await writeFile(join(workDir, "README.md"), "# test", "utf8");
    await git.commit({ message: "init" });

    const branch = await git.currentBranch();
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });
});
