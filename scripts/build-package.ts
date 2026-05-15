import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const packageEntry = join(process.cwd(), "dist", "cli.js");
const packageEntryTmp = `${packageEntry}.tmp`;
const shebang = "#!/usr/bin/env bun\n";

// `@opentui/core` ships a native Zig core loaded via bun:ffi from
// platform-specific optionalDependencies (.dylib / .so / .dll). Bundling
// the JS into a single `dist/cli.js` would force Bun to copy those native
// files as adjacent outputs, breaking the single-file npm contract. Mark
// it external so npm pulls it in at install time alongside the bundle.
const buildResult = Bun.spawnSync([
  process.execPath,
  "build",
  "--target",
  "bun",
  "--external",
  "@opentui/core",
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
