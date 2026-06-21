# AgentSync TUI demo — a full tour of the interactive dashboard.
#
# Generate the GIF with `bun run demo:record`. That stands up a fake-data
# sandbox and runs `vhs` with `$HOME` and the CLI path pointed at it.
#
# Do NOT run `vhs demo/tui.tape` directly: without the sandbox env it uses
# your real $HOME and shows your real agent configuration.

Output docs/demo/tui.gif

Set Shell bash
Set FontSize 16
Set Width 1280
Set Height 720
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set TypingSpeed 90ms

# Define `agentsync` as a shell function that runs the CLI through the signed
# `bun` runtime (macOS SIGKILLs Bun's ad-hoc-signed compiled binary), with HOME
# pointed at the fake-data sandbox for this invocation only. The recorder
# exports both vars; `:?` aborts if this tape is run without them, so a stray
# `vhs demo/tui.tape` can never target the operator's real config.
Hide
Type 'agentsync() { HOME="${AGENTSYNC_DEMO_HOME:?run via bun run demo:record}" bun "${AGENTSYNC_DEMO_REPO:?run via bun run demo:record}/src/cli.ts" "$@"; }'
Enter
Type "clear"
Enter
Show

# Launch the TUI (bare `agentsync` opens the dashboard on a TTY).
Type "agentsync"
Enter
Sleep 4s

# Sync tab — answer the key prompt with `y` so the side-by-side vault/local
# diff is decrypted and the change seeded after the demo push is visible.
Type "2"
Sleep 2s
Type "y"
Sleep 4s

# Migrate tab — vault format migration status.
Type "3"
Sleep 3s

# Activity tab — session activity log.
Type "4"
Sleep 3s

# Back to the Dashboard.
Type "1"
Sleep 3s

# Help overlay, then close it.
Type "?"
Sleep 4s
Escape
Sleep 1s

# Quit.
Type "q"
Sleep 2s
