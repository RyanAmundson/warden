# Warden

Warden is a guardrail compiler. It turns a project's records in `.warden/`
into tool configs, a lock, and checks that run at each edit, commit, and
boundary. Warden writes only under `.warden/` in a project.

## Install

The `warden` command is installed globally from a release tag:

```bash
npm install -g git+https://github.com/RyanAmundson/warden.git#v0.1.8
warden --version
```

Replace `v0.1.8` with the release you want. Then run `warden init` in a
project's git checkout.

## Upgrade a project from Warden 0.1.7 or earlier

Warden 0.1.7 and earlier wrote Claude Code hooks and deny rules into the
project's `.claude/settings.json`. The plugin replaces them. After you
install a newer `warden`:

1. Run `warden compile`, stage `.warden`, and commit. Until then,
   `warden check` stops with that one next action.
2. Remove the old project-local Warden entries from `.claude/settings.json`:
   the `PostToolUse` hook that runs `npx --no -- warden check`, and the
   `permissions.deny` entries `Edit(.warden/**)`, `Write(.warden/**)`,
   `Bash(git commit*--no-verify*)`, and `Bash(git commit* -n*)`. Commit the
   change.
3. Install the plugin, as described next.

## Resolve a conflict in .warden/baseline.json

Every commit-tier check rewrites `.warden/baseline.json`, so parallel branches
can conflict on it. A person resolves the conflict, because the plugin refuses
agent edits under `.warden`:

1. For each Guardrail and file that both sides list, keep the lower count.
2. Keep an entry that either side removed removed.
3. Stage the file, finish the merge, and run `warden check --base <base>`.
   The check lowers any count that is still above the code's real count.

## Sign changes to .warden

Every commit since the merge base that changed a file under `.warden/` must
carry a git SSH signature from a key in the `allowed_signers` file at the root
of the installed Warden package. The list ships with Warden, so no file in the
consuming repository, `.warden/allowed_signers` included, can add a key. The
lock records the list's hash as a source, so a changed list shows up as source
drift. `warden check` verifies signatures with `ssh-keygen`, whatever the
repository's own `gpg.ssh` settings say. An unsigned change is reported as
`unsigned`, and a signature from any other key as `untrusted-signature`. The
next action restores every path changed without an allowed signature, plus
`.warden/baseline.json` when the branch changed it, to its merge-base
content with `git restore`, then commits only those paths with
`git commit --only`. Files the branch added are removed, and files it deleted
come back; a file the branch added that is no longer in the index is deleted
from disk with `git clean`, which never follows a symbolic link; when a folder
on that path is a link, the link itself is removed. Other staged and unstaged work stays where it is. An
untracked file at a restored path is replaced by the merge-base content. When
two restored paths differ only in case, `git commit --only` refuses them as
aliases, so the action commits the whole index with a plain `git commit`
instead, and other staged work joins that commit. The commit uses
`--allow-empty` so it is still made when a replace ref or a commit-graph file
makes git's own view of `HEAD` already match the merge base. The restore also
drops any signed edit to those paths made since the merge base; sign that
edit again after the restore. When another tamper finding names a file
outside the restored paths, such as an untracked pack file, the check names
that file first (an untracked one is to be deleted) and the restore after
it.

A path needs a signature only while its content differs from the merge base,
so unsigned commits that leave a path as it was at the merge base are not
reported. Warden's pre-commit hook judges the index the commit uses, the
temporary index during `git commit --only`, so it accepts a staged restore
while `HEAD` still holds the unsigned commit. It refuses a staged tree that
keeps an unsigned commit's change, and its next action restores every
unsigned path in `HEAD` or the index. Only during `git commit --only`, which
git runs on a temporary index rather than `index` or `index.lock`, do
working-copy changes to files outside the commit not refuse it; that commit
also leaves `.warden/baseline.json` alone, and the next check lowers it. A
plain or partial `git commit` is still refused while a scanned file differs
from the index. It cannot judge the signature of the commit
being made, which does not exist yet: a staged `.warden/` change on top of
signed history passes the hook, and the next check reports the commit if it
is unsigned. Where git ignores case (`core.ignorecase`), the check also
matches case variants of `.warden`, such as `.WARDEN/`.

The check ignores replace refs, grafts, the commit-graph file, and submodule
`ignore` settings. It trusts its own process and the installed package. It
cannot detect a commit object or alternate object store that was rewritten in
place in the local repository. If the real commit is already on the remote,
for example because the feature branch was pushed, a merge made from that
local copy can still put the unsigned commit into the history of `main`,
though `main`'s tree keeps the original content. These also redirect the
check: `GIT_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
`GIT_CONFIG_PARAMETERS`, a `git` or `ssh-keygen` earlier on `PATH`, and an edit
to the installed package's `allowed_signers` file. If
the package's list is missing or empty, every `.warden/` change is reported
as `no-allowed-signers`. A file that matches the base again at `HEAD` needs no
signature; an uncommitted revert does not count. `.warden/baseline.json` is
exempt, because a check only ever lowers it and a raised count is already
reported as loosening.

Sign your commits that change `.warden/`:

```bash
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
git commit -S
```

## Claude Code plugin

This repository is also a Claude Code plugin marketplace named `warden`, with
one plugin, also named `warden`. The plugin requires the global `warden`
command above; its hooks run that command, never a project-local copy.

Install it from your shell:

```bash
claude plugin marketplace add RyanAmundson/warden
claude plugin install warden@warden
```

To enable it for everyone who works in one repository, add `--scope project`
to both commands and commit the `.claude/settings.json` they write.

The plugin's hooks do nothing in a project with no `.warden/config.yaml`.
In a project that has one:

- After an Edit, Write, or MultiEdit, the hook runs
  `warden check --format agent --hook claude` at the edit tier and passes its
  block decision to Claude.
- Before a tool call, the hook runs `warden guard`. It refuses an Edit, Write,
  or MultiEdit under `.warden/`, and a `git commit` that carries `-n`, a short
  flag cluster that holds `n` such as `-an`, or `--no-verify`.
- If `warden` is not on `PATH`, or is older than the plugin's `version`, the
  hook blocks Edit, Write, MultiEdit, and `git commit` with one next action:
  the `npm install -g` command for the plugin's release. Other Bash calls go
  through, so that install can run.
- If `warden` exits with a code other than 0 or 2, the hook blocks the tool
  call and names one next action.

The hooks set `onFailure` to `block`, which requires Claude Code v2.1.295 or
later.

## Codex plugin

The same marketplace serves Codex. `.codex-plugin/plugin.json` points Codex at
`hooks/codex.json`, which runs the same `hooks/warden.sh guard` and
`hooks/warden.sh check` commands as the Claude Code plugin:

```bash
codex plugin marketplace add RyanAmundson/warden
codex plugin add warden@warden
```

Codex asks you to review the plugin's hooks before they run. Once trusted:

- Before an `apply_patch` or a shell command, the hook refuses a patch that
  adds, updates, deletes, or moves a file under `.warden/`, and a `git commit`
  that skips the pre-commit hook.
- After an `apply_patch`, the hook runs the edit check and returns its block
  decision to Codex.
- A missing or older global `warden` blocks patches and commits with the
  install command, as in Claude Code.

## Git pre-commit hook

`warden compile` writes `.warden/generated/hooks/pre-commit`, an executable
hook that runs `warden check --base <base> --trigger git-commit`. The lock
records it, so an edit to it is tampering. If `warden` is not on `PATH`, the
hook refuses the commit with the install command as its one next action.

`warden init` points git at it with `git config core.hooksPath
.warden/generated/hooks` when git runs no other hooks. The setting lives in
`.git/config`, so nothing outside `.warden/` changes in the project.
`warden doctor` reports a checkout where git does not run the hook, with one
next action:

- In a fresh clone, run `git config core.hooksPath .warden/generated/hooks`.
- Where the project already has hooks, make its `pre-commit` hook run
  `.warden/generated/hooks/pre-commit` and exit with its status, for example
  with the line `.warden/generated/hooks/pre-commit || exit $?`.

## Release

```bash
npm run release -- 0.1.9
```

On `main` with a clean tree, the release script bumps the version in
`package.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json`
and commits,
tags `v<version>` and pushes `main` and the tag, reinstalls the global
`warden` from the tag, pins Warden's pre-commit hook to the tag with
`scripts/install-hooks.sh`, recompiles Warden's own lock and commits and
pushes it, and confirms that `warden --version` prints the new version. A
failed step stops the script with one next action. Rerunning the same command
skips the version bump and the tag when they already exist, and repeats the
other steps.
