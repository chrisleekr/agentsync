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
});
