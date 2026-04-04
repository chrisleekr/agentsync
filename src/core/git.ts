import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";

export interface CommitOptions {
  message: string;
  addAll?: boolean;
}

export class GitClient {
  private readonly git: SimpleGit;

  constructor(private readonly repoDir: string) {
    this.git = simpleGit(repoDir);
  }

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

  async pull(remote = "origin", branch = "main"): Promise<void> {
    await this.git.pull(remote, branch);
  }

  async addAll(): Promise<void> {
    await this.git.add(".");
  }

  async commit({ message, addAll = true }: CommitOptions): Promise<boolean> {
    if (addAll) {
      await this.addAll();
    }

    const status = await this.git.status();
    if (status.files.length === 0) {
      return false;
    }

    await this.git.commit(message);
    return true;
  }

  async push(remote = "origin", branch = "main", options: string[] = []): Promise<void> {
    await this.git.push(remote, branch, options);
  }

  async currentBranch(): Promise<string> {
    const branch = await this.git.branchLocal();
    return branch.current;
  }
}
