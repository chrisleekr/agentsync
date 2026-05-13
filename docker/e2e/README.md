# AgentSync — Docker E2E Harness

Hermetic end-to-end tests that exercise the full AgentSync pipeline against
real agent CLIs and a real `file://` git vault, without touching the host's
`$HOME`, `~/.claude`, `~/.cursor`, `~/.codex`, `~/.copilot`, or
`~/.config/agentsync`.

The harness is fixture-driven: a single complete-real-customer state under
`docker/e2e/fixtures/home/` is rsynced into `/home/agent/` at container start.
Each scenario operates from that bootstrapped state plus its own isolated
machine HOME under `/tmp/<scenario>-<role>`.

## Scope

- **Global / user-scope configuration only.** Project- or repo-scoped config
  (`<repo>/.claude/settings.json`, `<repo>/.codex/config.toml`,
  `<repo>/.github/copilot-instructions.md`, `<repo>/.agents/skills/`) is out
  of scope by design. AgentSync only ever travels global config.
- All fixtures, scenarios, and assertions are relative to `$HOME`.

## Fixture tree

The bootstrap rsync target lives at `docker/e2e/fixtures/home/` and mirrors
a real customer's `$HOME`:

```text
.claude.json                          {oauthAccount, mcpServers, projects}
.claude/
  CLAUDE.md
  settings.json                       {permissions, env, theme, statusLine, hooks}
  commands/{deploy.md, review.md}
  agents/{code-reviewer.md, test-writer.md}
  rules/{coding-style.md, review-checklist.md}     ← B19
  skills/postgres-helper/{SKILL.md, reference.md, examples/seed.sql}
  plugins/lefthook-runner/
    .claude-plugin/plugin.json        installPath under HOME (B24 target)
    .mcp.json                         command/cwd under HOME
    commands/run.md
    agents/precommit-helper.md
    skills/precommit/SKILL.md
    hooks/PreToolUse.json
  .claude-plugin/marketplace.json
.codex/
  AGENTS.md
  AGENTS.override.md                  ← B17
  config.toml                         model_instructions_file under HOME
.agents/skills/sql-formatter/SKILL.md ← B22 canonical codex user-scope skills
.cursor/
  mcp.json
  commands/refactor.md
  skills/json-explainer/SKILL.md
.config/
  Cursor/User/settings.json           {editor.fontSize, workbench.colorTheme, rules}
  Code/User/{settings.json, mcp.json, keybindings.json, snippets/typescript.json}
.copilot/
  copilot-instructions.md             ← B16 canonical filename
  lsp-config.json                     ← B23 (currently never-synced)
  instructions/style.instructions.md
  prompts/refactor.prompt.md
  agents/bug-triager.agent.md         ← B15 canonical single-file shape
  skills/log-summariser/SKILL.md
```

Canaries live separately at `docker/e2e/fixtures/canaries/` and are loaded
explicitly by scenario 04. They never auto-rsync — the entrypoint excludes
the canary path so the never-sync contract is exercised, not bypassed:

- `canaries/never-sync/` — `auth.json`, `.credentials.json`,
  `settings.local.json`, `statsig/state.json`, `themes/*.tmTheme`,
  `*.bak`, `*~`, `NOTES.local.md`, etc.
- `canaries/literal-secrets/` — well-formed `sk-ant-api03-…`, `sk-proj-…`,
  `ghp_…`, `glpat-…`, `AKIA…`, base64-blob — one secret per file.

## Property sync matrix

For every JSON/TOML file the **synced fields** column travels through the
encrypted vault. Every other key remains local. The HOME-rewrite column flags
the values that pass through `${AGENTSYNC_HOME}` normalization on push and
back to the local `homedir()` on pull (B24).

| Adapter | File | Synced fields | HOME-rewrite | Ignored (stays local) |
| --- | --- | --- | --- | --- |
| Claude  | `~/.claude/settings.json` | `hooks` | yes | `permissions`, `env`, `theme`, `model`, `statusLine`, every other top-level key |
| Claude  | `~/.claude.json` | `mcpServers` | yes | OAuth tokens, `projects`, caches |
| Claude  | `~/.claude/commands/*.md`, `agents/*.md`, `rules/*.md` | whole | n/a (markdown) | — |
| Claude  | `~/.claude/skills/<n>/` | whole dir tarred → age | n/a | dotfiles, symlinks |
| Claude  | `~/.claude/plugins/<n>/.claude-plugin/plugin.json` | whole | yes | — |
| Claude  | `~/.claude/plugins/<n>/.mcp.json` | whole | yes | — |
| Claude  | `~/.claude/.claude-plugin/marketplace.json` | opt-in via `syncMarketplace` | yes | not synced by default |
| Claude  | `~/.claude/.credentials.json`, `settings.local.json` | NEVER | — | always local |
| Codex   | `~/.codex/AGENTS.md`, `AGENTS.override.md` | whole | n/a | — |
| Codex   | `~/.codex/config.toml` | whole (parse → normalize → restringify) | yes | secret-like values redacted inline |
| Codex   | `~/.agents/skills/<n>/` (canonical) + legacy `~/.codex/skills/<n>/` on read | whole tarred | n/a | dotfiles, symlinks |
| Codex   | `~/.codex/auth.json`, `history.jsonl`, `sessions/**`, `log/**`, `themes/**` | NEVER | — | always local |
| Cursor  | `~/.cursor/mcp.json` | whole | yes | — |
| Cursor  | `~/.config/Cursor/User/settings.json` | `rules` | yes | every other top-level key |
| Cursor  | `~/.cursor/commands/*.md`, `skills/<n>/` | whole | n/a | — |
| Cursor  | `~/.cursor/cli-config.json` | NEVER | — | always local |
| VS Code | `~/.config/Code/User/mcp.json` | `mcpServers` | yes | every other top-level key |
| VS Code | `~/.config/Code/User/settings.json`, `keybindings.json`, `snippets/**` | NEVER | — | always local |
| Copilot | `~/.copilot/copilot-instructions.md` | whole | n/a | — |
| Copilot | `~/.copilot/instructions/*.instructions.md`, `prompts/*.prompt.md`, `agents/*.agent.md` | each whole | n/a | — |
| Copilot | `~/.copilot/skills/<n>/` | whole tarred | n/a | dotfiles, symlinks |
| Copilot | `~/.copilot/lsp-config.json`, `settings.json`, `mcp-config.json` | NEVER (current intent) | — | always local |
| All     | `*.bak`, `*~` | NEVER (B21) | — | always local |

## Scenarios

| # | File | Purpose |
|---|---|---|
| 1 | `smoke.sh` | init+push proves the full fixture survives one round; every adapter contributed ≥1 artifact; no canary leaked |
| 2 | `02-multi-machine.sh` | A→B round-trip byte-equality on every wholesale file + field-eq on every subset-field file |
| 3 | `03-diverged-history.sh` | Force-divergence via direct git surgery → `Vault history diverged from 'origin/main'`, vault HEAD intact |
| 4 | `04-sanitizer-aborts.sh` | Table-driven: every literal-secret canary aborts push; every never-sync canary stays out of the vault (incl. `*.bak`, `*~`); `cli-config.json` absent (B1) |
| 5 | `05-key-rotate.sh` | Full-fixture rotate; old key rejected, new key decrypts every blob, plaintext byte-equal pre vs post |
| 6 | `06-skill-additive.sh` | Disk removal of a skill leaves vault copy intact; explicit `skill remove` drops it |
| 7 | `07-skill-mcp-fidelity.sh` | Wipe-and-pull on every skill bundle and every MCP file → `diff -r` byte-equal |
| 8 | `08-agent-filter.sh` | `--agent X` on push/pull scopes correctly; `pull --dry-run` writes nothing |
| 9 | `09-key-add.sh` | Add a second recipient; every blob decrypts under either key; idempotent re-run |
| 10 | `10-migrate.sh` | Every supported `(--from, --to, --type)` combo; `--dry-run` no-op; idempotent |
| 11 | `11-daemon-ipc.sh` | Daemon `status`, `push`, `pull` verbs work; clean shutdown |
| 12 | `12-pull-force.sh` | `pull` vs `pull --force` semantics on diverged vault history; `--dry-run` writes nothing |
| 13 | `13-doctor.sh` | Every `agentsync doctor` check fires; negative breaks surface the correct failure line |
| 14 | `14-dry-run.sh` | `push --dry-run` lists intended changes but produces no commit |
| 15 | `15-plugin-marketplace.sh` | Plugin subpath round-trip (`.claude-plugin/plugin.json`, `commands/`, `agents/`, `skills/`, `hooks/`, `.mcp.json`) + `syncMarketplace` toggle (B4, B5) |
| 16 | `16-vscode-non-mcp.sh` | Pin (B6): VS Code adapter syncs **only** `mcp.json.mcpServers`; settings/keybindings/snippets stay local |
| 17 | `17-git-protocol.sh` | `git://` transport via an in-container `git daemon` on 127.0.0.1:9418 (B7) |
| 18 | `18-copilot.sh` | Pin/verify canonical `copilot-instructions.md` filename (B16) + single-file `.agent.md` shape (B15); pin not-synced state of `lsp-config.json`, `settings.json`, `mcp-config.json` (B13, B14, B23) |
| 19 | `19-codex-overrides.sh` | `AGENTS.override.md` precedence (B17); `~/.agents/skills` canonical + legacy fallback (B22); `themes/**` absence (B25); `~/.codex/rules/` intent pin (B18) |
| 20 | `20-home-portability.sh` | **Headline.** HOME=`/tmp/alpha` push → HOME=`/tmp/beta` pull; every JSON/TOML absolute-HOME path rewrites to `/tmp/beta/…`; `/etc/hosts` and `/opt/foo` left verbatim; markdown bodies left verbatim |

## Runtime pinning policy

Every upstream toolchain that materially affects E2E behaviour is pulled at
its **latest** version on every image build:

- `node:24-bookworm-slim` (Node 22 EOL was 2026-03-24; Node 24 LTS through April 2028)
- Bun via `https://bun.sh/install` (unpinned)
- `@anthropic-ai/claude-code@latest`
- `@openai/codex@latest`
- `cursor-agent` via the upstream installer (unpinned by the vendor)

Trade-off: images aren't byte-reproducible day-to-day. The benefit is that
upstream drift surfaces here in CI rather than in user reports. Hot-pin the
affected line if a critical regression strikes.

## HOME portability (B24)

JSON and TOML values whose strings start with the current machine's
`homedir()` + path-separator are rewritten to `${AGENTSYNC_HOME}` on push.
On pull, the placeholder is rewritten back to the destination machine's
`homedir()`.

- Markdown bodies are **not** rewritten — they are user content. Sanitizer
  still scans them for embedded literal secrets (issue #47).
- Strings that don't match `homedir() + sep` (e.g. `/etc/hosts`, `/opt/foo`)
  pass through unchanged.

Scenario 20 verifies both directions plus the negative-control cases.

## Hermetic isolation contract

Enforced by `compose.yml` and `entrypoint.sh`, not by Docker itself:

- No host bind mounts of `$HOME`, `~/.claude`, `~/.cursor`, `~/.config`,
  `~/.ssh`.
- Project source is `COPY`-ed (not bind-mounted).
- No `--privileged`, no `-v /var/run/docker.sock`, no `--network host`.
- Generated keys live only inside container fs; `compose down -v` wipes
  the named vault volume between runs.
- Entrypoint asserts `HOME=/home/agent` and non-root.

Verify with the host-side canary:

```bash
./docker/e2e/canary-isolation.sh           # baseline
bun run e2e:all
./docker/e2e/canary-isolation.sh verify    # expect: host paths unchanged
```

## Running

```bash
bun run e2e:all                            # full sweep (20 scenarios)
SCENARIOS="smoke.sh 02-multi-machine.sh" bun run e2e:all
SCENARIO=18-copilot.sh bun run e2e:scenario  # one scenario
bun run e2e:smoke                          # legacy single-up smoke
bun run e2e:audit                          # decrypted-blob leak audit
```

Scenario 17 (`git://` transport) is self-contained — it spawns `git daemon`
inside the `machine` container on 127.0.0.1:9418, so no compose profile or
sidecar service is required. Run it like any other scenario:

```bash
SCENARIO=17-git-protocol.sh bun run e2e:scenario
```

## Layout

```text
docker/e2e/
├── README.md                  this file
├── Dockerfile.machine         node:24 + bun (latest) + claude/codex/cursor (@latest) + jq + rsync + netcat + age
├── compose.yml                vault-init + machine (scenario 17 runs git-daemon inside machine)
├── entrypoint.sh              rsync fixtures/home/ → /home/agent, drift-check CLIs, exec scenario
├── canary-isolation.sh        host-side leak verifier
├── run-all.sh                 local driver — iterates scenarios/*.sh
├── scripts/
│   └── audit-vaults.sh        decrypts every vault blob and greps against EMBEDDED_SECRET_PATTERNS
├── fixtures/
│   ├── home/                  real-customer config tree (rsync source)
│   └── canaries/              never-sync + literal-secret canaries (scenario-loaded)
└── scenarios/
    ├── _lib.sh                step/assert/with_machine/daemon_ipc/tar_age_extract helpers
    ├── smoke.sh
    ├── 02-multi-machine.sh
    ├── 03-diverged-history.sh
    ├── 04-sanitizer-aborts.sh
    ├── 05-key-rotate.sh
    ├── 06-skill-additive.sh
    ├── 07-skill-mcp-fidelity.sh
    ├── 08-agent-filter.sh
    ├── 09-key-add.sh
    ├── 10-migrate.sh
    ├── 11-daemon-ipc.sh
    ├── 12-pull-force.sh
    ├── 13-doctor.sh
    ├── 14-dry-run.sh
    ├── 15-plugin-marketplace.sh
    ├── 16-vscode-non-mcp.sh
    ├── 17-git-protocol.sh
    ├── 18-copilot.sh
    ├── 19-codex-overrides.sh
    └── 20-home-portability.sh
```
