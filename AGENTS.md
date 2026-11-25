# Agent instructions for Warden

## Land changes on main

Don't open pull requests in this repository. Commit on a worktree branch, then
land the work on `main` with a fast-forward push.

## Warden never blocks

Ryan, 2026-11-24: "warden should not be blocking anything ever". Every check,
alert, and hook reports its finding and exits 0. Never add a path that denies
a tool call, fails a commit, or exits nonzero on a finding, and never write a
next action that asks someone to reset, delete, or rewrite Git history.
`test/never-blocks.test.ts` enforces this; see "Warden never blocks" in
`README.md`.

## Rebased commits need a check

A rebase writes new commits without running the pre-commit hook. The Warden
daemon flags each one as an unchecked commit and reports the alert in every
worktree of this repository until the commit is checked. To clear it, run
`warden check --base <commit>^` in a detached checkout of that commit. Keep the
checkout until the alert closes, about 10 seconds.
