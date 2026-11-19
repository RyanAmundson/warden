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
`unsigned`, and a signature from any other key as `untrusted-signature`. If
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

Codex hooks are not shipped. They would go in this repository beside
`hooks/hooks.json`, as a Codex hook config that calls the same
`hooks/warden.sh guard` and `hooks/warden.sh check` commands.

## Release

```bash
npm run release -- 0.1.9
```

On `main` with a clean tree, the release script bumps the version in
`package.json` and `.claude-plugin/plugin.json` and commits,
tags `v<version>` and pushes `main` and the tag, reinstalls the global
`warden` from the tag, pins Warden's pre-commit hook to the tag with
`scripts/install-hooks.sh`, recompiles Warden's own lock and commits and
pushes it, and confirms that `warden --version` prints the new version. A
failed step stops the script with one next action. Rerunning the same command
skips the version bump and the tag when they already exist, and repeats the
other steps.
