import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const packageEntry = join(process.cwd(), "dist", "cli.js");
const packageEntryTmp = `${packageEntry}.tmp`;
const shebang = "#!/usr/bin/env bun\n";

const buildResult = Bun.spawnSync([
  process.execPath,
  "build",
  "--target",
  "bun",
  "src/cli.ts",
  "--outfile",
  packageEntryTmp,
]);

if (buildResult.exitCode !== 0) {
  const stderr = new TextDecoder().decode(buildResult.stderr).trim();
  throw new Error(stderr || "bun build failed for dist/cli.js");
}

await mkdir(dirname(packageEntry), { recursive: true });

const bundle = await readFile(packageEntryTmp, "utf8");
const normalizedBundle = bundle.startsWith(shebang) ? bundle : `${shebang}${bundle}`;

await writeFile(packageEntry, normalizedBundle, "utf8");
await chmod(packageEntry, 0o755);
await Bun.file(packageEntryTmp).delete();
