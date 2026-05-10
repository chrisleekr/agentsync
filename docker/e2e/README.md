# AgentSync — Docker E2E Harness

Hermetic end-to-end tests that exercise the full AgentSync pipeline against
real agent CLIs and a real (file://) git vault, without ever touching the
host's `~/.claude`, `~/.cursor`, `~/.codex`, or `~/.config/agentsync`.

## What this harness covers (v1)

| Surface | How it's exercised | Real or fixture |
|---|---|---|
| Claude Code config | `npm install -g @anthropic-ai/claude-code` + `claude config set` | **Real install** |
| Codex config | `npm install -g @openai/codex` + `codex login --with-api-key` (stub key) | **Real install** |
| `~/.cursor/` (CLI agent) | `curl https://cursor.com/install \| bash` + `cursor-agent --version` | **Real install** |
| `~/.config/Code/User/settings.json` | 1-line fixture | Documented fixture (see *Why fixtures*) |
| `~/.config/Cursor/User/settings.json` | 1-line fixture | Documented fixture |
| Vault transport | `file:///vault/repo.git` on a Docker named volume | Real git, no network |
| Init → push → status pipeline | Smoke scenario in `scenarios/smoke.sh` | Real CLI, real `bun run` |

### Critical-path scenarios (all green, all run on every PR)

| # | Scenario | Critical paths verified |
|---|---|---|
| 1 | `smoke.sh` | init→push→mutate→push→status round-trip; never-sync exclusion (codex `auth.json`); age-armored encryption; stub credential absent from any vault blob |
| 2 | `02-multi-machine.sh` | A→B round-trip via HOME swap (cursor `rules` semantic, claude `CLAUDE.md` wholesale, claude `hooks` subset) |
| 3 | `03-diverged-history.sh` | true ancestor mismatch via direct git surgery → `Vault history diverged from 'origin/main'` error, vault HEAD intact |
| 4 | `04-sanitizer-aborts.sh` | literal `sk-…` in cursor `mcp.json` → `Push aborted: 1 security issue(s) detected`, no commit landed, no plaintext in vault |
| 5 | `05-key-rotate.sh` | sha-different new key, OLD key rejected by re-encrypted vault, NEW key decrypts, plaintext preserved across rotation |
| 6 | `06-skill-additive.sh` | local skill delete + push leaves vault skill intact (additive); explicit `skill remove` drops it |

### Out of v1 scope

- **Copilot** — no standalone CLI exists; covered by unit tests only.
- **Daemon** — needs systemd-in-Docker, deferred to v2.
- **macOS-specific paths** — Docker is Linux-only. macOS launchd installer +
  Mach-O signing tested separately on GH Actions `macos-latest` runners.

### Why fixtures for VS Code / Cursor desktop settings.json

VS Code and Cursor (both Electron-based) do **not** auto-write `settings.json`
on first launch. The file is created only when the user explicitly saves a
setting (see [microsoft/vscode#44418](https://github.com/microsoft/vscode/issues/44418)).
A "real headless install" therefore produces an *absent* `settings.json` —
strictly less useful than a tiny fixture that represents a real customer
who has saved at least one preference. The fixture is two characters of JSON
and lives in `entrypoint.sh`.

## Hermetic isolation contract

The harness is safe-by-construction. The following rules are enforced by the
compose file and entrypoint, **not** by Docker itself:

| Rule | Why |
|---|---|
| No host bind mounts of `$HOME`, `~/.claude`, `~/.cursor`, `~/.config`, `~/.ssh` | These are exactly the paths AgentSync mutates. |
| Project source is `COPY`-ed (not bind-mounted) | Linux-built `node_modules`/`dist` cannot clobber host's macOS-built ones. |
| No `--privileged`, no `-v /var/run/docker.sock`, no `--network host` | Removes container-escape vectors. |
| Generated keys (age + others) live only inside container fs | They die with the container. |
| `compose down -v` between runs | Wipes the named vault volume. |
| Entrypoint asserts `HOME=/home/agent` and non-root | Hard-fail if the container is misconfigured. |

## Verifying isolation (canary)

Before trusting the harness, prove host paths are untouched:

```bash
# 1. Baseline mtime/size of the watched paths
./docker/e2e/canary-isolation.sh

# 2. Run the harness
docker compose -f docker/e2e/compose.yml up --build --abort-on-container-exit

# 3. Verify host state is identical
./docker/e2e/canary-isolation.sh verify
# Expect: "✓ host paths unchanged — isolation intact"
```

If `verify` reports drift, **stop** and inspect `compose.yml` for any volume
that bind-mounts a host directory.

## Running

```bash
# One-shot smoke test
docker compose -f docker/e2e/compose.yml up --build --abort-on-container-exit

# Tear down + wipe vault volume
docker compose -f docker/e2e/compose.yml down -v
```

## Files

```
docker/e2e/
├── README.md              this file — scope, isolation contract, usage
├── Dockerfile.machine     base image: node:22-bookworm-slim + bun + agent CLIs
├── compose.yml            vault-init + machine services, named volume
├── entrypoint.sh          bootstraps agent dirs and editor fixtures
├── canary-isolation.sh    host-side check that no $HOME path was mutated
└── scenarios/
    ├── _lib.sh                        shared assertion helpers
    ├── smoke.sh                       single-machine round-trip + critical-path security checks
    ├── 02-multi-machine.sh            HOME-swap A→B round-trip (cursor rules, CLAUDE.md, claude hooks)
    ├── 03-diverged-history.sh         force divergence via git surgery, expect DIVERGED_HISTORY
    ├── 04-sanitizer-aborts.sh         literal sk- in cursor mcp.json must abort push pre-encryption
    ├── 05-key-rotate.sh               rotate key, OLD must fail to decrypt, NEW must succeed
    └── 06-skill-additive.sh           push never removes vault skills; explicit `skill remove` does
```
