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
- If `warden` is not on `PATH`, or exits with a code other than 0 or 2, the
  hook blocks the tool call and names one next action.

The hooks set `onFailure` to `block`, which requires Claude Code v2.1.295 or
later.

Codex hooks are not shipped. They would go in this repository beside
`hooks/hooks.json`, as a Codex hook config that calls the same
`hooks/warden.sh guard` and `hooks/warden.sh check` commands.

## Release

```bash
npm run release -- 0.1.9
```

On `main` with a clean tree, the release script bumps the version and commits,
tags `v<version>` and pushes `main` and the tag, reinstalls the global
`warden` from the tag, pins Warden's pre-commit hook to the tag with
`scripts/install-hooks.sh`, recompiles Warden's own lock and commits and
pushes it, and confirms that `warden --version` prints the new version. A
failed step stops the script with one next action. Rerunning the same command
skips the version bump and the tag when they already exist, and repeats the
other steps.
