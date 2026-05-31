# Changelog

## [0.1.12](https://github.com/chrisleekr/agentsync/compare/v0.1.11...v0.1.12) (2026-05-29)


### Bug Fixes

* **config:** make writeConfig crash-safe with atomic temp-and-rename ([#145](https://github.com/chrisleekr/agentsync/issues/145)) ([fa06f2b](https://github.com/chrisleekr/agentsync/commit/fa06f2b8f122d5fc97fe8528c0af875680fad179))
* **config:** resolve Windows APPDATA agent paths through nonBlank guard ([#147](https://github.com/chrisleekr/agentsync/issues/147)) ([8e791c7](https://github.com/chrisleekr/agentsync/commit/8e791c79a858ee42dfca15b445f616b9bddf2035))
* **config:** surface schema and TOML errors as one-line diagnostics ([#148](https://github.com/chrisleekr/agentsync/issues/148)) ([65a1e2e](https://github.com/chrisleekr/agentsync/commit/65a1e2ebd3f0f5babf9be1f106ce219a85ac17a1))
* **daemon:** use os.tmpdir() for Windows task XML path ([#132](https://github.com/chrisleekr/agentsync/issues/132)) ([0586854](https://github.com/chrisleekr/agentsync/commit/058685456356a2d8a35466db92dafde895ec760a))
* **migrate:** preserve JSONC state in MCP merge instead of silent overwrite ([#146](https://github.com/chrisleekr/agentsync/issues/146)) ([378dd9a](https://github.com/chrisleekr/agentsync/commit/378dd9a96d3a5ed9d6f832fefa8cf963233e2c50))
* **packaging:** declare engines.bun to enforce the documented Bun floor ([#149](https://github.com/chrisleekr/agentsync/issues/149)) ([dc677c0](https://github.com/chrisleekr/agentsync/commit/dc677c05fc5302d9d93ac7c29685e8970ce68d73))
* **packaging:** remove stale .npmignore shadowed by files allowlist ([#130](https://github.com/chrisleekr/agentsync/issues/130)) ([315259b](https://github.com/chrisleekr/agentsync/commit/315259bb16ef5f05af55be2a0178d70c3b906705))
* **sanitizer:** detect AGE-SECRET-KEY-1 vault identity in secret scanner ([#144](https://github.com/chrisleekr/agentsync/issues/144)) ([b8a6683](https://github.com/chrisleekr/agentsync/commit/b8a6683f19369ae7751c5226646b2a4af34c8594))

## [0.1.11](https://github.com/chrisleekr/agentsync/compare/v0.1.10...v0.1.11) (2026-05-17)


### Features

* **config:** add AGENTSYNC_DIR override for the base directory ([#116](https://github.com/chrisleekr/agentsync/issues/116)) ([5b9cafa](https://github.com/chrisleekr/agentsync/commit/5b9cafa76d7e50e6320db754a9fcab6c2d60c494))


### Bug Fixes

* **commands:** treat blank env vars as unset in machineName resolution ([#111](https://github.com/chrisleekr/agentsync/issues/111)) ([3dc9ae7](https://github.com/chrisleekr/agentsync/commit/3dc9ae77ad0e5d154a687f335ea4277fd6baf63d))
* **commands:** treat blank env vars as unset in vault and key paths ([#114](https://github.com/chrisleekr/agentsync/issues/114)) ([897fe62](https://github.com/chrisleekr/agentsync/commit/897fe62fe8b53aab564ef25e021a71ac7cdb7b45))
* **config:** treat blank APPDATA and CODEX_HOME env vars as unset ([#117](https://github.com/chrisleekr/agentsync/issues/117)) ([0598a11](https://github.com/chrisleekr/agentsync/commit/0598a11aa33d682ca50b0d620b6aaf7c06572726))

## [0.1.10](https://github.com/chrisleekr/agentsync/compare/v0.1.9...v0.1.10) (2026-05-17)


### Features

* **upgrade:** add in-app version check and upgrade command ([#104](https://github.com/chrisleekr/agentsync/issues/104)) ([01ff046](https://github.com/chrisleekr/agentsync/commit/01ff046b70810e3096411680143f8dc623ced511))


### Bug Fixes

* JSONC pull crash and Sync tab UX ([#109](https://github.com/chrisleekr/agentsync/issues/109)) ([c0bf4b5](https://github.com/chrisleekr/agentsync/commit/c0bf4b5af720dc962aa03c0b8ca515915e345715))

## [0.1.9](https://github.com/chrisleekr/agentsync/compare/v0.1.8...v0.1.9) (2026-05-16)


### Bug Fixes

* **release:** scope SHA256SUMS upload to repo in checkout-less job ([#100](https://github.com/chrisleekr/agentsync/issues/100)) ([0298131](https://github.com/chrisleekr/agentsync/commit/0298131f5008ea89250c60af2bd07a8c8093fb0f))
* **tui:** fetch vault from remote before computing Sync diff ([#102](https://github.com/chrisleekr/agentsync/issues/102)) ([267ba31](https://github.com/chrisleekr/agentsync/commit/267ba31d81d1acfe976566a42dcc7383e2db68d6))

## [0.1.8](https://github.com/chrisleekr/agentsync/compare/v0.1.7...v0.1.8) (2026-05-16)


### Bug Fixes

* **release:** install target-platform OpenTUI native to fix cross-compile ([#97](https://github.com/chrisleekr/agentsync/issues/97)) ([649a27b](https://github.com/chrisleekr/agentsync/commit/649a27b110f41a8488a748a5d4e878e603249748))
* **tui:** make Sync panel drift categories visible and selection-safe ([#99](https://github.com/chrisleekr/agentsync/issues/99)) ([6f1c586](https://github.com/chrisleekr/agentsync/commit/6f1c586d0d3c1cdece5b3f2e364ce84fc9b9ec0a))

## [0.1.7](https://github.com/chrisleekr/agentsync/compare/v0.1.6...v0.1.7) (2026-05-16)


### Features

* **migrate:** expand to 5 config types × 5 agents, add sourcePath display, wrap commands→codex as skills ([#80](https://github.com/chrisleekr/agentsync/issues/80)) ([060c878](https://github.com/chrisleekr/agentsync/commit/060c87865d5bbf8cad38b3cc738677a20cc1d8ac))
* **packaging:** cross-compile a Windows binary and document PowerShell verification ([#92](https://github.com/chrisleekr/agentsync/issues/92)) ([abe8fc9](https://github.com/chrisleekr/agentsync/commit/abe8fc9365d86c598ad3c10b3257b6af0700f3e3))
* **tui:** merge Vault+Agents into one Sync tab with skill drill-in ([#87](https://github.com/chrisleekr/agentsync/issues/87)) ([03c6f96](https://github.com/chrisleekr/agentsync/commit/03c6f96b942526d79f59a99667e3d93992467498))


### Bug Fixes

* **core:** recognise backslash as a home-prefix separator in path-portability ([#89](https://github.com/chrisleekr/agentsync/issues/89)) ([985ab0b](https://github.com/chrisleekr/agentsync/commit/985ab0be78c04b7d2a3bb8144c8a2f7cb67f8020))

## [0.1.6](https://github.com/chrisleekr/agentsync/compare/v0.1.5...v0.1.6) (2026-05-13)


### Features

* **agents:** wire HOME path portability + B15/B17/B19/B22 adapter fixes ([#70](https://github.com/chrisleekr/agentsync/issues/70)) ([#73](https://github.com/chrisleekr/agentsync/issues/73)) ([d9d2370](https://github.com/chrisleekr/agentsync/commit/d9d23706a86f1eac88bc4ca2a09b63b66ca6edd9))
* **claude:** plugin-aware sync with opt-in marketplace ([#53](https://github.com/chrisleekr/agentsync/issues/53)) ([05d4028](https://github.com/chrisleekr/agentsync/commit/05d40282b711d327f151cf58f9940231363c71c1))
* **cli:** friendly errors for missing vault and second-machine pull ([#56](https://github.com/chrisleekr/agentsync/issues/56)) ([2d74b6d](https://github.com/chrisleekr/agentsync/commit/2d74b6de7bcfb7a1aaa370e0a366ae3a5bcf3579))
* **core:** HOME path portability + paths.ts corrections + .bak/*~ never-sync (phase 1) ([#72](https://github.com/chrisleekr/agentsync/issues/72)) ([af646ba](https://github.com/chrisleekr/agentsync/commit/af646ba5ee9234184b9ca680deddacf6e4d84581))
* **migrate:** transport-aware MCP model with VS Code servers/inputs schema ([#55](https://github.com/chrisleekr/agentsync/issues/55)) ([29b7e4d](https://github.com/chrisleekr/agentsync/commit/29b7e4d36cc63657f592bead0ac553f6525893b9))


### Bug Fixes

* **config:** tighten schema for recipients, branch, and remote.url ([#68](https://github.com/chrisleekr/agentsync/issues/68)) ([f5f97e1](https://github.com/chrisleekr/agentsync/commit/f5f97e1011603849df9df32d4cff27fe54990489))
* **init:** probe remote before writing keypair; roll back orphan key on failure ([#62](https://github.com/chrisleekr/agentsync/issues/62)) ([c5642a6](https://github.com/chrisleekr/agentsync/commit/c5642a622d36efaa2f55096efb52c5c1ac7e8b87))
* **migrate:** cursorToClaude writes CLAUDE.md, gate sentinel routing in applyMigrated ([#75](https://github.com/chrisleekr/agentsync/issues/75)) ([#78](https://github.com/chrisleekr/agentsync/issues/78)) ([545135b](https://github.com/chrisleekr/agentsync/commit/545135b7c91797f2e5c867d29369fb5cb3275b7a))
* **push:** route --dry-run through performPush so Phase 1 security gates run ([#67](https://github.com/chrisleekr/agentsync/issues/67)) ([edcdaf3](https://github.com/chrisleekr/agentsync/commit/edcdaf3aeb4d74f00e8bf9d495c7343494c3c5ae))
* **sanitizer:** scan markdown bodies and prose-style values for literal secrets ([#58](https://github.com/chrisleekr/agentsync/issues/58)) ([4689eea](https://github.com/chrisleekr/agentsync/commit/4689eea6de5893b767616f5db88eb86cf2575031))
* **walker:** scan skill/agent bundle bodies for literal secrets ([#65](https://github.com/chrisleekr/agentsync/issues/65)) ([c8dc814](https://github.com/chrisleekr/agentsync/commit/c8dc814b7cdcd327f33e46de8c0d927c1485ec05))
* **workflow:** feature-research silent-success + strict-mode hardening ([#28](https://github.com/chrisleekr/agentsync/issues/28)) ([d7d7949](https://github.com/chrisleekr/agentsync/commit/d7d794967caa5a8067da2212a72594fb9948ca3d))

## [0.1.5](https://github.com/chrisleekr/agentsync/compare/v0.1.4...v0.1.5) (2026-04-11)


### Features

* **skills:** sync skill directories for Claude, Cursor, Codex + skill remove verb ([#26](https://github.com/chrisleekr/agentsync/issues/26)) ([dbd85c2](https://github.com/chrisleekr/agentsync/commit/dbd85c2b81b2f861c25b0e2fb62ade246e802c31))

## [0.1.4](https://github.com/chrisleekr/agentsync/compare/v0.1.3...v0.1.4) (2026-04-06)


### Features

* **workflows:** add GitHub Agentic Workflows for automated feature research ([#23](https://github.com/chrisleekr/agentsync/issues/23)) ([fcb6b5f](https://github.com/chrisleekr/agentsync/commit/fcb6b5fd66249687a34d7ff99854f6fd2169b0fc))

## [0.1.3](https://github.com/chrisleekr/agentsync/compare/v0.1.2...v0.1.3) (2026-04-06)


### Features

* **daemon:** stabilise daemon process — SyncQueue, retry, failure tracking, shutdown ([#16](https://github.com/chrisleekr/agentsync/issues/16)) ([946475c](https://github.com/chrisleekr/agentsync/commit/946475c6e8fc2dbb8ef0373f0d3e25240c335469))
* **migrate:** add cross-agent configuration migration command ([#19](https://github.com/chrisleekr/agentsync/issues/19)) ([05415ef](https://github.com/chrisleekr/agentsync/commit/05415efa6edf08c631929b8b962df102a856dc16))

## [0.1.2](https://github.com/chrisleekr/agentsync/compare/v0.1.1...v0.1.2) (2026-04-05)


### Bug Fixes

* **ci:** release please workflow to use PAT ([#14](https://github.com/chrisleekr/agentsync/issues/14)) ([531acaf](https://github.com/chrisleekr/agentsync/commit/531acafe1488cd237c5db72586e0529ef64af8a2))
* **sync:** recover existing vault bootstrap and divergence handling ([#12](https://github.com/chrisleekr/agentsync/issues/12)) ([86879fd](https://github.com/chrisleekr/agentsync/commit/86879fd33e14e3f75973beebee350cd6be2eff09))

## [0.1.1](https://github.com/chrisleekr/agentsync/compare/v0.1.0...v0.1.1) (2026-04-05)


### Features

* initial release ([2a69e44](https://github.com/chrisleekr/agentsync/commit/2a69e44f004418eb3f5ccf7d4d0ce310c015fd7a))
* **release:** publish AgentSync for bunx installation ([#9](https://github.com/chrisleekr/agentsync/issues/9)) ([07f2ce8](https://github.com/chrisleekr/agentsync/commit/07f2ce81c949e1d17e2edaadde908f11e80629f7))


### Bug Fixes

* **ci:** Bun 1.3.9, job ordering, coverage gate, caching, Dependabot upgrades, Zod v4 loader fix, biome v2 migration ([#5](https://github.com/chrisleekr/agentsync/issues/5)) ([abc32ef](https://github.com/chrisleekr/agentsync/commit/abc32ef45758e275e73bc2b12a801451cf1b4ed3))
