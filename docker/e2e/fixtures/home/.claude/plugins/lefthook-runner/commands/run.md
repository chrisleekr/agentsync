# /run

Runs the configured lefthook stage against the working tree.

Default stage is `pre-commit`. Pass `--stage pre-push` to target push hooks.

Fails fast on the first hook failure and prints the offending command.
