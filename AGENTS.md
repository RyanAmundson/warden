# Agent instructions for Warden

## Land changes on main

Don't open pull requests in this repository. Commit on a worktree branch, then
land the work on `main` with a fast-forward push.

## Rebased commits need a check

A rebase writes new commits without running the pre-commit hook. The Warden
daemon flags each one as an unchecked commit and refuses commits in every
worktree of this repository until the commit is checked. To clear it, run
`warden check --base <commit>^` in a detached checkout of that commit. Keep the
checkout until the alert closes, about 10 seconds.
