import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";

const decoder = new TextDecoder();

/** Stable error categories returned by the vault reconciliation flow. */
export type GitReconciliationCode = "DIVERGED_HISTORY" | "REMOTE_BRANCH_MISSING";

/** Snapshot of whether a target remote branch exists and which commit it currently points to. */
export interface RemoteBranchState {
  remote: string;
  branch: string;
  exists: boolean;
  headCommit: string | null;
}

/** Options that control how the local vault reconciles against a remote branch. */
export interface GitReconciliationOptions {
  remote?: string;
  branch?: string;
  allowMissingRemote?: boolean;
}

/** Result metadata returned after attempting to reconcile the local branch with the remote. */
export interface GitReconciliationResult {
  status: "noop" | "fast-forwarded" | "bootstrapped-existing" | "remote-missing";
  remote: string;
  branch: string;
  localHead: string | null;
  remoteHead: string | null;
}

/** Error raised when reconciliation fails in a product-defined, user-visible way. */
export class GitReconciliationError extends Error {
  constructor(
    public readonly code: GitReconciliationCode,
    message: string,
  ) {
    super(message);
    this.name = "GitReconciliationError";
  }
}

/** Options for creating a commit through the GitClient wrapper. */
export interface CommitOptions {
  message: string;
  addAll?: boolean;
}

/** Thin repository-scoped wrapper around simple-git for vault workflows. */
export class GitClient {
  private readonly git: SimpleGit;

  constructor(private readonly repoDir: string) {
    this.git = simpleGit(repoDir);
  }

  private runGit(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const result = Bun.spawnSync(["git", "-C", this.repoDir, ...args]);
    return {
      exitCode: result.exitCode,
      stdout: decoder.decode(result.stdout).trim(),
      stderr: decoder.decode(result.stderr).trim(),
    };
  }

  private assertGit(args: string[], action: string): string {
    const result = this.runGit(args);
    if (result.exitCode !== 0) {
      throw new Error(`${action} failed: ${result.stderr || result.stdout || "no output"}`);
    }
    return result.stdout;
  }

  private async revParse(ref: string): Promise<string | null> {
    const result = this.runGit(["rev-parse", "--verify", ref]);
    return result.exitCode === 0 ? result.stdout : null;
  }

  private isAncestor(ancestor: string, descendant: string): boolean {
    const result = this.runGit(["merge-base", "--is-ancestor", ancestor, descendant]);
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    throw new Error(result.stderr || result.stdout || "git merge-base failed");
  }

  private async ensureCheckedOutBranch(branch: string): Promise<void> {
    const local = await this.git.branchLocal();
    if (local.current === branch) {
      return;
    }

    if (local.all.includes(branch)) {
      await this.git.checkout(branch);
      return;
    }

    if ((await this.revParse("HEAD")) !== null) {
      this.assertGit(["checkout", "-b", branch], `git checkout -b ${branch}`);
    }
  }

  private trySetUpstream(branch: string, remoteRef: string): void {
    const result = this.runGit(["branch", "--set-upstream-to", remoteRef, branch]);
    if (result.exitCode !== 0 && !result.stderr.includes("set up to track")) {
      throw new Error(result.stderr || result.stdout || "git branch --set-upstream-to failed");
    }
  }

  private ensureLocalConfig(key: string, value: string): void {
    const existing = this.runGit(["config", "--local", "--get", key]);
    if (existing.exitCode === 0 && existing.stdout.length > 0) {
      return;
    }

    const result = this.runGit(["config", "--local", key, value]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `git config --local ${key} failed`);
    }
  }

  private ensureCommitConfig(): void {
    this.ensureLocalConfig("user.name", "Agent Sync");
    this.ensureLocalConfig("user.email", "agentsync@local.invalid");
    this.ensureLocalConfig("commit.gpgsign", "false");
  }

  /**
   * Clone a remote vault into a local working directory and return a bound client.
   * @param remoteUrl Remote repository URL or path to clone.
   * @param targetDir Local directory that will receive the clone.
   * @param branch Branch to checkout during clone.
   * @returns A Git client bound to the cloned repository.
   */
  static async clone(remoteUrl: string, targetDir: string, branch = "main"): Promise<GitClient> {
    await mkdir(dirname(targetDir), { recursive: true });
    await simpleGit().clone(remoteUrl, targetDir, ["--branch", branch]);
    return new GitClient(targetDir);
  }

  /** Returns true if the directory already contains a git repository (.git exists). */
  async isInitialized(): Promise<boolean> {
    try {
      await stat(join(this.repoDir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  /** Run `git init` in repoDir. */
  async init(): Promise<void> {
    await this.git.init();
  }

  /** Run `git remote add <name> <url>` */
  async addRemote(name: string, url: string): Promise<void> {
    await this.git.remote(["add", name, url]);
  }

  /** Ensure the expected remote exists without failing when it was already configured. */
  async ensureRemote(name: string, url: string): Promise<void> {
    const result = this.runGit(["remote", "get-url", name]);
    if (result.exitCode === 0) {
      if (result.stdout !== url) {
        throw new Error(
          `Remote '${name}' is configured for '${result.stdout}', expected '${url}'. Update or remove the existing remote before retrying.`,
        );
      }
      return;
    }

    await this.addRemote(name, url);
  }

  /** Set the unborn HEAD branch explicitly before the first commit. */
  async setHeadBranch(branch: string): Promise<void> {
    this.assertGit(
      ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
      `git symbolic-ref HEAD ${branch}`,
    );
  }

  /** Inspect whether a remote branch currently exists and, if it does, capture its head SHA. */
  async inspectRemoteBranch(remote = "origin", branch = "main"): Promise<RemoteBranchState> {
    const refName = `refs/heads/${branch}`;
    const result = this.runGit(["ls-remote", "--heads", remote, refName]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `git ls-remote failed for ${remote}`);
    }

    const matchingLine =
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.endsWith(` ${refName}`) || line.endsWith(`\t${refName}`)) ?? "";
    const headCommit = matchingLine.length > 0 ? (matchingLine.split(/\s+/)[0] ?? null) : null;

    return {
      remote,
      branch,
      exists: headCommit !== null,
      headCommit,
    };
  }

  /** Reconcile the local branch against the remote using an explicit fast-forward-only policy. */
  async reconcileWithRemote(
    options: GitReconciliationOptions = {},
  ): Promise<GitReconciliationResult> {
    const remote = options.remote ?? "origin";
    const branch = options.branch ?? "main";
    const remoteState = await this.inspectRemoteBranch(remote, branch);

    if (!remoteState.exists) {
      if (options.allowMissingRemote) {
        return {
          status: "remote-missing",
          remote,
          branch,
          localHead: await this.revParse("HEAD"),
          remoteHead: null,
        };
      }

      throw new GitReconciliationError(
        "REMOTE_BRANCH_MISSING",
        `Remote vault branch '${remote}/${branch}' was not found. Run init against the intended remote first, or verify the configured remote URL and branch.`,
      );
    }

    this.assertGit(["fetch", "--prune", remote, branch], `git fetch ${remote} ${branch}`);
    const remoteRef = `refs/remotes/${remote}/${branch}`;
    const remoteHead = await this.revParse(remoteRef);

    if (remoteHead === null) {
      throw new Error(`Fetched '${remote}/${branch}' but could not resolve ${remoteRef}.`);
    }

    const localHead = await this.revParse("HEAD");
    if (localHead === null) {
      this.assertGit(
        ["checkout", "-B", branch, remoteRef],
        `git checkout -B ${branch} ${remoteRef}`,
      );
      this.trySetUpstream(branch, remoteRef);
      return {
        status: "bootstrapped-existing",
        remote,
        branch,
        localHead: remoteHead,
        remoteHead,
      };
    }

    await this.ensureCheckedOutBranch(branch);
    const branchHead = await this.revParse("HEAD");

    if (branchHead === null) {
      throw new Error(`Local branch '${branch}' could not be resolved after checkout.`);
    }

    if (branchHead === remoteHead) {
      this.trySetUpstream(branch, remoteRef);
      return {
        status: "noop",
        remote,
        branch,
        localHead: branchHead,
        remoteHead,
      };
    }

    if (this.isAncestor(branchHead, remoteHead)) {
      this.assertGit(["merge", "--ff-only", remoteRef], `git merge --ff-only ${remoteRef}`);
      this.trySetUpstream(branch, remoteRef);
      return {
        status: "fast-forwarded",
        remote,
        branch,
        localHead: await this.revParse("HEAD"),
        remoteHead,
      };
    }

    if (this.isAncestor(remoteHead, branchHead)) {
      this.trySetUpstream(branch, remoteRef);
      return {
        status: "noop",
        remote,
        branch,
        localHead: branchHead,
        remoteHead,
      };
    }

    throw new GitReconciliationError(
      "DIVERGED_HISTORY",
      `Vault history diverged from '${remote}/${branch}'. AgentSync only supports fast-forward sync. Back up any local-only vault changes, then reset or reclone the vault to '${remote}/${branch}' before retrying.`,
    );
  }

  /** Pull the latest changes for a remote branch into the current repository. */
  async pull(remote = "origin", branch = "main"): Promise<void> {
    await this.git.pull(remote, branch);
  }

  /** Stage all current repository changes. */
  async addAll(): Promise<void> {
    await this.git.add(".");
  }

  /** Create a commit only when there are staged or unstaged file changes to record. */
  async commit({ message, addAll = true }: CommitOptions): Promise<boolean> {
    if (addAll) {
      await this.addAll();
    }

    const status = await this.git.status();
    if (status.files.length === 0) {
      return false;
    }

    this.ensureCommitConfig();
    await this.git.commit(message);
    return true;
  }

  /** Push the current branch to the configured remote with optional raw git flags. */
  async push(remote = "origin", branch = "main", options: string[] = []): Promise<void> {
    await this.git.push(remote, branch, options);
  }

  /** Return the checked-out local branch name for this repository. */
  async currentBranch(): Promise<string> {
    const branch = await this.git.branchLocal();
    return branch.current;
  }
}
