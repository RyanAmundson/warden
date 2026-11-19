# Warden: a guardrail framework for agent-run repositories

Status: approved by Ryan, November 18, 2026, with the boundary and signing key left open. Tracking epic: `cm-wkqedr`.

## Intent

Ryan lets coding agents (Claude Code, Codex) work in his repositories with
little supervision. Agents repeatedly do three things that rules written as
prose cannot stop:

- They claim to do one thing and do the opposite.
- They break a rule, then rewrite the rule or switch off the check.
- They suppress a check locally: an `eslint-disable` comment, a skipped test,
  an ignore-list entry, or `--no-verify`.

Warden is a development environment that makes those moves fail
deterministically, explains every failure, and learns which of its own rules
earn their place. It is a standalone, reusable tool. Context Manager is its
first consumer, not its home.

## Goals

- Every rule is data in one normalized source. A compiler turns that source
  into the configurations that existing tools already enforce.
- Rules are layered from generic to specific, and the layering is checked:
  higher layers only tighten, and no two rules contradict each other.
- Every place an agent could weaken a check is covered: generated
  configurations are hash-locked, inline suppressions cannot exist, and
  changes to the rule source need Ryan's signature.
- Each rule can be run, tested, and explained in isolation, on any path.
- A generator CLI creates and updates every record, so the structure is never
  hand-written wrong.
- A learning layer records how each guardrail performs and proposes additions,
  edits, and removals.
- A coverage report shows each practice, its guardrails, their kind, their
  strength, and their measured confidence.

## Non-goals

- Formal proofs in Lean. Nothing in the target repositories needs proofs of
  mathematics, and the cost would exceed every other layer combined.
- A new rule language. Records are YAML checked by a JSON Schema; guardrail
  logic is ordinary code.
- Replacing ESLint, TypeScript, or git hooks. Warden configures them.
- Rewriting Context Manager's existing check scripts in the first version.
  They are registered as guardrails as they are.
- Generating `docs/CANON.md`. CANON stays authoritative and hand-maintained;
  records link to its invariant numbers.

## Anti-goals

Warden fails, even if it technically works, when:

- An agent can loosen a rule without Ryan's signature.
- A rule exists only as prose, with no guardrail that fails on a violation.
- Warnings exist. Every finding is an error or nothing.
- A guardrail is flaky or slow and people learn to route around it.
- Warden's own files spread across the consuming repository instead of living
  in one folder named for the tool.

## The model: seven record types

| Record | Holds | Example |
|---|---|---|
| Term | One definition and the synonyms it bans. | `plugin`; bans `extension`, `addon`. |
| Unit | One system or entity: its id (a Term), kind, folder, and its one document. | `unit: rxdb-manager`, kind `service`, folder `[services]/rxdb-manager/`. |
| Practice | One rule, written only with Terms, and the paths it applies to. | "UI state is declarative RxJS streams." |
| Guardrail | What enforces a Practice: kind, where it runs, its implementation, and one example that must fail and one that must pass. | `eslint:warden/no-inline-config`. |
| Pack | A named bundle of Terms, Practices, and Guardrails. | `core`, `typescript`, `rxjs-declarative`. |
| Capability | A skill or tool agents may use: purpose, Practices it upholds, commands, and the ad-hoc actions it replaces. | `tool: publish`, replaces raw `git push` to main. |
| Evidence | An event the runner writes about a guardrail: fired, resolved, disputed, escaped, hollow, tampered, cost. | `fired no-suppressions src/a.ts fail`. |

A Practice may declare `conflictsWith: [<practice id>]`, for example
`rxjs-declarative` and `signals`.

Guardrail `kind` is one of `lint`, `type`, `model`, `runtime`, `review`, or
`instruction`. `runs` lists where it runs: `edit` (agent harness), `commit`
(git hook), and `boundary` (the final check, see
[Open decisions](#open-decisions)).

### Example record

```yaml
id: no-suppressions
pack: core
statement: Code never disables a Guardrail inline.
terms: [guardrail]
guardrails:
  - id: eslint-no-inline-config
    kind: lint
    runs: [edit, commit, boundary]
    implementation: eslint:warden/no-inline-config
    mustFail: fixtures/disable-comment.ts
    mustPass: fixtures/clean.ts
```

## Structure: folders and documentation

With comments banned, documentation needs one home that anyone can find
without searching. Unit records give every system that home, and they drive
both folder structure and documentation structure.

**The lookup rule.** Every Unit has exactly one document, at a path derived
from the Unit: `<unit folder>/<DOC_NAME>.md`, where the document name is fixed
per Unit kind (for example `CONTRACT.md`). Nothing else documents that Unit.

- `warden where <term | unit | path>` prints the owning Unit and its document.
  A path resolves to the nearest enclosing Unit.
- To find whether a document exists for something, run `warden where`. The
  answer is always one document or "no Unit", never a search result.

**Guardrails in the `core` pack's structure Practices:**

- Every folder belongs to exactly one Unit. No orphan folders, no overlap.
- Every Unit kind declares its allowed folder layout; other files or folders
  in it fail.
- Every Unit has its document, and the document has the sections its kind
  requires, in order (for a contract: Purpose, Owns, Interfaces, Invariants).
- No document exists outside a Unit, except the fixed root set (`README.md`,
  `AGENTS.md`).
- A Term is defined once, in its Term record. Documents link to Terms; a
  document that restates a definition fails.
- Every symbol a Unit exports from its public entry is listed in the
  Interfaces section of its document. This replaces JSDoc.
- Every link in a document resolves.

`warden new unit` scaffolds the folder, the document with its required
sections, and the Unit record together.

## Capabilities: skills and tools

Agents break rules most often by building their own way to do something the
environment already does. Capability records list everything an agent may use,
so the compliant way is always the obvious one.

A Capability is a **tool** (a CLI command with tests) or a **skill** (agent
instructions that say when and how to use tools). Each record holds its id,
the purpose it serves (written in Terms), the Practices it upholds, its
commands, and what ad-hoc actions it replaces.

- **Logic lives in tools; skills stay thin.** A skill names tools and the
  order to use them. Anything repeatable is a tested CLI command, not prose.
- **One Capability per purpose.** Two Capabilities whose purposes overlap
  fail compilation. This is single source of truth for functionality.
- **Skills are generated.** Warden emits skill files from Capability records
  into each harness's skill folder (Claude Code and Codex) and hash-locks them
  like any other generated file.
- **Skills are tested.** Each skill has a scenario and an expected outcome,
  the equivalent of a Guardrail's must-pass example, run by `warden check
  --rule <skill>` in the `boundary` tier.
- **Ad-hoc replacements are denied.** A Capability declares the actions it
  replaces (for example a raw `git push` to the main branch, replaced by the
  project's publish command). Warden emits harness deny rules for them, and a
  blocked attempt is recorded as `tampered` Evidence.
- **No unregistered tools.** A new script or CLI command that no Capability
  record covers fails the structure Guardrails.
- `warden where <purpose>` answers "is there already a way to do this?" with
  the one Capability, or "none".
- `warden new skill` and `warden new tool` scaffold the record, the files, and
  the test together.

## Principles pack

Core engineering principles are Practices in a generic `principles` pack, so
they are enforced the same way as everything else. Many principles are only
partly measurable. Each one lists the deterministic proxies Warden checks and
marks the rest as `review` kind, so the report shows honestly how well each
principle is protected.

| Principle | Deterministic guardrails | Left to review |
|---|---|---|
| Single source of truth | Terms defined once; one document per Unit; generated files hash-locked; duplicate type, constant, and schema detection | duplicated knowledge in different shapes |
| DRY | code-clone detection above a size threshold | conceptual duplication |
| YAGNI | no unused exports, parameters, files, or settings; no interface with a single implementation; no config value that is never varied | speculative design |
| KISS | limits on cyclomatic complexity, nesting depth, and function length | needless cleverness |
| Single responsibility | limits on file length and on a Unit's import fan-out | mixed concerns |
| Open/closed | variants register with a registry; no `switch` or `if` chain over a kind outside its registry | extension points that are not needed |
| Liskov substitution | no `extends` except declared framework bases (also enforces composition over inheritance) | behavioral contracts of implementations |
| Interface segregation | limit on members per interface; no interface member unused by every consumer | role design |
| Dependency inversion and layering | import-direction rules: inner layers never import outer ones; Units import each other only through their public entry | choice of abstraction |
| Separation of concerns | Unit boundaries and folder layouts above | |
| Fail fast, explicit errors | no empty `catch`; no unhandled promise; no `catch` that only logs; no non-null assertion | silent fallbacks that hide failures |
| Immutability and declarative style | `prefer-const`; no parameter reassignment; no mutating array methods in declared declarative paths | |
| Least astonishment | names use Terms; banned synonyms fail | naming quality |
| Explicit dependencies | no mutable module-level state; no implicit globals | |
| Every behavior is tested | every behavior record has a test that cites it | test strength (the `hollow` mutation signal helps) |
| Boy Scout rule | the ratchet: a baseline only shrinks | |

Proxies such as length or complexity limits are settings, and baselined like
everything else.

## Collection-folders pack

An optional pack for repositories that follow Ryan's collection-folder
convention. Ryan's description (November 18, 2026): folders are laid out like
a JSON object. A collection folder is an array: it holds one type of thing,
only directories, no loose files. Any other directory is an object: it holds
files or folders. Collections nest like JSON, except that a collection never
directly contains another collection. Ryan noted some deviations exist.

Context Manager marks a collection with a bracketed name (`[services]`,
`[components]`, `[models]`), as `docs/architecture/file-structure.md` states.

| Practice | Guardrail (adapter `fs`) |
|---|---|
| A collection holds only directories. | Fails on a file directly inside a bracketed directory. |
| A collection never directly contains a collection. | Fails on `[a]/[b]`. |
| A collection's items are one type. | Every child of a collection has the item layout its collection declares (required files and folders), checked like a Unit kind's layout. |
| Collection names follow one form. | Lowercase, kebab-case, plural, in brackets. |

Measured in Context Manager on November 18, 2026: 173 tracked files sit
directly inside a bracketed directory (38 under the root `[models]`), and one
collection directly nests another (`[primitives]/[utils]`). The ratchet
baselines these. Open question for Ryan: whether a collection may hold
single-file items, as `[models]` does today, which is one of the deviations.

The `fs` adapter is a new adapter: it emits nothing and runs over the
directory tree.

## Layers

Packs stack. A consuming project lists the packs it uses and the paths each
one covers.

```
project pack           context-manager: plugin boundaries, CANON invariants
style packs            rxjs-declarative, signals, declarative-ui (per path scope)
language packs         typescript
core pack              no comments, no suppressions, configuration only tightens,
                       every Practice has a Guardrail, generated output matches source
```

Precedence rule: a higher pack may add Practices or narrow a lower Practice's
scope exceptions. It can never remove or disable a lower Practice. The
compiler rejects any attempt.

## The compiler

`warden compile` runs four steps and stops at the first failure.

1. **Validate.** Every record matches the JSON Schema.
2. **Check consistency.**
   - Every Term and Practice is defined exactly once.
   - Every Practice has at least one Guardrail whose `kind` is not
     `instruction`. A Practice enforced only by prose fails.
   - Every Guardrail has a must-fail example that fails and a must-pass
     example that passes.
   - Every must-pass example passes every other Guardrail enabled on its path.
     This catches two rules that demand opposite things.
   - Conflicting Practices never cover the same path.
   - No higher pack loosens a lower pack.
   - Practice statements use only defined Terms, and no banned synonym.
3. **Emit.** It writes the native configurations: `eslint.config.js`,
   `tsconfig` strictness flags, Claude Code permission deny rules, Codex
   configuration, git hooks, and the coverage report. Each generated file
   carries a header naming its source and a content hash.
4. **Lock.** It records the hash of every generated file and every source
   record in `.warden/lock.json`.

`warden check` fails when any generated file differs from its locked hash, so a
hand edit to `eslint.config.js` surfaces as drift instead of taking effect.

## Adapters: how records reach real tools

Records never run anything themselves. Each real tool is reached through one
adapter, and every adapter has the same three jobs:

| Job | Signature | Example for ESLint |
|---|---|---|
| Emit | Guardrails to the tool's native configuration | a flat config enabling `warden/no-comments` as `error` on the Practice's paths |
| Run | Guardrails and files to the tool's raw output | one `ESLint` instance, inline config off |
| Normalize | raw output to Warden Violations (`guardrail`, `file`, `line`, `message`) | ESLint messages split by rule id |

A Guardrail's `implementation` names its adapter and the tool's own rule:
`eslint:no-debugger`, `eslint:warden/no-comments`, `tsc:strictNullChecks`,
`cmd:npm run check:canon`. An `options` field passes the tool's rule options
through unchanged. In a `cmd` command, `{pack}` stands for the folder of the
Guardrail's pack, so a pack can ship a script and run it as
`cmd:node {pack}/check.js`; failures, next actions, and `warden doctor` show
the command with `{pack}` resolved, and every file in a local pack's folder but `.DS_Store` is
hashed into the lock. A `cmd` Guardrail reports one project-wide result, so
compile refuses one whose kind is `lint`; moving such a Guardrail from `lint`
to `runtime` is not weakening, since its `lint` result never failed. Because every adapter normalizes to the same Violation, the
baseline, cache, budgets, Evidence, and report work the same for every tool.

| Adapter | Emits | Runs |
|---|---|---|
| `eslint` | `.warden/generated/eslint.config.mjs` | ESLint API |
| `tsc` | `.warden/generated/tsconfig.json`, extending the project's own and adding flags | `tsc --noEmit -p`, diagnostics parsed per file |
| `cmd` | nothing | a shell command; exit status is the verdict |
| `claude-settings` | `permissions.deny` entries | nothing; it is a harness control |
| later: `codex-config`, `git-hooks`, `skills`, `tla` | | |

Adding a tool means adding one adapter. Each adapter passes a conformance
test: given a fixture with known violations, it emits configuration, runs, and
normalizes to exactly the expected Violations.

## Building Warden with Warden

Warden checks its own repository from the first task that can. To stop a
change to the checker from approving itself, the repository is checked by the
previous tagged release, not by its own working copy, the way a compiler is
built by its previous version. A new release becomes the checker only after it
passes under the old one.

## The CLI

| Command | Does |
|---|---|
| `warden init` | Creates `.warden/` in a project with a config that lists `core`. |
| `warden new term\|practice\|guardrail\|pack` | Scaffolds a record and, for a Guardrail, its two examples. |
| `warden compile` | Validates, checks, emits, and locks. |
| `warden check [<path>] [--rule <id>]` | Runs enabled Guardrails on changed paths, one path, or one rule. |
| `warden explain <id>` | Prints a Practice's statement, Terms, Guardrails, and evidence. |
| `warden dispute <guardrail> <path>` | Files a structured objection instead of a workaround. |
| `warden fix [<path>]` | Applies the fixers that Guardrails ship. |
| `warden review` | Turns evidence into proposals to add, edit, or remove. |
| `warden report` | Prints the coverage and confidence report. |

The CLI is TypeScript on Node and uses `commander`. Exit status is the only
pass or fail signal; output names the Practice, the path, and the fix.

## Speed

Validation must be fast enough that agents run it on every change and never
learn to avoid it.

- **Every Guardrail declares a time budget**, and every tier has a total
  budget: `edit` (per tool call), `commit`, and `boundary`. Budgets are
  settings in `config.yaml`; the values are Ryan's to tune.
- **The runner times every run** and records it as `cost` Evidence.
- **Over budget is a framework defect.** A Guardrail that finishes over its
  budget keeps its result: its violations count, and the run records the
  overrun as a Warden defect without failing. A command that does not finish
  is stopped at its budget and fails the run. Tier budgets are report-only:
  `warden report` compares each tier's run times with its budget. Raising a
  budget counts as loosening and needs Ryan's signature; the fix is to make
  the Guardrail faster or move it to a later tier.
- **Admission check.** `warden compile` runs each Guardrail on its examples
  and rejects one whose run exceeds its budget.
- **Only changed paths.** `edit` and `commit` run on changed files only.
- **One parse per file.** All `lint` Guardrails run in a single ESLint pass,
  so each file is parsed once.
- **Content-hash cache.** A result is keyed by file hash plus Guardrail
  version. Rerunning on unchanged input returns the cached result at once.
- **Heavy kinds run late.** `model` and repository-wide `legacy` Guardrails
  run only at `boundary` unless their measured cost fits an earlier tier.
- **Capped parallelism.** Guardrails run in parallel with at most two
  workers, matching the machine's shared-compute rule.
- **Loop breaker.** When the same Guardrail fails on the same path and
  content repeatedly, the runner stops retrying and tells the agent to fix the
  code or file `warden dispute`. The repeat count is a setting.
- **The report shows speed.** Median and slowest run per Guardrail, and the
  total per tier against its budget.

## Adopting Warden in an existing repository

Existing repositories fail many Guardrails on day one. Warden ratchets every
Guardrail, not only the comment ban, so adoption never blocks work.

- **Baseline at adoption.** `warden init` records every existing violation per
  Guardrail per file in `.warden/baseline.json`.
- **Only new violations fail.** A run fails on a violation that is not in the
  baseline. Unchanged files are skipped by the content-hash cache.
- **The baseline only shrinks.** When a violation is fixed, `warden check`
  removes it from the baseline automatically. Adding an entry is a loosening
  and needs Ryan's signature.
- **A new Guardrail baselines too.** Adding a Guardrail to an existing pack
  records its current violations, so tightening never stops in-flight work.
- **The report shows the burn-down:** remaining baseline entries per
  Guardrail, over time.

## When an agent hits a Guardrail

A failing Guardrail is never a reason to stop. Warden is built so the agent's
cheapest path is the compliant one.

- **Every failure shows the right way.** The message names the Practice and
  shows its must-pass example, which is the compliant pattern by definition.
  `warden explain` adds the full record.
- **Autofix where possible.** A Guardrail may ship a fixer (for example an
  ESLint fixer). `warden fix <path>` applies them.
- **"Blocked" is not an exit.** An agent may stop on a Guardrail only by filing
  `warden dispute` with the approaches it tried. Filing a dispute does not
  pass the check; the agent keeps working on a compliant approach while the
  dispute waits.
- **Disputes are ruled quickly.** An independent reviewer rules a dispute
  that would keep or tighten the rule. Only a ruling that loosens the rule
  waits for Ryan.
- **Stalls are evidence.** A session that ends with a failing Guardrail, no
  fix, and no dispute is recorded as `stalled`, so `warden review` can find
  rules whose message or example fails to teach the right way.
- **The agent skill says it plainly:** fix the code, never the check; the
  compliant pattern is in the failure message.

### From tool output to feedback

Adapters normalize every tool's output to Violations; one formatter turns
Violations into feedback, so every tool speaks the same way:

```
FAIL src/a.ts:12  no-comments
  Rule:     Code carries no comments; documentation lives in the Unit's document.
  Do this:  <the Practice's must-pass example, inline>
  Fix:      warden fix src/a.ts           (when a fixer exists)
  Why:      warden explain no-comments
Next action: change the code at the lines above to match "Do this".
```

- Every run ends with exactly one `Next action:` line. Feedback never says
  "blocked" or "cannot proceed".
- After repeated identical failures, the next action becomes "rewrite to
  follow the example, or file `warden dispute` with what you tried", and
  stopping without either is recorded as `stalled`.
- **Feedback arrives at the edit, not at the end.** Warden registers a Claude
  Code `PostToolUse` hook, so each edit is checked right away and a failure is
  handed back to the agent as the hook's reason. The agent fixes one small
  thing immediately instead of meeting a wall of failures at commit time.
- `--format json` gives the same fields for tools and dashboards.

## Closing the bypasses

| Bypass | Cover |
|---|---|
| `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `.skip`, `.only` | Core Practice `no-comments` makes all comments a lint error, and ESLint runs with `noInlineConfig`. `no-skipped-tests` covers `.skip` and `.only`. |
| Editing `eslint.config.js`, `tsconfig`, ignore files, hooks | They are generated. Drift fails `warden check`. Known limit: the generated `.warden/generated/tsconfig.json` extends the project's own `tsconfig.json`, which is not generated or hashed, so narrowing its `include` or `exclude` changes what every `tsc` Guardrail checks without any drift. Decide how to guard it before the first `tsc` Guardrail is adopted. |
| Editing a rule record to loosen it | Records live in the framework source. A change to the source needs a commit signed by Ryan's key, which agents cannot use. |
| `--no-verify`, skipping hooks | Local hooks are early warnings only. The boundary check is authoritative. |
| Claiming work is done | "Done" is a predicate the runner executes. Reports are generated from Evidence, never written by the agent. |
| Writing a protected file through a shell command | The harness deny rules block the common paths; drift detection catches the rest at the boundary. |

### The comment ban

Comments are banned because they give an agent a place to justify not doing
the right thing. The legitimate outlet is `warden dispute`, which Ryan or a
reviewer rules on. Two existing conflicts:

- Context Manager has about 90,000 comment lines across 5,516 TypeScript
  files (measured November 18, 2026).
- Ryan's global `AGENTS.md` requires `ponytail:` comments that name a
  simplification's ceiling. That rule moves into Warden as a record type or is
  retired; it cannot remain a comment.

## The learning layer

The runner, never the agent, appends Evidence to `~/.warden/evidence/<project>.jsonl`.

| Signal | Source | Meaning |
|---|---|---|
| fired | every run | how often and where a Guardrail triggers |
| resolved | a failure followed by a passing code change with no Guardrail change | caught something real |
| disputed | `warden dispute` | possible false positive; Ryan or a reviewer rules |
| escaped | a later bug, revert, or review finding linked to a Practice | false negative |
| hollow | mutation of the must-fail example that the Guardrail misses | the Guardrail checks less than it claims |
| tampered | lock drift, blocked writes, deny-rule hits | an attempted bypass |
| cost | run time | a slow Guardrail is a defect |

Confidence per Guardrail: precision (resolved against upheld disputes),
coverage (escapes against its Practice), and strength (mutation score).

`warden review` writes proposal records:

- **Add** on an escape, or on a review finding that recurs in the judgment
  layer. Judgment findings ratchet down into static Guardrails.
- **Edit** on upheld disputes or a hollow mutation score.
- **Remove** when a Guardrail never fires, its area has no escapes, and
  another Guardrail covers its Practice.

An independent reviewer may accept a proposal that tightens. A proposal that
loosens or removes needs Ryan's signature. Thresholds are settings, not
constants.

## Packaging

Warden lives in its own repository, `~/Code/warden`, under Ryan's personal
GitHub identity.

```
warden/
  cli/             the commands above
  schema/          JSON Schema for the seven records
  compiler/        validate, consistency checks, emitters, lock
  emitters/        eslint, tsconfig, claude-settings, codex-config, git-hooks, skills, report
  packs/           core, principles, typescript, rxjs-declarative, signals, declarative-ui
  rules/           eslint-plugin-warden and other guardrail implementations
  skill/           Warden's own skill: the CLI, `warden where`, and the dispute path
```

A consuming project pins an exact version as a dev dependency installed from a
git tag, and keeps everything Warden-related in one folder:

```
.warden/
  config.yaml      packs, path scopes, pinned version
  packs/<project>/ the project's own pack
  lock.json        hashes of sources and generated files
                   (evidence lives in ~/.warden/evidence/<project>.jsonl)
```

Generated files sit where their tools expect them (`eslint.config.js` at the
root) and carry the Warden header.

## Applying it to Context Manager

1. **Inventory.** Register every existing `check:*` script and custom lint as
   a Guardrail record with its kind and strength, pointing at the script as
   its implementation. This produces the first coverage report.
2. **Practices from CANON.** Each of CANON's numbered invariants becomes a Practice
   in the `context-manager` pack that cites its invariant number. The ones
   marked "No gate yet" fail compilation until they get a Guardrail or are
   explicitly marked `review` kind.
3. **Terms.** CANON's Concept Ledger and `docs/glossary.md` vocabularies become
   Terms.
4. **Units.** The system map (`docs/plans/migration/system-map.md`) already
   assigns every unit its home, and each unit has a `CONTRACT.md`. Each becomes
   a Unit record whose document is its `CONTRACT.md`.
5. **Core pack on.** `no-suppressions`, `config-only-tightens`, and
   `generated-matches-source` first; `no-comments` per the open decision.

## First slice (walking skeleton)

- Repository, schema, compiler with validate, consistency, emit, and lock.
- Core pack with three Guardrails: `no-suppressions`,
  `config-only-tightens`, `generated-matches-source`.
- Emitters for ESLint and Claude Code deny rules.
- `warden check`, `warden explain`, `warden report`.
- Context Manager's inventory step.

The learning layer, style packs, model and runtime kinds, and the remaining
emitters follow.

## Builder-check answers

An independent builder read this design and asked six questions. Answers:

1. **Generated configuration composes; it does not replace.** Warden runs its
   own ESLint pass with only its generated config and `--no-inline-config`,
   independent of the project's hand-written `eslint.config.js`. An agent
   that edits the project config cannot weaken Warden's pass. Project rules
   migrate into records over time. Claude Code deny rules are emitted into the
   `permissions.deny` list only, and the drift check covers that key.
2. **Everything under `.warden/` is framework source.** A commit that changes
   `.warden/` must be signed by a key in an allowed-signers list that ships
   inside the pinned Warden package, not in the consuming repo.
   `warden check` verifies this with git's signature verification. Warden
   covers `.warden/` only; the existing `Ryan-Approved:` and protected-paths
   mechanism keeps the files it covers until they migrate.
3. **Existing scripts register as `legacy` Guardrails.** A `legacy` Guardrail
   carries runnable `mustFail` and `mustPass` examples like every other
   Guardrail, so compile proves it. The report lists each `legacy` Guardrail,
   so the gap stays visible, and a `legacy` Guardrail cannot be added after
   the inventory.
4. **`config-only-tightens` is checked both ways.** At compile time across
   packs, and at check time against the lock on the base branch, so a change
   cannot loosen what `main` already enforces.
5. **Comment reach (Ryan, November 18, 2026: "Allowlist; ratchet existing").**
   Every comment is banned except a fixed allowlist of machine directives that
   tools require: `/// <reference>`, `@vitest-environment`, and Warden's
   `@generated` header. JSDoc and license headers are banned. Existing
   comments ratchet out: a line added or changed against the base branch may
   not contain a comment, and a file's comment count may never rise. Agents
   do not strip comments in bulk.
6. **Evidence lives per machine, outside worktrees:**
   `~/.warden/evidence/<project>.jsonl`, so it survives deleted worktrees.
   Merging evidence across machines waits for the boundary decision.

## Open decisions

1. **Boundary.** Where the authoritative check runs. Options: a GitHub
   required check (needs pull requests and GitHub-run checks in this repo), or
   a separate macOS user for agents. Ryan rejected a Proxmox server. Until
   decided, Evidence and the lock are tamper-evident, not tamper-proof.
2. **Signing key.** Which key signs framework changes, held where agents
   cannot use it.

## Calls made in this design (Ryan to check)

- Name `warden` and CLI `warden`, chosen to avoid the repo's existing
  `branchGuard`, `lockGuard`, and `scopeGuard`.
- YAML records with a JSON Schema; TypeScript CLI on `commander`.
- No warnings, only errors.
- Install from a git tag rather than publishing to npm.
- Evidence log not committed to git, to avoid merge conflicts between parallel
  sessions.
