# /deploy

Runs the deploy pipeline for the current branch.

## Steps

1. Confirm the working tree is clean.
2. Tag the release with `vX.Y.Z`.
3. Push the tag and let CI publish artifacts.

Aborts if the branch is not `main`.
