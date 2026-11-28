# Warden

Warden is a guardrail compiler. It turns a project's records in `.warden/`
into tool configs, a lock, and checks that run at each edit, commit, and
boundary. Warden stores configuration and generated controls under `.warden/`.

## Warden never blocks

Ryan Amundson, 2026-11-24: "warden should not be blocking anything ever".

Warden reports; it never refuses. This is the contract every path follows:

- `warden check`, `warden audit`, `warden guard`, and `warden session-end`
  exit 0, including on findings, tamper alerts, an outdated lock, a stopped
  daemon, and errors. The check's verdict goes to stderr, to the run record's
  `exit` field, and to the dashboard.
- The generated pre-commit hook exits 0, even when `warden` is missing or
  exits nonzero, so every commit goes through.
- The Claude Code and Codex hooks exit 0. They hand findings to the agent as
  `additionalContext` and never return a deny or block decision.
- No next action asks anyone to reset, delete, or rewrite Git history.

Where this README says that a check refuses or fails, it means the verdict
that Warden reports. `test/never-blocks.test.ts` enforces the contract.

## Install

Install Node.js 25 or later and Git. Install Warden from a release tag:

```bash
npm install -g git+https://github.com/RyanAmundson/warden.git#v0.1.15
warden --version
```

In a new project's Git checkout, run `warden init` to enable Core. Run
`warden daemon install` once on macOS to start the dashboard and support commit
checks. You can run `warden daemon` in the foreground instead. In an existing
Warden project, run `warden compile` and commit the regenerated policy lock
when you switch Warden versions.

The install includes all bundled pack definitions and built-in adapters. Open
**Layers > Packs > Checks and setup** to see the prerequisites for each pack.
Set project-specific paths and settings before compiling a new selection.
For example, give RxJS Declarative and Signals separate folder scopes if you
enable both.

## Upgrade a project from Warden 0.1.7 or earlier

Warden 0.1.7 and earlier wrote Claude Code hooks and deny rules into the
project's `.claude/settings.json`. The plugin replaces them. After you
install a newer `warden`:

1. Run `warden compile`, stage `.warden`, and commit. Until then,
   `warden check` reports that one next action instead of running rules.
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

## Inspect learning evidence

Run `warden report --learning` to see resolved findings, upheld disputes,
session stalls, and confirmed escapes. Add `--format json` for structured output. Precision
is the share of measured outcomes that Warden recorded as resolved. With no
resolutions or upheld disputes, Warden shows precision as unmeasured.

The scorecard uses the checkout's retained resolution Evidence and durable
dispute rulings. Confirmed escapes come from the repository's review history
and count toward the Practice shared by its Guardrails. On Claude Code
session end, Warden records a stall if a completed edit check proved a
Guardrail failure, the judged file still has the same contents, and the
retained evidence shows no fix or dispute covering that failure.

To measure a Guardrail's strength, add named `mutations` to its record.
Each entry uses the same format as `mustFail` and expresses a distinct
example of the same violation. After activating the policy, run
`warden review mutations --base main --rule <id>`. Warden checks the must-fail control
and then runs each variant in its own example project using the pack's
example settings. The learning report shows how many variants the adapter
caught for the current policy. A surviving variant records hollow evidence
for review.

Run `warden review proposals` to see Add suggestions from confirmed escapes
and Edit suggestions from upheld disputes or current hollow measurements.
Set `learning.repeatFindings` in `.warden/config.yaml` to the minimum
number of distinct review series and heads that can support an Add
suggestion. Warden groups matching blocking findings for one Practice and
cites the exact recorded reviews. Set `learning.removalRuns` to the minimum
number of distinct clean project trees with passing boundary coverage for
equivalent project-scoped filesystem rules. Warden suggests removing a duplicate
only when the retained Evidence includes no violations from either rule.
An independent reviewer can accept a tighter rule. A trusted policy signer
must approve any loosening, including removal. Use `warden review proposals --record`
to save an immutable copy of each proposal and its evidence for review.
Repeating the command with the same evidence returns the same record.

## Configure a System One decision Guardrail

Use `system-one:noul` as a project-scoped `model` Guardrail at the boundary
tier. Set `options.model` to an exact Jev or Laya version available to
the provider account. Use `options.question` to ask whether the files meet
the Practice.
List the files the runner can send in `options.inputs`. Provide
`failBelow` and `passAt` for the confidence thresholds. Results below
`failBelow` fail, results at or above `passAt` pass, and results between the
two require independent review. The Warden policy lock covers these settings.

Compilation checks the model's must-pass and must-fail examples against the
same decision thresholds. Enable uncached requests with `WARDEN_TYPESAFE=1`
and `TYPESAFE_API_KEY` only in a trusted runner approved to send those files
to TypeSafe. Warden sends the declared files and the question, records the
model, request digest, probability, verdict, and whether each answer came
from the provider or cache. The fixed-input benchmark uses the recorded
live evaluation time for the must-pass example. A cache hit reuses that
measurement. Use a runner-owned `WARDEN_HOME` for boundary checks and
use admission examples with the same declared input paths.

See the [System One API](https://docs.typesafe.ai/api/system-one.md) for
the response schema and the model-discovery endpoint.

## Resolve a conflict in .warden/baseline.json

Every commit-tier check rewrites `.warden/baseline.json`, so parallel branches
can conflict on it. A person resolves the conflict, because only a person
edits `.warden`:

1. For each Guardrail and file that both sides list, keep the lower count.
2. Keep an entry that either side removed removed.
3. Stage the file, finish the merge, and run `warden check --base <base>`.
   The check lowers any count that is still above the code's real count.

## Sign changes to .warden

A project enrolled from outside the repository is signed differently; see
[What keeps an enrolled policy from being loosened](#what-keeps-an-enrolled-policy-from-being-loosened).

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
correctly. The recovery checks for unrelated staged and unstaged tracked changes
before restoring the files, restores the merge base's spelling from the
index, and commits with plain `git commit`.
Move any unrelated changes aside before running the recovery again. The commit uses
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
  findings to Claude as additional context.
- Before a tool call, the hook runs `warden guard`. It reports an Edit, Write,
  or MultiEdit under `.warden/`, and a `git commit` that carries `-n`, a short
  flag cluster that holds `n` such as `-an`, or `--no-verify`, as additional
  context. The tool call goes through.
- If `warden` is not on `PATH`, or is older than the plugin's `version`, the
  hook prints the `npm install -g` command for the plugin's release on stderr
  and skips Warden.
- If `warden` exits with a nonzero code, the hook says so on stderr. Every
  hook exits 0.

## Codex plugin

The same marketplace serves Codex. `.codex-plugin/plugin.json` points Codex at
`hooks/codex.json`, which runs the same `hooks/warden.sh guard` and
`hooks/warden.sh check` commands as the Claude Code plugin:

```bash
codex plugin marketplace add RyanAmundson/warden
codex plugin add warden@warden
```

Codex asks you to review the plugin's hooks before they run. Once trusted:

- Before an `apply_patch` or a shell command, the hook reports a patch that
  adds, updates, deletes, or moves a file under `.warden/`, and a `git commit`
  that skips the pre-commit hook, as additional context.
- After an `apply_patch`, the hook runs the edit check and returns its
  findings to Codex as additional context.
- A missing or older global `warden` prints the install command on stderr,
  as in Claude Code, and the patch or commit goes through.

## Read your project's published audit

The Warden plugin includes the `main-audit` skill in Claude Code and
Codex. Install or update the plugin at user scope to make the skill available
without adding files to your project. Ask your agent what Warden found on
published main from the registered checkout or one of its Git worktrees.

The skill reads the local daemon's existing audit receipts. It reports the
audited ref and commit, each audit tier's result, and findings with file
locations and guidance. Compare findings with the code in your worktree and
run the project's checks to verify any fix.

## Publish an external check

A local checker can contribute a report for an existing signed enrollment.
For ESLint, run the checker with its JSON formatter against a clean checkout
of the enrolled ref, then publish the report from that checkout.

```sh
warden publish eslint PROJECT /path/to/eslint-report.json
```

Warden checks the report's file paths and diagnostic counts and matches the
checkout's commit to the enrolled ref. The local publisher supplies the
report and is responsible for running the checker against that checkout.
The receipt covers the files in the report. Publishing creates no watch
and does not change repository files.

Read the receipt through the dashboard's Runs page, the `main-audit` skill,
or `GET /api/runs?project=PROJECT`. Use the skill helper's `--watch` option
from any linked worktree to receive updates.

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
    publicEntry: src/index.ts
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

Add `unit-layout` under `packs` alongside `core` to check each declared
Unit's document, heading order, path ownership, and layout at the boundary.

```yaml
  - id: unit-layout
    paths: ["**/*"]
```

Run `warden compile` and sign the commit that changes `.warden/`. The check
examines tracked and non-ignored untracked paths. Unit documents must be
regular Markdown files.
The root can hold repository files such as `package.json` without a root
Unit. `README.md` and `AGENTS.md` are the root Markdown exceptions. The check
skips control folders unless a Unit is declared inside them. Run it from a
full worktree:

```bash
warden check --base main --tier boundary --rule warden-unit-layout
```

The `warden-unit-document-links` check validates local Markdown links in the
same documents. A fragment in a Markdown destination must match a heading
or an explicit anchor. [GitHub's heading and anchor syntax](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax#section-links)

Set a Unit's optional `publicEntry` to a JavaScript or TypeScript file relative
to its folder. The kind must require an `Interfaces` section. In that section,
start a Markdown list item for each ES module export with its exported name in
inline code. Use the public alias for a renamed export and `default` for the
default export. The check includes type exports. It follows relative wildcard
re-exports through regular repository files using standard TypeScript bundler
resolution. Give exports from external packages or project-specific module
aliases explicit names. Use `warden new unit --public-entry <file>` to declare
the entry while scaffolding a Unit.

Local packs can use `scope: project` on `fs:` Guardrails that run at the
boundary. Run these checks from a full checkout. They receive tracked and
non-ignored untracked paths, including paths outside the pack's globs. The
adapter identifies non-regular entries and reads regular project files.

For a check that depends on declared Units, set `unitExample` with a `folder`
and `kind` matching its `mustPass` and `mustFail` examples. During compilation,
Warden uses that example Unit to verify both cases. During a boundary check,
the Guardrail receives the project's declared Units and their file ownership.
Warden skips checks with `unitExample` in projects that omit `units`.

## Module Guardrails

A `module:<pack>/<name>` Guardrail runs `<name>` from the pack's `module.js`
with the same input as an `fs:` Guardrail, plus `load(file)`. `load` imports
one of the given files and returns its exports as data: functions become
`{ "$function": "<name>" }`, and a true cycle becomes `"[Circular]"`. Warden
loads TypeScript with its bundled compiler and resolves bare imports from the
project's installed `node_modules`, so the project needs no TypeScript runtime
of its own. Loading runs the module's code outside the sandbox, in its own Node
process. A module that does not load makes `load` throw with the error.

## Check plugin compliance

The `plugin-compliance` pack checks plugins built on the plugin SDK's
`definePlugin` against 17 rows: 8 from the plugin's source files and 9 from
the manifest its `plugin.ts` exports. Every row runs at the boundary tier
only, so no hook runs it. Install the project's dependencies, then run:

```bash
warden check --tier boundary --base main
```

```yaml
  - id: plugin-compliance
    paths: ["**/*"]
    settings:
      plugins: ["plugins/*"]   # default ["."]: the project root is the plugin
      sharedCode: [libs]
      hostImports: ["^@app/"]
      legacyImports: ["^@sdk/shims/"]
```

Keep `paths` at `["**/*"]`; the `plugins` setting chooses the folders. An
entry ending in `/*` names each folder directly inside it. Each plugin keeps
its published contracts in `contracts.lock.json`; a finding for a new
contract prints the entry to add. See
[the design](docs/design/2026-11-25-plugin-compliance-pack-design.md) for
each row and setting.

## Git pre-commit hook

`warden compile` writes `.warden/generated/hooks/pre-commit`, an executable
hook that runs `warden check --base <base> --trigger git-commit`. The lock
records it, so an edit to it is tampering. The hook always exits 0. If
`warden` is not on `PATH`, it prints the install command and the commit goes
through unchecked. If `warden check` exits nonzero, it says so and the commit
goes through.

`warden init` points git at it with `git config core.hooksPath
.warden/generated/hooks` when git runs no other hooks. The setting lives in
`.git/config`, so nothing outside `.warden/` changes in the project.
`warden doctor` reports a checkout where git does not run the hook, with one
next action:

- In a fresh clone, run `git config core.hooksPath .warden/generated/hooks`.
- Where the project already has hooks, make its `pre-commit` hook run
  `.warden/generated/hooks/pre-commit` and ignore its status, for example
  with the line `.warden/generated/hooks/pre-commit || true`.

Use `warden where <term>` to find the Capability whose `serves` field names
that Term. Warden prints its ID, kind, and purpose. Use
`warden where --capability <term>` if the Term also names a Unit or looks
like a path. An explicit path such as `./change` searches Units only. Exact
Unit IDs and Terms take precedence over folder ownership.

Register a skill or tool in an enabled project pack using its purpose Term:

```bash
warden new skill project-report --pack project --serves report \
  --purpose "Show the project's Guardrails." --when "inspecting project rules" \
  --command "warden report"
warden compile
```

Use `warden new tool` with the same options to register a tool. Both commands
append a Capability record to `.warden/packs/<pack>/pack.yaml`. The Term must
already be declared by an enabled pack. Use `--upholds` for Practice IDs and
`--replaces` for the actions the Capability replaces. Sign the changes to
`.warden/` after compiling.

Enable the `tool-registration` pack to check new tools at the boundary.
The pack checks the root `package.json` for additions to `scripts` and `bin`.
Set `manifests` to the full list of npm manifests to monitor in a workspace.
The pack also checks new executable files and Node, sh, or Bash scripts
with shebangs under `scriptFolders`, which defaults to `[scripts]`. Use
portable names with letters, digits, dots, dashes, and underscores in these
paths. Warden compares the declarations with the merge base.

Run `warden check --rule no-unregistered-tools --tier boundary --base main`
to see the command to register for each new tool. In a tool Capability,
use `npm run report` for a root npm script, `npm --prefix packages/tools run report`
for a workspace script, or a project-relative command such as
`node ./scripts/report.js` for a launcher. Compilation checks that the
declarations resolve without executing the project tools.

In a pack record, use text for process steps and a `command` entry for a
literal Bash tool request that the Capability replaces.

```yaml
replaces:
  - preparing a report by hand
  - command: ./scripts/old-report.sh --summary
```

The Claude Code and Codex Warden hooks deny that complete request, allowing
extra spaces or tabs between words. Use unquoted command words and arguments.
Compound commands, aliases, and commands run inside scripts are outside this
matching contract. The compiler rejects replacements that would deny a
registered Capability command, including commands that fill in
`<argument>` or variadic `<arguments...>` placeholders. Each denied
replacement records `tampered` Evidence for the Capability.

For a pack with skill Capabilities, `warden compile` writes a single locked
`SKILL.md` per skill under `.warden/generated/skills/`. Run `warden doctor`
for Claude Code or `warden doctor --harness codex` for Codex to check the
corresponding repository skill links and get the command to create them.

## Audit mode

Warden blocks nothing in either mode; see [Warden never blocks](#warden-never-blocks).
The mode decides the verdict a check records. Add `mode: audit` to
`.warden/config.yaml` and run `warden compile`. In audit mode, rule failures,
tampering, daemon alerts, a stopped daemon, and errors record verdict 0, the
dashboard shows each run as an audit result, and agents get no edit feedback.

Warden decides the mode from the lock at the merge base of your branch and the
base branch, so a branch must contain the commit that switched to audit mode.
A branch made before the switch records enforce verdicts until you merge the
base branch into it. Warden also records enforce verdicts while the daemon
reports the switching commit as unchecked. Check that commit, or have the
repository owner sign it with `warden trust`.

Switching an enforcing project to audit mode is loosening, so the check reports
that change until it lands on the base branch. The default, `mode: enforce`,
records failures with a failing verdict.

## Advisory checks

Run `warden audit` to report edit-tier findings. Use `--tier boundary` to
evaluate boundary-tier rules, `--rule <id>` to select a rule, and
`--format json` to capture the results. By default, Warden uses the base
recorded in the committed lock.

```sh
warden audit --tier boundary --rule warden-unit-layout --format json
```

An audit exits 0. Policy drift, unfinished checks, and daemon alerts about
policy integrity record a failing verdict. An audit leaves
the baseline, Git index, and commit approval records intact. The daemon
continues to record commit-hook and unchecked-commit alerts for enforcement
through `warden check`.

## Check for blocking calls

Enable the `performance` pack for code that runs on a latency-sensitive
event loop, such as Electron main and the services it calls. Add this entry
under `packs` in `.warden/config.yaml` and run `warden compile`.

```yaml
  - id: performance
    paths: ["src/main/**", "src/settings/**"]
```

The pack reports direct synchronous Node filesystem and subprocess calls,
including aliased named imports, module members, and direct CommonJS bindings.
Tests and stories are excluded. Scope the paths to the code that runs on the
event loop. A worker or a command-line script can have different requirements.
The check uses file-local bindings. Use a live responsiveness test to measure
event-loop delays and input latency.

Run an advisory check on the paths you want to inspect.

```sh
warden audit --rule performance-blocking-node-calls --format json src/main
```

## Enroll a project from outside

The daemon can audit a repository's published ref without reading policy from
the repository or writing anything to it. The enrollment lives under
`$WARDEN_HOME/enrollments/<id>/`, one folder per repository path and ref:

- `enrollment.json`: the project ID, the repository's absolute path, the
  full ref, the data globs, and the links.
- `policy/`: the project's `.warden` folder, with `config.yaml`,
  `baseline.json`, `lock.json`, and generated files.
- `data/`: records that a pack reads at repository paths, such as each
  plugin's `contracts.lock.json` for the `plugin-compliance` pack, stored at
  the same relative paths.
- `signed.json` and `signed.json.sig`: what the owner signed.
- `checkpoint.json`: the last audited commit for each tier.

To move an in-repo enrollment out of the repository, run `warden enroll
migrate` on the repository's root. It reads `.warden/` and the data files
from a commit with `git cat-file`, compiles the lock with the running Warden,
and confirms that the enrolled baseline holds the same number of gaps as the
repository's. It writes nothing to the repository.

```sh
warden enroll migrate /path/to/repo --ref refs/remotes/origin/main \
  --data 'plugins/*/contracts.lock.json' --link node_modules
```

`--from <commit>` picks the commit to copy, and defaults to the ref.
`--data` takes globs in the same syntax as pack paths. `--link` names
working-tree paths, such as `node_modules`, that the audit checkout links to
so that the module adapter can load `plugin.ts`. `--initial-base <commit>`
starts the first comparison at an earlier commit. Running `migrate` again
replaces the enrollment and its checkpoint.

The daemon audits nothing until the owner signs the enrollment. Review the
folder, then run this in a terminal and enter the key's passphrase:

```sh
warden enroll sign /path/to/repo --ref refs/remotes/origin/main --key ~/.ssh/warden_owner
```

The key must be listed in Warden's `trust_signers`, have a passphrase, and
stay out of `ssh-agent`, as for [`warden trust`](#daemon). Restart the
daemon after a new enrollment; a change to an existing one applies at the
next scan. The daemon still reads `daemon/audit-only.json` only to report that
it is obsolete: migrate and sign each repository it lists, then delete it.
After a Warden
upgrade, or after you edit `policy/config.yaml`, run `warden enroll compile
/path/to/repo --ref <ref>` and sign again.

Every 10 seconds the daemon reads each enrolled ref from the repository's
local Git objects. When the ref has advanced, it audits the new commit with
the edit and boundary tiers in a temporary Git checkout. That checkout has
no remote refs. Its commits are snapshots of the audited commit and its base.
Each snapshot drops the repository's own `.warden/` and every file the data
globs match, then holds the enrolled `policy/` as `.warden/` and the files in
`data/`. Only the enrolled packs run. Each tier uses its last completed
commit as the base, or the first audited commit's parent. Failed runs retry
after one minute or when the ref advances. Your existing fetch process keeps
remote-tracking refs current. Each receipt records the repository, ref,
commit, base, and enabled packs, and the dashboard shows the receipts for the
enrolled ref. A run that cannot start, for example because the ref no longer
descends from the last audited commit, records an `error` receipt for each
tier, once per distinct message. Automatic hooks and checkout discovery skip
every worktree of an enrolled repository.

### Contribute checks and report adapters

Use a project-owned pack to contribute rules. Copy the reviewed pack directory
to the enrolled `policy/packs/<id>/` and enable it by ID in
`policy/config.yaml`. The directory contains `pack.yaml` and any implementation
files required by its adapter. For example, an `fs:<id>/<name>` rule calls the
named function in the default export of `fs.js`. Give each rule a passing and a
failing example. Compile and sign the enrollment with the existing commands.
Future edits to the source project do not update that signed copy.

From any linked checkout of the enrolled repository, run a signed boundary rule
against two full Git commit IDs:

```sh
warden candidate example refs/remotes/origin/main "$old" "$new" --rule source-layout
```

Warden reads the commits even if the checkout is dirty or points at another
revision. It uses a temporary snapshot and writes no watcher registration,
daemon checkpoint, or published evidence. It prints a version 1 JSON receipt
with `project`, `ref`, `base`, `candidate`, `rule`, and `result`. The result is
`pass`, `fail`, or `error`. A Git hook can require a matching `pass` receipt and
reject a missing or malformed receipt. Warden exits zero on findings and
errors. The consumer decides whether to proceed.

To report checks that already run outside Warden, add a unique adapter ID to
`reportAdapters` in the signed `enrollment.json`. Implement the conversion
in the project and pass its version 1 JSON to Warden:

```json
{
  "version": 1,
  "commit": "<full Git commit ID>",
  "files": ["src/index.ts"],
  "warnings": 0,
  "findings": [
    {
      "file": "src/index.ts",
      "line": 1,
      "rule": "example-rule",
      "message": "Describe the finding and how to fix it."
    }
  ]
}
```

```sh
warden publish example-adapter example ./report.json --format json --snapshot /path/to/clean/checkout
```

The report must name the current enrolled commit. List each checked tracked
file once and attach findings only to those files. Use line zero for a
file-level finding. Warden records these reports as partial evidence. The
project runs the check and produces the report. Warden validates the interchange
format and displays the evidence.

### What keeps an enrolled policy from being loosened

The signature replaces the signed `.warden` commits that an in-repo
enrollment needs; see [Sign changes to .warden](#sign-changes-to-warden).
Before each audit, the daemon checks `signed.json.sig` against
`trust_signers` and compares the folder with `signed.json`. It reports these
findings as `tampered` receipts, and runs no rules until the cause is fixed:

- `unsigned` or `untrusted-signature`: the owner has not signed, or another
  key signed.
- `changed`, `added`, or `removed`: `enrollment.json`, a file in `policy/`,
  or a file in `data/` differs from what was signed.
- `loosened`: `policy/baseline.json` holds a count above the signed count for
  a rule and file, or an entry the signed baseline lacks.

A lowered baseline count needs no new signature. Inside the checkout, the
audit still reports a lock that no longer matches the enrolled config as
policy drift.

Limits: a process running as you can edit `trust_signers` in the installed
package, replace the daemon's runtime, or delete Evidence lines, so keep the
package and `$WARDEN_HOME` out of agents' reach where you can. The unsigned
`checkpoint.json` decides which commits are still to be audited, so an edit
to it can skip a commit without a receipt. Linked paths come from the
repository's working tree, not the audited commit, are not signed, and take
any write a pack makes through them. Audits do not lower the enrolled
baseline; lower it by hand. The checkout reads the repository's objects
through Git's alternates file; Git can refresh the timestamps of those object
files, but it writes no new files to the repository.

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

The daemon can check integrity for an older lock committed at the checkout's
HEAD when its policy, source hashes, and generated paths match the running
compiler. It checks generated files against the committed manifest. Run checks
with the Warden release pinned by the lock to evaluate the Guardrails.

While the daemon holds an open alert for a repository, `warden check` reports
that alert's next action at every tier and exits 0. The alert closes when the daemon
sees the cause fixed. The daemon keeps its checkpoint in
`$WARDEN_HOME/daemon/state.json`. At its first start, and when it first
discovers a repository, it records the repository's current branch and
worktree tips as the checkpoint, and it judges only commits made after that.
It also records every ref tip once as the boundary. A commit that the
boundary reaches is not judged, unless the daemon already flagged it. The
daemon keeps every commit id it ever flagged in `state.json`. A flagged
commit stays flagged until a full check stamps it, every ref and
worktree that holds it drops it, or the owner trusts it. An alert about a
working copy is reported only in its own worktree. Hook problems, unchecked
commits, and history scan errors are reported in every worktree of the
repository. No alert stops a commit. The daemon skips the worktree
that `scripts/self-check.sh` creates, which holds a `.warden-self-check`
marker.

### Trust a commit

Trusting a commit is a one-time owner decision, and an agent running as you
cannot make it. Run this in a terminal, in a checkout of the repository:

```bash
warden trust <commit> --key ~/.ssh/warden_owner --reason "<why>"
```

It signs the repository's Git common directory, the full commit id, the
reason, and the time with your key under the SSH signature namespace
`warden-trust`, and writes the record to `$WARDEN_HOME/daemon/trust/`. The
daemon stops judging that commit at its next scan, even if Evidence recorded
it as unchecked. A record names one repository, so it does not trust the same
commit in another clone.

The daemon honors a record only when `ssh-keygen -Y verify` accepts its
signature from a key in the `trust_signers` file at the root of the installed
Warden package. Every other record, and any `trusted` list in `state.json`,
which older releases read, opens an `untrusted-trust` alert that is reported
in every worktree of the repository until the file or list is deleted. That alert never clears the commit it names.

The key is what keeps an agent out, so it must need you:

1. Make a key with a passphrase: `ssh-keygen -t ed25519 -f ~/.ssh/warden_owner`.
2. Never add it to `ssh-agent`, and use a different key for Git signing.
   An agent can sign with any key that the agent or the disk holds without a
   passphrase.
3. Add `<you> <public key>` from `~/.ssh/warden_owner.pub` to
   `trust_signers`, and sign the commit that changes it.

`warden trust` refuses a key that has no passphrase, a key that `ssh-agent`
holds, and a key that `trust_signers` does not list. `ssh-keygen -Y sign`
uses a key from `ssh-agent` without asking for the passphrase, so do not
name this key as an `IdentityFile` in an `ssh_config` that sets
`AddKeysToAgent`. `ssh-keygen` asks for the passphrase on the
terminal, which a process without one cannot answer.

A running daemon discovers a repository as soon as `warden init` or a check
writes the repository's first Evidence, without waiting for its next
10-second tick.

A commit-tier check judges a skip-worktree file that is missing from disk,
such as a file outside a sparse checkout, by its staged content: it copies
the staged blob to a temporary folder outside the repository and runs the
ESLint Guardrails on it. Whole-project Guardrails, such as `tsc` and
commands, still see only the files on disk. A check with changed files outside
the checkout, or missing files needed for whole-project rules, records partial
coverage. Use a full worktree when Warden needs to verify the complete commit.
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
  Origin-side enforcement, not built yet, would cover what a per-machine
  daemon cannot see.

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

It writes a heartbeat every 10 seconds. A commit-tier check reports on stderr
when the heartbeat is missing, older than 30 seconds, dated in the future, or
written by a process that is no longer running, then runs its rules.

`WARDEN_DAEMON=off` skips the heartbeat check, for tests and CI only. Each
check that skips it is recorded, and the daemon flags it.

Detection is tamper-evident, not tamper-proof. The heartbeat, Evidence, and
`state.json` live under your own user, so a process running as you can forge
them: a heartbeat that names another live process passes the check, a forged
Evidence run line can stamp a commit, and an edited `state.json` can let one
check pass before the daemon's next scan rewrites it. Deleting a flagged
commit from `state.json` while the daemon is stopped does not clear it: at
start the daemon adds back every commit that Evidence records as unchecked.
Only a signed trust record trusts a commit. A process running as you can still
edit `trust_signers` or delete Evidence lines, so keep the package and
`$WARDEN_HOME` out of agents' reach where you can.

The daemon serves a JSON API on `http://127.0.0.1:7419` (`--port` changes
it). It answers only requests whose `Host` is `127.0.0.1` or `localhost` on
that port. `GET /api/projects` groups watched checkouts and open alert counts
by Git common directory within each project label. Pass a URL-encoded `repo`
from that response to `GET /api/tamper` to limit alerts to that repository.

### Watch an agent's UI change

Enable the `change-video` pack to have agents record a video of each UI change
with `warden video record`. The run's page on the dashboard plays the video and
shows its keyframes. `GET /api/video` serves the files from
`$WARDEN_HOME/videos`. See [packs/change-video/README.md](packs/change-video/README.md).

### Change a project's packs

On the dashboard, open **Layers**, choose the project, and scroll to **Packs**.
If the project has multiple worktrees, choose the checkout to edit. Select the
packs you want and click **Save pack changes**. Warden writes the selection to
that checkout's `.warden/config.yaml`. Disabled packs keep their paths and
settings under `enabled: false`. Newly added packs start with `paths: ["**/*"]`.
The dashboard keeps an enabled `core` pack on.

Review the config diff, run `warden compile` in that checkout using the same
Warden build as the dashboard, and sign the commit that changes `.warden/`.
The save action only writes the config.

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
