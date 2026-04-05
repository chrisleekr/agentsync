import { describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { z } from "zod";

{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: The fs/promises alias bypasses Bun's shared node:fs/promises mock cache between test files.
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

const { readFile } = createRequire(import.meta.url)(
  "fs/promises",
) as typeof import("node:fs/promises");

const rootDir = process.cwd();
const packageEntryPath = join(rootDir, "dist", "cli.js");
const packageJsonPath = join(rootDir, "package.json");
const releaseWorkflowPath = join(rootDir, ".github", "workflows", "release-please.yml");
const sourceCliPath = join(rootDir, "src", "cli.ts");
const nodeVersionPinPath = join(rootDir, ".nvmrc");

const packageJsonSchema = z.object({
  name: z.string(),
  version: z.string(),
  private: z.boolean().optional(),
  bin: z.record(z.string(), z.string()),
  files: z.array(z.string()),
  publishConfig: z.object({ access: z.string() }),
  repository: z.object({ type: z.string(), url: z.string() }),
  homepage: z.string(),
  bugs: z.object({ url: z.string() }),
  license: z.string(),
  volta: z
    .object({
      node: z.string(),
    })
    .optional(),
});

const npmPackFileSchema = z.object({
  path: z.string(),
});

const npmPackOutputSchema = z.array(
  z.object({
    files: z.array(npmPackFileSchema),
  }),
);

function runCommand(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} ${args.join(" ")} failed`);
  }

  return result.stdout.trim();
}

function parseNpmPackOutput(rawOutput: string) {
  const jsonStart = rawOutput.indexOf("[");
  const jsonEnd = rawOutput.lastIndexOf("]");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error(`npm pack --json did not emit a parseable JSON array:\n${rawOutput}`);
  }

  return npmPackOutputSchema.parse(JSON.parse(rawOutput.slice(jsonStart, jsonEnd + 1)) as unknown);
}

describe("package release surface", () => {
  test("package manifest is publishable and exposes the scoped bunx contract", async () => {
    const packageJson = packageJsonSchema.parse(
      JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown,
    );

    expect(packageJson.name).toBe("@chrisleekr/agentsync");
    expect(packageJson.private).toBeFalse();
    expect(packageJson.bin.agentsync).toBe("dist/cli.js");
    expect(packageJson.files).toEqual(["dist/cli.js", "README.md", "LICENSE"]);
    expect(packageJson.publishConfig.access).toBe("public");
    expect(packageJson.repository.url).toBe("git+https://github.com/chrisleekr/agentsync.git");
    expect(packageJson.bugs.url).toBe("https://github.com/chrisleekr/agentsync/issues");
    expect(packageJson.homepage).toBe("https://github.com/chrisleekr/agentsync#readme");
    expect(packageJson.license).toBe("MIT");
  });

  test("package build emits a Bun-shebang CLI whose version matches the manifest", async () => {
    runCommand(process.execPath, ["run", "build:package"]);

    const builtEntry = await readFile(packageEntryPath, "utf8");
    expect(builtEntry.startsWith("#!/usr/bin/env bun\n")).toBeTrue();

    const cliVersionOutput = runCommand(process.execPath, [packageEntryPath, "--version"]);
    const packageJson = packageJsonSchema.parse(
      JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown,
    );

    expect(cliVersionOutput).toBe(packageJson.version);
  });

  test("package validation pins the release workflow Node and npm toolchain without reading local versions", async () => {
    const pinnedNodeVersion = (await readFile(nodeVersionPinPath, "utf8")).trim();
    const workflow = await readFile(releaseWorkflowPath, "utf8");
    const packageJson = packageJsonSchema.parse(
      JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown,
    );

    expect(packageJson.volta?.node).toBe(pinnedNodeVersion);
    expect(workflow).toContain("node-version-file: .nvmrc");
    expect(workflow).toContain("run: npm install --global npm@11.5.1");
  });

  test("npm pack dry-run includes the published CLI and excludes repo-only source files", async () => {
    runCommand(process.execPath, ["run", "build:package"]);

    const rawPackOutput = runCommand("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
    const packOutput = parseNpmPackOutput(rawPackOutput);
    const packedFiles = packOutput[0]?.files.map((file) => file.path) ?? [];

    expect(packedFiles).toContain("dist/cli.js");
    expect(packedFiles).toContain("README.md");
    expect(packedFiles).toContain("LICENSE");
    expect(packedFiles).not.toContain("dist/agentsync");
    expect(packedFiles).not.toContain("src/cli.ts");
    expect(packedFiles).not.toContain("src/commands/shared.ts");
    expect(packedFiles).not.toContain("specs/20260405-112827-bunx-release/spec.md");
  });

  test("source and package version markers stay aligned", async () => {
    const sourceCli = await readFile(sourceCliPath, "utf8");
    const sourceVersionMatch = sourceCli.match(
      /version: "([0-9.]+)",\s*\/\/ x-release-please-version/,
    );
    const packageJson = packageJsonSchema.parse(
      JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown,
    );

    expect(sourceVersionMatch?.[1]).toBe(packageJson.version);
  });
});
