# Warden

Warden is a guardrail compiler. It turns a project's records in `.warden/`
into tool configs, a lock, and checks that run at each edit, commit, and
boundary. Warden stores configuration and generated controls under `.warden/`.

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

## Review a GitHub pull request

A Capability with `review: { adapter: code-review, model: opus }` uses Claude
Code's native `code-review:code-review` skill. Install that plugin in the
reviewer's harness. Pass the GitHub pull request URL, its current head, and
the merge base of the PR's head and target branches:

```bash
warden review brief --capability pr-audit --pull-request "$pr" \
  --base "$merge_base" --head "$head" --requirements requirements.md
```

Run the JSON invocation in Claude Code and save its report. The invocation
keeps the review read-only and checks the pull request's scope before and
after the skill runs. Triage uses the same flags with `warden review triage`
and adds `--report report.json`. Missing or stale evidence returns exit 2. If
the PR is rebased, use its new merge base and head. For a follow-up, pass
`--previous-head` and `--previous-report` for the previous round.

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
from disk with `git clean -ff`, which never follows a symbolic link and also
removes a nested repository; when a folder on that path is a link, the link
itself is removed, after it is unstaged if it was staged. Other staged and unstaged work stays where it is. An
untracked file at a restored path is replaced by the merge-base content. When
two restored paths, or a restored path and a file in the index, differ only
in case, `git commit --only` cannot commit them
correctly, so the action commits the whole index with a plain `git commit`
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

## Unit records

Declare Unit kinds and Unit ownership in `.warden/config.yaml`. A kind fixes the
document name and section order. A Unit names the kind and owns a project-relative
folder. Use `.` for the project root and nest Units to give a subfolder a more
specific owner. A Unit can also name a Term from an enabled pack. Set a kind's
`layout` to the allowed file globs relative to each Unit folder. Omit it to
adopt the documentation rules before restricting the layout.

```yaml
unitKinds:
  contract:
    document: CONTRACT.md
    sections: [Purpose, Owns, Interfaces, Invariants]
    layout: ["src/**/*.ts"]
units:
  - id: core
    kind: contract
    folder: src/core
```

`warden where <term-or-unit-or-path>` prints the Unit ID and document path.
Paths resolve to the nearest enclosing Unit, including paths to files you
are about to create. Projects that omit `units` continue to look up groups
and their `CONTRACT.md` files from the architecture pack's group collections.

To scaffold a Unit and its required document together, run
`warden new unit metrics src/metrics --kind contract`. The command appends
the record to `units` and creates `src/metrics/CONTRACT.md` with sections in
the declared order. It refuses to overwrite a document. Add `units: []` for
a project starting without any declared Units. Run `warden compile` after
adding a Unit record, then sign the commit that changes `.warden/`.

In projects with `units`, the core pack's boundary check verifies the
registered document and its level-two headings, flags extra Markdown files,
and checks ownership and layouts for tracked and unignored worktree paths.
Tracked symlinks and submodule entries count as paths. Unit documents must
be regular Markdown files. The root can hold repository files such as
`package.json` without a root Unit. Its only exempt Markdown documents are
`README.md` and `AGENTS.md`. Each other path needs an owner. Run the check
from a full worktree:

```bash
warden check --base main --tier boundary --rule warden-unit-layout
```


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

For a pack with skill Capabilities, `warden compile` writes a single locked
`SKILL.md` per skill under `.warden/generated/skills/`. Run `warden doctor`
for Claude Code or `warden doctor --harness codex` for Codex to check the
corresponding repository skill links and get the command to create them.

## Daemon

A commit-tier check, which includes the pre-commit hook and a plain
`warden check`, needs the Warden daemon. Install it once per machine as a
launchd agent:

```sh
warden daemon install
```

`warden daemon uninstall` removes it, and `warden daemon` runs it in the
foreground. The daemon watches every project whose root appears in Warden's
Evidence, which `warden init` and every check write, and every worktree of
those repositories that has `.warden/config.yaml`. It records each change to
`.warden/` and each tamper detection as Evidence with one next action. It
also records each new commit reachable from the repository's local branches
or any worktree's HEAD, whether it arrived by commit, merge, fast-forward,
cherry-pick, rebase, or `git am`. Tamper detections cover:

- a commit hook that git no longer runs;
- `.warden/` contents that no longer match the lock;
- a Claude plugin that was enabled and is now disabled or removed;
- a commit whose tree no full commit-tier check passed on, measured from the
  commit's parent or an ancestor of it. A merge whose tree equals the
  automatic merge of its two parents needs no check; any other merge does;
- a check that ran with `WARDEN_DAEMON=off`.

While the daemon holds an open alert for a repository, `warden check` fails
at every tier with that alert's next action. The alert closes when the daemon
sees the cause fixed. The daemon keeps its checkpoint in
`$WARDEN_HOME/daemon/state.json`. At its first start, and when it first
discovers a repository, it records the repository's current branch and
worktree tips as the checkpoint, and it judges only commits made after that.
It also records every ref tip once as the boundary. A commit that the
boundary reaches is not judged, unless the daemon already flagged it. The
daemon keeps every commit id it ever flagged in `state.json`. A flagged
commit stays flagged until a full check stamps it, every ref and
worktree that holds it drops it, or the owner trusts it. An alert about a working copy refuses commits only in its own
worktree. Hook problems, unchecked commits, and history scan errors refuse
commits in every worktree of the repository. The daemon skips the worktree
that `scripts/self-check.sh` creates, which holds a `.warden-self-check`
marker.

The `trusted` list in a repository's entry in `state.json` is a one-time
owner decision. Each entry names a full commit id, a reason, and a
timestamp, and the daemon never judges that commit, even if Evidence
recorded it as unchecked. Only the owner adds an entry, by editing
`state.json` while the daemon is stopped. No command, scan, or commit
content adds one.
A running daemon discovers a repository as soon as `warden init` or a check
writes the repository's first Evidence, without waiting for its next
10-second tick.

A commit-tier check judges a skip-worktree file that is missing from disk,
such as a file outside a sparse checkout, by its staged content: it copies
the staged blob to a temporary folder outside the repository and runs the
ESLint Guardrails on it. Whole-project Guardrails, such as `tsc` and
commands, still see only the files on disk.
If `state.json` is lost, the daemon rebuilds open alerts from git and
Evidence. A commit made while the daemon was stopped and `state.json` was
missing is not judged, because the daemon never recorded it.

These commits go unjudged:

- commits made before the checkpoint existed, while no daemon ran on the
  machine;
- commits made on another machine: a commit that a remote-tracking ref
  already reaches when the daemon first sees it;
- a commit pushed to a remote without ever being on a local branch or
  worktree HEAD here;
- commits in a worktree whose branch has no commit yet;
- commits in a clone on this machine where no `warden init` or check has
  run, because the daemon discovers a repository only from Warden's Evidence.
  Origin-side enforcement, tracked as cm-wkqedr.52, covers what a
  per-machine daemon cannot see.

A commit counts as another machine's only when a remote-tracking ref of a
configured remote reached it by fetch, pull, or clone, as that ref's reflog
records. A remote-tracking ref moved by a push or by `git update-ref` grants
no exemption. A commit the daemon has flagged stays flagged while any ref,
remote-tracking refs included, reaches it. A commit pulled while the daemon
was stopped loses its exemption when `git fetch --prune` deletes that
remote-tracking ref and its reflog before the daemon restarts; the daemon then
flags it, and `warden check --base <base>` on that branch clears it.

An open alert for a commit that no local branch or worktree HEAD reaches any
more is dropped.

It writes a heartbeat every 10 seconds. A commit-tier check exits 1 when the
heartbeat is missing, older than 30 seconds, dated in the future, or written
by a process that is no longer running.

`WARDEN_DAEMON=off` skips the heartbeat check, for tests and CI only. Each
check that skips it is recorded, and the daemon flags it.

Detection is tamper-evident, not tamper-proof. The heartbeat, Evidence, and
`state.json` live under your own user, so a process running as you can forge
them: a heartbeat that names another live process passes the check, a forged
Evidence run line can stamp a commit, and an edited `state.json` can let one
check pass before the daemon's next scan rewrites it.

The daemon serves a JSON API on `http://127.0.0.1:7419` (`--port` changes
it). It answers only requests whose `Host` is `127.0.0.1` or `localhost` on
that port.

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
