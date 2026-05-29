import { describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { join } from "node:path";

{
  const require = createRequire(import.meta.url);
  // biome-ignore lint/style/useNodejsImportProtocol: The fs/promises alias bypasses Bun's shared node:fs/promises mock cache between test files.
  const realFsPromises = require("fs/promises") as typeof import("node:fs/promises");
  mock.module("node:fs/promises", () => realFsPromises);
}

const { readFile } = createRequire(import.meta.url)(
  "fs/promises",
) as typeof import("node:fs/promises");

const workflowPath = join(process.cwd(), ".github", "workflows", "release-please.yml");
const ciWorkflowPath = join(process.cwd(), ".github", "workflows", "ci.yml");

describe("release workflow publishing contract", () => {
  test("uses a GitHub-hosted OIDC publish job with least-privilege permissions", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("publish-package:");
    expect(workflow).toContain("runs-on: ubuntu-latest");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("node-version-file: .nvmrc");
    expect(workflow).toContain("npm install --global npm@11.5.1");
    expect(workflow).toContain("npm publish --provenance --access public");
    expect(workflow).not.toMatch(
      /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM_TOKEN|secrets\.NODE_AUTH_TOKEN/,
    );
  });

  test("executes the macOS arm64 release binary before attesting and uploading it", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    // The native smoke gate runs every host-native target (no bun_target ->
    // built for its own runner), not Linux-only. Apple Silicon was previously
    // excluded because Bun 1.3.12 produced an unsigned arm64 binary that
    // SIGKILLed; Bun >=1.3.13 ad-hoc signs it, so executing the published
    // binary here guards that regression class from shipping again.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on the literal GitHub Actions `${{ }}` expression in the workflow YAML, not a JS template.
    expect(workflow).toContain("if: ${{ !matrix.bun_target }}");
    expect(workflow).not.toContain("runner.os == 'Linux' && !matrix.bun_target");

    // macos-arm64 must stay host-native (no bun_target) or `bun build
    // --compile` would cross-compile it and the gate above would skip it,
    // shipping an unexecuted binary. Assert the invariant on the entry itself
    // (bounded to the build matrix) so reordering the matrix cannot mask a
    // bun_target sneaking onto this target.
    const matrixRegion = workflow.match(/include:\n([\s\S]*?)\n {4}runs-on:/)?.[1] ?? "";
    const arm64Entry =
      matrixRegion
        .split(/\n\s*- os:/)
        .find((entry) => entry.includes("target: agentsync-macos-arm64")) ?? "";

    expect(arm64Entry).not.toBe("");
    expect(arm64Entry).not.toContain("bun_target");
  });

  test("pins the CI unit-test job to the publish validation Node and npm toolchain", async () => {
    const ciWorkflow = await readFile(ciWorkflowPath, "utf8");

    expect(ciWorkflow).toContain("name: Unit Tests");
    // Accept either the floating `@v6` tag or a Renovate-pinned commit SHA
    // carrying the `# v6` comment — both lock the action to major v6.
    expect(ciWorkflow).toMatch(/uses: actions\/setup-node@(?:v6\b|[a-f0-9]{40} # v6\b)/);
    expect(ciWorkflow).toContain("node-version-file: .nvmrc");
    expect(ciWorkflow).toContain("name: Upgrade npm");
    expect(ciWorkflow).toContain("npm install --global npm@11.5.1");
  });
});
