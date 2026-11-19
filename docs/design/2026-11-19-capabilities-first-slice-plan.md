# Capabilities, first slice: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the change review that builds Warden through Warden: a
Capability record compiles to a generated skill, the pre-review gate is a
Warden Guardrail, one review adapter turns a normalized review rule into the
reviewer's full invocation and its report back into findings, and one triage
step routes every finding by kind.

**Architecture:** Capability records join Terms and Practices in pack YAML.
Compile emits one `SKILL.md` per skill Capability into `.warden/generated/`,
and the lock covers it. The gate becomes a `cmd` Guardrail in a new bundled
`review` pack. A review adapter is a new, narrow interface: Warden never
launches an agent, so the adapter produces the Agent tool input and parses
the returned report. `warden review triage` classifies the findings and
prints one next action.

**Tech Stack:** TypeScript on Node 25, `commander` 12, `ajv` 8, `yaml` 2,
vitest 4. No new dependency.

**Spec:** [`2026-11-18-warden-guardrail-framework-design.md`](2026-11-18-warden-guardrail-framework-design.md),
section "Capabilities: skills and tools", approved by Ryan on November 18,
2026. Bead `cm-wkqedr.4` and its notes (Ryan, November 19, 2026). Source
process: `context-manager/.superpowers/sdd/2026-11-18-warden-first-slice/`
`review-triage.md`, `builder-checklist.md`, and `pre-review-gate.sh`.

## Rulings for Ryan to check

Each one is repeated where it applies, marked "Ruling".

1. Capabilities live in pack YAML as a `capabilities:` list, so the lock, signing, and layering cover them with no new mechanism.
2. "One Capability per purpose" is measured by a required `serves: <Term id>`. Two Capabilities that serve the same Term fail compilation.
3. Skills are generated into `.warden/generated/skills/<id>/SKILL.md`. Claude Code reaches them through a `.claude/skills/<id>` symbolic link that `warden doctor` checks, since Warden writes only `.warden/`. Codex skills wait.
4. A generated Markdown file carries its header as a `generated:` front-matter key, so `SKILL.md` stays a valid skill.
5. Every Capability command is a `warden` subcommand, and compile refuses one whose `--help` does not exit 0. This is the slice's check that logic lives in tools.
6. The gate is a `cmd` Guardrail, kind `runtime`, runs `[boundary]`, in a new bundled `review` pack. It runs as `exec node "$WARDEN_PACK_DIR/gate.js"`, so it takes the shell path and its budget kills the whole process tree.
7. The gate stops at its first failing step, so each run has exactly one failure and one next action.
8. The gate measures the working tree against the base: tracked changes plus untracked files that are not ignored. The `tests` setting picks the test files.
9. The `cmd` adapter exports `WARDEN_BASE` and `WARDEN_SETTINGS` to every command. `RunContext` gains `base` and `settingsOf`.
10. Compile's example project becomes a git repository with one commit, and examples run with `base` set to that commit.
11. Baseline measurement skips `cmd` Guardrails. Their results are project-wide, have no file, and were never baselined, so running them only cost time.
12. The gate's `budgetMs` is 120000, equal to Warden's own boundary tier budget.
13. "New tests fail on base" is judged per run: when the copied tests all pass on the base, the gate fails.
14. A review adapter is its own interface, `invocation` and `normalize`, not the Guardrail `Adapter`. Warden cannot run an agent; the controller dispatches it.
15. The outbound invocation is the exact Agent tool input: `description`, `subagent_type`, `model`, and `prompt`.
16. The brief fixes the report shape, and `normalize` parses that shape. A report without a verdict, or one for a different head, normalizes to one `env` finding.
17. Kinds are assigned in a fixed order: env, flake, unfixed, spec-unmet, pre-existing, regression, touched, untouched.
18. A finding with no location blocks as `touched`, since triage cannot prove it is outside the change.
19. Triage exits 2 for env or flake findings (operational), 1 for a blocking finding, and 0 otherwise. Its one next action follows the same order.
20. Warden stays stateless for review. It reads the report and the previous round's triage JSON, and writes nothing. The controller keeps the files.
21. Finding kinds and actions are string unions, matching `Kind` in `src/records/types.ts`.
22. The `review` pack is not enabled in Warden's own `.warden/config.yaml` in this slice. The previous release checks this repository and does not know the pack, so enabling it waits for the release that ships it.

## Deferred, and why

- **Harness deny rules for `replaces`.** The field is recorded and rendered in the skill. The change review replaces a process step, not a shell command a deny rule can match.
- **Skill scenario tests.** A scenario needs an agent run. Ruling 5's command check is the slice's proxy.
- **Codex skill output.** One harness proves the path. Codex follows with its own folder and test.
- **Other review adapters:** ponytail-review, ui-qa, component-quality, and code-review. Each is one more adapter that passes the same conformance harness from Task 5.
- **Kinds that need round history:** "reviewer is wrong", "same kind recurs in two rounds", and "round 4 on one unit". Each needs records across rounds, and Ruling 20 keeps Warden stateless in this slice.
- **`warden where <purpose>`, `warden new skill|tool`, and the "no unregistered tools" structure Guardrail.** They need the Unit and structure records, which do not exist yet.
- **Review Evidence.** Findings could feed the learning layer later. Nothing reads them yet.

## Global Constraints

- Exit codes: 0 pass, 1 violation, 2 usage or environment.
- Every failure ends in exactly one `Next action:`, and a test runs that action and proves it clears the failure.
- No source comments, in `src/`, `test/`, and pack scripts.
- Tests: `S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run <files> --maxWorkers=2`, affected files only.
- Never raise a timeout, a budget, or a bench setting.
- Warden writes only its own `.warden/` folder in a project. The gate's scratch worktree lives in the OS temporary folder and is removed on every exit path.
- No new dependency.

### Builder checklist

Copied from `builder-checklist.md`. Check every item before you report a task.

1. Every next action the code prints is executed by a test, and the test proves it clears the failure.
2. Every alert or refusal has a tested way to clear for each thing that can hold it open.
3. Environment and usage failures exit 2 with a working next action. They are never a stack trace and never exit 1.
4. No message is matched by its English text. Match exit codes or structured output.
5. Rebuild dist (`npm run build:dist`) before you run any hook or CLI test. Committed dist must match a fresh build.
6. Each new test fails on the base commit. Record the command and the output.
7. No raised timeout, no loosened bench setting, no source comments.
8. Lists of Guardrails, packs, or Capabilities come from the loaded records, never a hand-written list.

### Per-task closing steps

Every task ends with these, after its own steps:

- `npx tsc --noEmit` exits 0.
- `npx eslint <changed files>` exits 0.
- `npm run build:dist`, then stage `dist/` with the source.
- Commit with subject `<what is true now> (cm-wkqedr.4)`. Never `--no-verify`.

## Review Focus

The inputs no task's main tests cover that are most likely to bite. Each has
its test in the named task.

1. **A base ref that does not exist, or a shallow clone without it.** The gate exits 2 with `Next action: run git fetch origin <base>, then …`. Task 7, `gate exits 2 when the base is not a commit`.
2. **A gate run killed at its budget leaves a registered scratch worktree.** The next run removes worktrees named `warden-gate-<pid>-*` whose process is gone, and succeeds. Task 7, `a gate killed mid-run leaves no worktree after the next run`.
3. **Test file names with spaces or quotes.** The gate passes them as argv, never through a shell. Task 7, `test files with spaces and quotes reach the test command intact`.
4. **The base worktree's `node_modules` link.** Removing the worktree never deletes the project's `node_modules`. Task 7, `the project node_modules survives the base run`.
5. **A report with CRLF line endings, extra prose, or a finding without `Where:`.** It parses, and the unlocated finding blocks. Task 5, `CRLF and surrounding prose parse the same` and Task 4, `a finding with no location blocks as touched`.

---

### Task 1: Capability records load and are checked for consistency

**Files:**
- Modify: `schema/records.schema.json` (add `$defs/capability`; add optional `capabilities` to `$defs/pack`)
- Modify: `src/records/types.ts`
- Modify: `src/compiler/consistency.ts`
- Test: `test/records/load.test.ts`, `test/compiler/consistency.test.ts`

**Interfaces:**
- Produces, in `src/records/types.ts`:

```ts
export interface ReviewRule { adapter: string; model: string }
export interface Capability {
  id: string;
  kind: "skill" | "tool";
  serves: string;
  purpose: string;
  when: string;
  upholds: string[];
  commands: string[];
  replaces: string[];
  review?: ReviewRule;
  pack: string;
}
```

  `Pack` gains `capabilities: Capability[]`; `readPack` defaults it to `[]`
  and sets each `pack` field, as it does for Practices.
- Produces consistency codes `duplicate-capability`, `same-purpose`,
  `undefined-upheld`, `undefined-serves`, placed after `banned-synonym` in `CODES`.

Schema: `capability` requires every field above except `review` and `pack`;
`additionalProperties: false`; `commands` has `minItems: 1`; `review`
requires `adapter` and `model`.

Ruling 1: Capabilities live in pack YAML. Ruling 2: purpose overlap is two
Capabilities with the same `serves` Term.

- [ ] **Step 1: Write the failing tests**

In `test/records/load.test.ts`:
- `loads a pack's capabilities with their pack id`: a local pack with one
  Capability loads, and `set.packs[0].capabilities[0]` equals the record plus `pack: "<id>"`.
- `a pack without capabilities loads them as an empty list`.
- `a capability with an unknown field is refused with its pointer`: `RecordError.pointer` is `/capabilities/0/extra`.

In `test/compiler/consistency.test.ts`:
- `two capabilities with one id fail as duplicate-capability`.
- `two capabilities that serve one Term fail as same-purpose`: the finding's
  `record` is the second id and its message ends with `Next action: merge
  <second> into <first> in <file>, then run warden compile.`
- `a capability that upholds an undefined Practice fails as undefined-upheld`.
- `a capability that serves an undefined Term fails as undefined-serves`.

Each test asserts `code` and `record`, never message prose, except the one
next-action string named above.

- [ ] **Step 2: Run the tests and see them fail**

Run: `S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run test/records/load.test.ts test/compiler/consistency.test.ts --maxWorkers=2`
Expected: the seven new tests FAIL; existing tests pass.

- [ ] **Step 3: Implement the schema, the types, the `readPack` default, and the four checks in `checkConsistency(set: RecordSet): Finding[]`**

Each new finding ends in one `Next action:` that names the file and ends
with `then run warden compile.`

- [ ] **Step 4: Run the tests and see them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Run the closing steps and commit**

`Capability records load from packs, and compile refuses duplicate ids, shared purposes, and undefined Practices or Terms (cm-wkqedr.4)`

---

### Task 2: Compile emits a locked skill for each skill Capability

**Files:**
- Create: `src/compiler/skills.ts`
- Modify: `src/compiler/emit.ts` (`stamp` gains a `.md` branch)
- Modify: `src/compiler/compile.ts` (`expectedOutputs` adds skills; `compile` runs the command check)
- Modify: `src/runner/doctor.ts` (one item per skill Capability)
- Test: `test/compiler/skills.test.ts`, `test/runner/doctor.test.ts`, `test/runner/tamper.test.ts`

**Interfaces:**
- Consumes: `Capability`, `Pack.capabilities` (Task 1).
- Produces, in `src/compiler/skills.ts`:

```ts
export const SKILLS_DIR = ".warden/generated/skills";
export const skillPath = (id: string): string => `${SKILLS_DIR}/${id}/SKILL.md`;
export function emitSkills(set: RecordSet): Record<string, string>;
export async function checkCommands(set: RecordSet, wardenRoot: string): Promise<Finding[]>;
```

`emitSkills` writes one file per `kind: skill` Capability, in this layout:

```markdown
---
name: <id>
description: <purpose> Use when <when>.
---
# <id>

<purpose>

## Upholds

- <practice id>: <statement>

## Steps

1. `<command 1>`
2. `<command 2>`

## Use this instead of

- <replaces item>

When a step fails, do its printed Next action, then run the step again. Fix the code, never the check.
```

The `## Use this instead of` section is omitted when `replaces` is empty.

Ruling 3: skills go to `.warden/generated/skills/<id>/SKILL.md`, and Claude
Code reaches them through a `.claude/skills/<id>` link that `warden doctor`
checks. Ruling 4: `stamp` puts the header in front matter, as the line
`generated: '<header>'` right after the opening `---`. A `.md` file that does
not start with `---\n` throws, as other unstampable files do.

Ruling 5: `checkCommands` runs `process.execPath <wardenRoot>/bin/warden.js
<words> --help` for each command, where `<words>` are the words after
`warden` up to the first word that starts with `-` or `<`. It returns
`unknown-command` for a command that does not start with `warden ` or whose
`--help` exits non-zero. `compile` runs it after `runExamples` and returns
its findings the same way.

Doctor item `skill <id>`: passes when `realpath(.claude/skills/<id>)` equals
`realpath(.warden/generated/skills/<id>)`. Otherwise its fix is
`run mkdir -p .claude/skills && ln -s ../../.warden/generated/skills/<id> .claude/skills/<id>`.

- [ ] **Step 1: Write the failing tests**

In `test/compiler/skills.test.ts`:
- `a skill capability compiles to SKILL.md with every upheld statement and every command in order`: compile a fixture project with one local pack; read `skillPath(id)`; assert the front matter `name`, the `generated` key, the statements, and the numbered commands.
- `a tool capability emits no skill`.
- `the skill is in the lock, and a hand edit is generated-drift`: `lock.generated[skillPath(id)]` exists; after editing the file, `findTamper` reports `{ file: skillPath(id), detail: "generated-drift" }`, and running `warden compile` (the printed next action) clears it.
- `a command that is not a warden subcommand fails as unknown-command`: commands `git push` and `warden nosuch` each give one finding; `warden check --rule x` gives none.

In `test/runner/doctor.test.ts`:
- `a skill without its .claude link fails doctor, and the printed command clears it`: doctor's `next` holds the `ln -s` command; run it with `sh -c` in the project; doctor then passes.

- [ ] **Step 2: Run the tests and see them fail**

Run: `S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run test/compiler/skills.test.ts test/runner/doctor.test.ts test/runner/tamper.test.ts --maxWorkers=2`
Expected: the five new tests FAIL.

- [ ] **Step 3: Implement `emitSkills`, the `.md` stamp, `checkCommands`, and the doctor item**

In `expectedOutputs`, merge `emitSkills(set)` into `emitted`; throw if a path collides, as `emitAll` does.

- [ ] **Step 4: Run the tests and see them pass**

Same command, after `npm run build:dist` (the command check runs `bin/warden.js`). Expected: PASS.

- [ ] **Step 5: Run the closing steps and commit**

`Compile emits a hash-locked SKILL.md for each skill Capability, refuses commands that are not warden subcommands, and doctor checks the .claude/skills link (cm-wkqedr.4)`

---

### Task 3: cmd Guardrails see the base and their pack settings

**Files:**
- Modify: `src/adapters/types.ts` (`RunContext`)
- Modify: `src/runner/run.ts` (`runGuardrails` fills `settingsOf`)
- Modify: `src/adapters/cmd.ts` (`runOne` exports two variables)
- Modify: `src/cli/check.ts:419` (the context carries `base`)
- Modify: `src/compiler/examples.ts` (`withExampleProject` makes a git repository; `runExamples` passes `base`)
- Modify: `src/runner/baseline.ts` (`measureBaseline` skips `cmd`)
- Test: `test/adapters/cmd.test.ts`, `test/compiler/examples.test.ts`, `test/compiler/compile.test.ts`

**Interfaces:**
- Produces, in `RunContext`: `base?: string` and
  `settingsOf?: (g: Guardrail) => Record<string, unknown> | undefined`.
- Produces, in `src/adapters/cmd.ts`: `export const BASE_VAR = "WARDEN_BASE";`
  and `export const SETTINGS_VAR = "WARDEN_SETTINGS";`. `WARDEN_BASE` is set
  only when `ctx.base` is set. `WARDEN_SETTINGS` is always set, to
  `JSON.stringify(ctx.settingsOf?.(g) ?? {})`.

Ruling 9: the variables go to every `cmd` command, in the shell and in the
worker-thread path. `runGuardrails` builds `settingsOf` from
`set.config.packs`, keyed by the pack that holds the Guardrail.

Ruling 10: `withExampleProject` runs `git init -q`, `git add -A`, and
`git -c user.name=warden -c user.email=warden@example.invalid -c commit.gpgsign=false commit -qm scaffold`
in the example project, and `runExamples` passes `base` as the resulting
commit id.

Ruling 11: `measureBaseline` drops Guardrails whose `prefixOf` is `cmd`
before it calls `runGuardrails`.

- [ ] **Step 1: Write the failing tests**

In `test/adapters/cmd.test.ts`:
- `a cmd command sees WARDEN_BASE and its pack settings as JSON`: implementation `cmd:test "$WARDEN_BASE" = abc && node -e 'process.exit(JSON.parse(process.env.WARDEN_SETTINGS).n === 2 ? 0 : 1)'`, run through `runGuardrails` with `base: "abc"` and pack settings `{ n: 2 }`; status is `pass`.
- `WARDEN_BASE is unset when the run has no base`.

In `test/compiler/examples.test.ts`:
- `examples run in a git repository whose base is its first commit`: a `cmd` Guardrail with implementation `cmd:git rev-parse --verify "$WARDEN_BASE" && test ! -e x.txt`, mustFail `{ "x.txt": "1" }`, and mustPass `{ "y.txt": "1" }`. Expected: `runExamples` returns `[]`. On the base commit, `WARDEN_BASE` is unset, so `rev-parse` fails on mustPass and the test fails.

In `test/compiler/compile.test.ts`:
- `adding a cmd Guardrail does not run it for the baseline`: add a Guardrail whose command appends to a marker file outside the project; after `compile`, the marker holds exactly the two example runs, not a third.

- [ ] **Step 2: Run the tests and see them fail**

Run: `S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run test/adapters/cmd.test.ts test/compiler/examples.test.ts test/compiler/compile.test.ts --maxWorkers=2`
Expected: the four new tests FAIL.

- [ ] **Step 3: Implement the context fields, the exports, the git example project, and the baseline filter**

- [ ] **Step 4: Run the tests and see them pass**

Same command. Expected: PASS, with every existing test in those files still passing.

- [ ] **Step 5: Run the closing steps and commit**

`cmd Guardrails see the check's base and their pack settings, examples run in a git repository, and the baseline no longer runs cmd Guardrails (cm-wkqedr.4)`

---

### Task 4: Review findings are classified by kind and triaged to one next action

**Files:**
- Create: `src/review/findings.ts`
- Test: `test/review/findings.test.ts`

**Interfaces:**
- Produces, in `src/review/findings.ts`:

```ts
export type Severity = "critical" | "important" | "minor" | "environment";
export type Reproduces = "head" | "base" | "previous";
export interface RawFinding {
  n: number;
  severity: Severity;
  title: string;
  file?: string;
  line?: number;
  reproducesOn: Reproduces[];
  spec: boolean;
  earlier?: number;
  flaky: boolean;
  correction: string;
}
export type FindingKind = "env" | "flake" | "unfixed" | "spec-unmet" | "pre-existing" | "regression" | "touched" | "untouched";
export type Action = "fix-environment" | "rerun-alone" | "back-to-builder" | "file-task";
export interface ReviewFinding extends RawFinding { kind: FindingKind; action: Action; blocks: boolean }
export type Touched = Record<string, [number, number][]>;
export interface Triage { verdict: "pass" | "fail" | "operational"; findings: ReviewFinding[]; next: string | null }
export function touchedLines(root: string, from: string, to: string): Touched;
export function classify(raw: RawFinding, touched: Touched, round: number): ReviewFinding;
export function triage(raws: RawFinding[], touched: Touched, round: number, rerun: string): Triage;
export const exitCode = (t: Triage): 0 | 1 | 2;
```

`touchedLines` reads `git diff -U0 --no-color <from> <to>` and the working
tree, and returns the new-side line ranges per file from each `@@` hunk.

Ruling 17, the order `classify` applies, first match wins:

| Test | Kind | Action | Blocks |
|---|---|---|---|
| `severity === "environment"` | env | fix-environment | no |
| `flaky` | flake | rerun-alone | no |
| `earlier !== undefined` | unfixed | back-to-builder | yes |
| `spec` | spec-unmet | back-to-builder | yes |
| `reproducesOn` includes `base` | pre-existing | file-task | no |
| located in `touched`, `round > 1`, not on `previous` | regression | back-to-builder | yes |
| located in `touched`, or no `file` (Ruling 18) | touched | back-to-builder | yes |
| otherwise | untouched | file-task | only when `critical` |

Ruling 19: `exitCode` is 2 when any finding is env or flake, else 1 when any
blocks, else 0. `next` follows the same order:
- env: `fix the environment named in finding <n>, then <rerun>.`
- flake: `rerun the test named in finding <n> alone; if it fails again, file a slow-test task, then <rerun>.`
- block: `send findings <n, n> back to the builder, then <rerun> on the new head.`
- file-task only: `file one task for each of findings <n, n>.`
- nothing: `null`.

`rerun` is the review command line the caller passes, so the next action
names a command that exists.

- [ ] **Step 1: Write the failing tests**

In `test/review/findings.test.ts`, one test per table row, named for the
kind (`an environment finding is env and does not block`, and so on), each
asserting `{ kind, action, blocks }`. Also:
- `a finding with no location blocks as touched`.
- `a critical untouched finding blocks`.
- `touchedLines reads new-side ranges, including untracked files`: a temp repository with one changed line at line 3 and one new untracked file of 2 lines gives `{ "a.ts": [[3, 3]], "b.ts": [[1, 2]] }`.
- `exitCode and next follow env, flake, block, file-task order`: four triages, asserting `exitCode` and that `next` contains the finding numbers and ends with the `rerun` string.

- [ ] **Step 2: Run the tests and see them fail**

Run: `S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run test/review/findings.test.ts --maxWorkers=2`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/review/findings.ts`**

- [ ] **Step 4: Run the tests and see them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Run the closing steps and commit**

`Review findings are classified into eight kinds and triaged to one verdict and one next action (cm-wkqedr.4)`

---

### Task 5: The superpowers review adapter compiles the rule to the reviewer's invocation and normalizes its report

**Files:**
- Create: `src/review/adapter.ts`
- Create: `src/review/superpowers.ts`
- Modify: `src/compiler/consistency.ts` (code `unknown-review-adapter`)
- Create: `test/review/conformance.ts`
- Test: `test/review/superpowers.test.ts`
- Create: `test/fixtures/review/superpowers/report-fail.md`, `test/fixtures/review/superpowers/expected-fail.json`

**Interfaces:**
- Consumes: `RawFinding` (Task 4), `Capability` and `ReviewRule` (Task 1).
- Produces, in `src/review/adapter.ts`:

```ts
export interface ReviewScope {
  base: string;
  head: string;
  previousHead?: string;
  previous?: ReviewFinding[];
  requirements: string[];
  upholds: { id: string; statement: string }[];
}
export interface Invocation {
  tool: "Agent";
  input: { description: string; subagent_type: string; model: string; prompt: string };
}
export interface Normalized { verdict: "pass" | "fail"; reviewedHead: string; findings: RawFinding[] }
export interface ReviewAdapter {
  id: string;
  invocation(rule: ReviewRule, scope: ReviewScope): Invocation;
  normalize(report: string, scope: ReviewScope): Normalized;
}
export const reviewAdapters: Map<string, ReviewAdapter>;
```

- Produces, in `src/review/superpowers.ts`: `export const superpowersReview: ReviewAdapter` with `id: "superpowers-review"`, and `export const REPORT_SHAPE: string`.

Ruling 14: a separate interface, because Warden never runs the reviewer.
Ruling 15: `invocation` returns the exact Agent tool input, with
`subagent_type: "general-purpose"` and `model: rule.model`.

The prompt holds, in this order: that the reviewer is independent and does
not edit; the full `head` and `base`; round 1 reviews the whole change
`base..head`, and a later round reviews only each finding in `previous` and
the fix diff `previousHead..head`; the requirement paths; each upheld
Practice as `<id>: <statement>`; each previous finding as `<n>. <title>
(<file>:<line>)`; and `REPORT_SHAPE` verbatim. It holds no suspected defect
or expected outcome.

`REPORT_SHAPE`, the contract both directions share (Ruling 16):

```text
Verdict: PASS | FAIL
Reviewed head: <full commit id>

### <Critical|Important|Minor|Environment> <n>. <title>
- Where: <file>:<line>
- Reproduces on: <head, base, previous>
- Spec: yes | no
- Earlier: <n of the previous finding, only when it is not fixed>
- Flaky: yes | no
- Correction condition: <what makes it pass>
```

`normalize` strips `\r`, ignores prose outside these lines, and returns
`Where`-less findings with no `file`. A report with no `Verdict:` line, or
whose `Reviewed head` is not `scope.head`, returns
`{ verdict: "fail", reviewedHead, findings: [one environment finding] }`
whose `correction` names the cause.

Consistency: a Capability whose `review.adapter` is not in `reviewAdapters`
fails as `unknown-review-adapter`, and its next action lists the known ids.

- [ ] **Step 1: Write the conformance harness and the failing tests**

`test/review/conformance.ts` exports
`reviewConformance(adapter: ReviewAdapter, rule: ReviewRule, scope: ReviewScope, report: string, expected: Normalized): void`,
which asserts both directions for any adapter:
- outbound: `invocation.input.model === rule.model`, and the prompt contains `scope.head`, `scope.base`, every requirement path, and every upheld statement.
- inbound: `normalize(report, scope)` deep-equals `expected`.

In `test/review/superpowers.test.ts`:
- `superpowers-review passes the conformance harness`: with `report-fail.md` (three findings: one Important with `Earlier: 1`, one Minor with `Reproduces on: base`, one Environment) and `expected-fail.json`.
- `a report filled from REPORT_SHAPE normalizes to what was filled`: build a report by filling the shape for two findings; `normalize` returns them field for field.
- `CRLF and surrounding prose parse the same`.
- `a report for another head is one environment finding`.
- `a report with no verdict is one environment finding`.
- `round 2 prompts list each previous finding and the fix diff range`.
- `an unknown review adapter fails as unknown-review-adapter` (in `test/compiler/consistency.test.ts`).

- [ ] **Step 2: Run the tests and see them fail**

Run: `S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run test/review/superpowers.test.ts test/compiler/consistency.test.ts --maxWorkers=2`
Expected: the seven new tests FAIL.

- [ ] **Step 3: Implement `src/review/adapter.ts`, `src/review/superpowers.ts`, and the consistency check**

- [ ] **Step 4: Run the tests and see them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Run the closing steps and commit**

`The superpowers review adapter compiles a review rule to the full Agent invocation and normalizes its report to findings, proved both ways by a conformance harness (cm-wkqedr.4)`

---

### Task 6: `warden review brief` and `warden review triage`

**Files:**
- Create: `src/cli/review.ts`
- Modify: `src/cli/main.ts` (a `review` command with two subcommands)
- Test: `test/cli/review.test.ts`

**Interfaces:**
- Consumes: `reviewAdapters`, `ReviewScope` (Task 5); `triage`, `touchedLines`, `exitCode` (Task 4); `loadRecords`.
- Produces, in `src/cli/review.ts`:

```ts
export interface ReviewOptions {
  capability: string;
  base: string;
  head: string;
  previousHead?: string;
  previous?: string;
  requirements: string[];
  report?: string;
  format: "text" | "json";
}
export async function runBrief(root: string, wardenRoot: string, o: ReviewOptions): Promise<number>;
export async function runTriage(root: string, wardenRoot: string, o: ReviewOptions): Promise<number>;
```

CLI:
- `warden review brief --capability <id> --base <ref> --head <ref> --requirements <paths...> [--previous-head <ref> --previous <triage.json>]` prints the `Invocation` as JSON and exits 0.
- `warden review triage --capability <id> --base <ref> --head <ref> --report <file> [--previous-head <ref>] [--format text|json]` prints one line per finding, `<BLOCK|TASK|RERUN|ENV> <n> <kind> <file>:<line>  <title>`, then `Next action: <next>`, and exits with `exitCode`. `--format json` prints the `Triage`, which is also the `--previous` input of the next brief.

Both resolve `--base`, `--head`, and `--previous-head` with
`git rev-parse --verify <ref>^{commit}` to full ids. `round` is 2 when
`--previous-head` is set, else 1. `touched` is
`touchedLines(root, previousHead ?? base, head)`. The `rerun` string passed
to `triage` is the `warden review brief` command line for the same head.

Usage and environment failures exit 2 with one next action:
- unknown capability: `run warden review brief --capability <one of the Capabilities with a review block>`.
- a Capability with no `review` block: the same action.
- a ref that is not a commit: `run git fetch origin <ref>, then run the command again`.
- an unreadable `--report` or `--previous`: `save the reviewer's report to <path>, then run the command again`.

Ruling 20: neither command writes a file.

- [ ] **Step 1: Write the failing tests**

In `test/cli/review.test.ts`, using a fixture project in a temp git
repository with a local pack holding one skill Capability with
`review: { adapter: superpowers-review, model: opus }`, run through
`spawnSync("node", [main, "review", ...])`:
- `brief prints the Agent invocation for the resolved head`: exit 0; `JSON.parse(stdout).input.prompt` contains the full head id.
- `triage of a passing report exits 0 with no next action`.
- `triage of a report with an unfixed finding exits 1, and its next action names the brief command`: run the printed brief command; it exits 0.
- `triage of an environment report exits 2`.
- `triage json feeds the next brief as --previous`: the round-2 prompt lists the round-1 finding.
- `an unknown capability exits 2, and the printed command exits 0`.
- `a head that is not a commit exits 2 with the fetch action`.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm run build:dist && S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run test/cli/review.test.ts --maxWorkers=2`
Expected: FAIL; `review` is an unknown command.

- [ ] **Step 3: Implement `src/cli/review.ts` and register the commands in `src/cli/main.ts`**

- [ ] **Step 4: Run the tests and see them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Run the closing steps and commit**

`warden review brief prints the reviewer's full invocation, and warden review triage routes its report by kind to one next action (cm-wkqedr.4)`

---

### Task 7: The `review` pack: the pre-review gate and the change-review Capability, end to end

**Files:**
- Create: `packs/review/pack.yaml`
- Create: `packs/review/gate.js`
- Test: `test/review-pack.test.ts`

**Interfaces:**
- Consumes: everything above. The skill's commands are those of Task 6 and `warden check`.
- Produces: bundled pack `review`, layer 5, with:
  - Terms `change` ("The commits and working-tree edits between a base commit and the head under review.") and `reviewer` ("A fresh agent session that did not build a change and judges it against its requirements.").
  - Practice `review-gate-first`, statement "A change reaches a reviewer only after its new tests pass on the change and fail on its base.", terms `[change, reviewer]`, `paths: []`.
  - Guardrail `review-gate`: `kind: runtime`, `runs: [boundary]`, `budgetMs: 120000` (Ruling 12), `version: 1`, `implementation: cmd:exec node "$WARDEN_PACK_DIR/gate.js"` (Ruling 6).
  - Capability `change-review`: `kind: skill`, `serves: change`, `upholds: [review-gate-first]`, `review: { adapter: superpowers-review, model: opus }`, `replaces: ["dispatching a reviewer before the gate passes", "reading a review report and choosing what to do by hand"]`, and these commands, in order:
    1. `warden check --rule review-gate --tier boundary --base <base>`
    2. `warden review brief --capability change-review --base <base> --head <head> --requirements <paths>`
    3. `warden review triage --capability change-review --base <base> --head <head> --report <report>`
  - Settings schema: `tests` (array of globs, default `["test/**/*.test.ts"]`), `test` (string, default `npx vitest run --maxWorkers=2`), `build` (object with required `command` and `output`, no default). `examples: [{ tests: ["test/**/*.test.mjs"], test: "node --test" }]`.
  - mustFail `{ "test/a.test.mjs": "import test from 'node:test';\ntest('a', () => {});\n" }`: it passes on the base too, so the gate fails.
  - mustPass `{ "lib.mjs": "export const v = 2;\n", "test/a.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert';\nimport { v } from '../lib.mjs';\ntest('a', () => assert.equal(v, 2));\n" }`: `lib.mjs` is not a test file, so it is absent on the base, and the test fails there.

`gate.js` reads `WARDEN_BASE` and `WARDEN_SETTINGS`, and runs these steps in
order. It stops at the first failure (Ruling 7), prints one line ending in
`Next action: …`, and exits with the code shown.

| Step | Failure | Exit | Next action |
|---|---|---|---|
| 0 | `WARDEN_BASE` unset | 2 | `run warden check --rule review-gate --tier boundary --base <base branch>.` |
| 0 | `WARDEN_BASE` is not a commit | 2 | `run git fetch origin <base>, then run warden check --rule review-gate --tier boundary --base <base>.` |
| 1 | No changed or untracked file matches `tests` (Ruling 8) | 1 | `add a test under <tests> that fails on <base>, then run the gate again.` |
| 2 | `build.command` exits non-zero | 1 | `run <build.command> and fix what it reports, then run the gate again.` |
| 3 | `git status --porcelain -- <build.output>` is not empty after the build | 1 | `stage the rebuilt <build.output> with git add <build.output>, then run the gate again.` |
| 4 | The test command fails on the change | 1 | `run <test> <files> and fix the failing tests, then run the gate again.` |
| 5 | The copied tests all pass on the base (Ruling 13) | 1 | `change <files> so at least one assertion fails on <base>, then run the gate again.` |

Steps 2 and 3 run only when `build` is set. Tests run with `HOME`,
`WARDEN_HOME`, and `GIT_CONFIG_GLOBAL` set to folders in a scratch
directory. For step 5, the gate adds a detached worktree at
`<os.tmpdir()>/warden-gate-<pid>-<random>`, links the project's
`node_modules` into it when one exists, copies the test files, runs the
build when set, and runs the tests. On every exit path it removes the link
first, then the worktree with `git worktree remove --force`. At start it
removes any registered `warden-gate-<pid>-*` worktree whose process no
longer exists. Every child process is spawned with an argv array, never a
shell string.

- [ ] **Step 1: Write the failing tests**

In `test/review-pack.test.ts`, each in a temp git repository with
`.warden/config.yaml` listing `core` and `review`, and with `review`
settings `{ tests: ["test/**/*.test.mjs"], test: "node --test" }` unless the
test says otherwise:
- `compile emits the change-review skill and passes the gate's examples`: `compile` returns no findings, and `skillPath("change-review")` holds the three commands.
- `gate passes when the new test fails on base and passes on the change`: `warden check --rule review-gate --tier boundary --base main` exits 0.
- `gate fails when the new tests also pass on base, and the printed action clears it`.
- `gate fails when no test file changed, and the printed action clears it`.
- `gate fails when the change's tests fail, and the printed action clears it`.
- `gate fails on a stale build output, and the printed git add clears it`: `build: { command: "node build.mjs", output: "out" }`.
- `gate exits 2 when the base is not a commit`.
- `test files with spaces and quotes reach the test command intact`.
- `the project node_modules survives the base run`.
- `a gate killed mid-run leaves no worktree after the next run`: start a gate whose test command sleeps, kill its process group, run the gate again, and assert `git worktree list --porcelain` names only the project.
- `a gate run leaves the project tree as it found it outside .warden`: `git status --porcelain` is the same before and after.

"Clears it" means the test makes the change the next action names, runs
the gate again, and asserts exit 0.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm run build:dist && S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run test/review-pack.test.ts --maxWorkers=2`
Expected: FAIL; pack `review` not found.

- [ ] **Step 3: Write `packs/review/pack.yaml` and `packs/review/gate.js`**

- [ ] **Step 4: Run the tests and see them pass**

Same command. Expected: PASS. Also run
`S=$(mktemp -d); env HOME=$S/h WARDEN_HOME=$S/wh GIT_CONFIG_GLOBAL=$S/gc npx vitest run test/self.test.ts --maxWorkers=2`
and confirm Warden's own check still passes with `review` not enabled (Ruling 22).

- [ ] **Step 5: Run the closing steps and commit**

`The review pack runs the pre-review gate as a Warden Guardrail with one next action per failure, and its change-review Capability compiles to a skill that runs the gate, the brief, and the triage (cm-wkqedr.4)`

---

## After the slice

- Release Warden, then enable `review` in Warden's own `.warden/config.yaml` with `build: { command: "npm run -s build:dist", output: "dist/src" }`, and link `.claude/skills/change-review`. This replaces `pre-review-gate.sh` and the hand triage in the next build.
- File one task per deferred item above under `cm-wkqedr.4`.
