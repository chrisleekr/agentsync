import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const EXPECTED_FILES = ["LICENSE", "README.md", "dist/cli.js", "package.json"] as const;

interface PackEntry {
  path: string;
}

interface PackResult {
  files: PackEntry[];
  entryCount: number;
}

async function runPackDryRun(): Promise<PackResult> {
  // Build first so dist/cli.js exists before npm pack evaluates the files
  // allowlist. --ignore-scripts on npm pack itself prevents the prepack
  // script from re-running (and from masking a build failure).
  const build = Bun.spawnSync({
    cmd: [process.execPath, "run", "scripts/build-package.ts"],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    const stderr = new TextDecoder().decode(build.stderr).trim();
    throw new Error(`build:package failed: ${stderr}`);
  }

  const pack = Bun.spawnSync({
    cmd: ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (pack.exitCode !== 0) {
    const stderr = new TextDecoder().decode(pack.stderr).trim();
    throw new Error(`npm pack --dry-run failed: ${stderr}`);
  }

  const stdout = new TextDecoder().decode(pack.stdout);
  const parsed = JSON.parse(stdout) as PackResult[];
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`expected one tarball in pack output, got ${parsed?.length}`);
  }
  return parsed[0];
}

describe("npm pack contents — published tarball regression guard", () => {
  test("publishes exactly the files in the package.json allowlist", async () => {
    // package.json `files` is the only knob that should govern the tarball.
    // If this fails, either the allowlist drifted or a stray .npmignore /
    // .gitignore-shadowing change re-introduced a denylist surface. Both
    // are publishing-contract regressions that must be caught before
    // release rather than after.
    const result = await runPackDryRun();
    const paths = result.files.map((f) => f.path).sort();
    expect(paths).toEqual([...EXPECTED_FILES]);
    expect(result.entryCount).toBe(EXPECTED_FILES.length);
  }, 60_000);
});
