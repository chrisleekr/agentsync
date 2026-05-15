#!/usr/bin/env bun
import { $ } from "bun";
import pkg from "../package.json";

const opentuiVersion = pkg.dependencies["@opentui/core"];
if (!opentuiVersion) {
  process.exit(1);
}

// Pre-install every platform's native @opentui/core lib so bun compile can
// pick the matching one out of node_modules. Without this, an install on a
// different machine architecture than the release target would silently skip
// the optionalDependencies for the target platform.
await $`bun install --os="*" --cpu="*" @opentui/core@${opentuiVersion}`;

await $`bun build --compile src/cli.ts --outfile dist/agentsync`;
