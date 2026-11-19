# Style and language packs, version 1: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v1 rows of the four approved packs (`typescript`,
`rxjs-declarative`, `signals`, `declarative-ui`) and the engine changes they
need, so that compile refuses the RxJS and signals forms on one path.

**Architecture:** Four engine tasks come first. E1 and E2 make the conflict
check exact. E3 makes bracketed collection folders usable as pack scopes.
A small slice of E5 lets the `exactOptionalPropertyTypes` Guardrail run.
Then each pack is data plus at most one pack `eslint.js`, proved by its own
vitest file. A last task runs all four packs together and reads their
Evidence.

**Tech Stack:** YAML records, ESLint 9.39.5 core rules and pack rules,
`typescript` 5.9.3 through the `tsc` adapter, vitest 4.

**Spec:** [`2026-11-19-style-and-typescript-packs-design.md`](2026-11-19-style-and-typescript-packs-design.md),
approved by Ryan on November 19, 2026, with every open question's
recommendation.

## Global Constraints

- No source comments.
- Exit codes: 0 pass, 1 violation, 2 usage or environment.
- Every failure ends in exactly one next action, and a test runs it.
- Never raise a timeout or loosen a bench setting.
- Scaling tests derive their Guardrail lists from the loaded records.
- Rebuild dist before hook tests.
- Every new test fails on base.
- No new dependency.
- Each Guardrail carries the design's help, harm, and miss telemetry signals as far as the existing Evidence kinds allow.

## Plan-wide requirements: the builder checklist

Copied from the first-slice builder checklist. Check every item before you
report a task.

1. Every next action the code prints is executed by a test, and the test proves it clears the failure.
2. Every alert or refusal has a tested way to clear for each thing that can hold it open (branches, worktrees, tags, remote refs, stashes, rotated history).
3. Environment and usage failures (missing tool, non-English locale, a release that does not exist) exit 2 with a working next action. They are never a stack trace and never exit 1.
4. No message is matched by its English text. Match exit codes or structured output.
5. Rebuild dist (`npm run build:dist`) before you run any hook or CLI test. Committed dist must match a fresh build.
6. Each new test fails on the base commit. Record the command and the output.
7. No raised timeout, no loosened bench setting, no source comments.
8. Lists of Guardrails or packs come from the loaded records, never a hand-written list.

## Conventions

- Tests: `npx vitest run --maxWorkers=2 <file>`, affected files only. Each
  test sets `WARDEN_HOME` to a temp folder and writes only temp folders.
- Type-check once per task: `npx tsc --noEmit`.
- Commit subjects end with the bead id the controller files for this plan.
  Never use `--no-verify`.
- Ids are unique across all packs, so every Practice and Guardrail id starts
  with its pack id.
- "Telemetry" in a task means what the existing Evidence kinds can carry.
  `fired`, `cost`, and `stalled` already record for every Guardrail with no
  per-Guardrail work (`src/cli/check.ts:478`, `:498`). The pack sets the
  design's `budgetMs`, so `cost` is measured against the right budget. Each
  pack test pins the design's "Escape looks like" shape and its `displaced`
  shape as a test with today's status, so the miss is on record before E9
  adds `escaped`, `hollow`, and `displaced`. Task 9 proves the `fired` and
  `cost` rows exist for every new Guardrail.
- Each Guardrail's `mustPass` is its `mustFail` with the message's next
  action applied. `runExamples` therefore executes every Guardrail's next
  action.
- The non-test glob, called `NON_TEST` below, is exactly
  `"!**/{*.test.*,*.spec.*,*.stories.*,test/**,tests/**,__tests__/**,e2e/**}"`.

## Deferred engine gaps

Version 1 needs none of these. Each one waits with the v2 Guardrails it
blocks.

- **E4, more than one `tsc` program.** TS-1 v1 checks the root
  `tsconfig.json` program, which the design accepts. The Electron program
  waits.
- **E5, the rest.** Attribution for `noUncheckedIndexedAccess`,
  `useUnknownInCatchVariables`, and `verbatimModuleSyntax` waits with
  `typescript-unchecked-index`. Task 4 builds only the slice that the v1
  flag `exactOptionalPropertyTypes` needs.
- **E6, typed linting.** Blocks TS-3, TS-4, and the typed form of RX-2.
- **E7, `typescript-eslint` and third-party plugins.** Blocks TS-3, TS-4,
  and UI-4.
- **E8, `review` Guardrails.** Blocks every "Left to review" row.
- **E9, the `resolved`, `disputed`, `escaped`, `hollow`, and `displaced`
  Evidence kinds and `warden dispute`.** Blocks the "Helped" and "upheld
  disputes" columns. v1 records `fired`, `cost`, and `stalled` only, as the
  design's version split says.
- **Not built in v1 at all:** SIG-2 to SIG-4 (signals Q1 (a)), UI-4,
  `typescript-index-signature-access` (Q2 (a): never).

## Task order and parallel groups

| Task | Owns these files | Waits on |
|---|---|---|
| 1. E1: conflicts resolve against every pack | `src/compiler/consistency.ts`, `src/compiler/compile.ts`, `test/compiler/consistency.test.ts`, `test/compiler/compile.test.ts` | none |
| 3. E3: no backslash in a pack glob | `src/records/load.ts`, `src/records/paths.ts`, `src/compiler/examples.ts`, `test/records/load.test.ts`, `test/adapters/eslint.test.ts` | none |
| 4. E5 slice: flag prerequisites and options errors | `src/adapters/tsc.ts`, `test/adapters/tsc.test.ts` | none |
| 6. Pack `rxjs-declarative` | `packs/rxjs-declarative/pack.yaml`, `packs/rxjs-declarative/eslint.js`, `test/rxjs-declarative-pack.test.ts`, `test/rxjs-declarative-pack.scaling.test.ts` | none |
| 8. Pack `declarative-ui` | `packs/declarative-ui/pack.yaml`, `test/declarative-ui-pack.test.ts`, `test/declarative-ui-pack.scaling.test.ts` | none |
| 2. E2: conflicts need plain folder scopes | `src/compiler/consistency.ts`, `test/compiler/consistency.test.ts` | 1 (same files), 3 (uses `folderOf`) |
| 5. Pack `typescript` | `packs/typescript/pack.yaml`, `test/typescript-pack.test.ts`, `test/typescript-pack.scaling.test.ts` | 4 |
| 7. Pack `signals` and the conflict pair | `packs/signals/pack.yaml`, one line of `packs/rxjs-declarative/pack.yaml`, `test/signals-pack.test.ts`, `test/signals-pack.scaling.test.ts` | 1, 2, 3, 6 |
| 9. All four packs together | `test/style-packs.test.ts`, the design doc's new last section | 5, 7, 8 |

Parallel waves, each in its own worktree:

- **Wave A:** Tasks 1, 3, 4, 6, and 8. Their files are disjoint.
- **Wave B:** Task 2 (after 1 and 3) and Task 5 (after 4).
- **Wave C:** Task 7.
- **Wave D:** Task 9, then the release proof.

Task numbers follow the requested order, engine first. The waves are the
run order.

## Review Focus

- **A bracketed collection scope.** With `[[]plugins]/**`, example and bench
  files must land under `[plugins]/`, not under a literal `[[]plugins]/`
  folder that the scope does not match. `examplePrefix` reads the literal
  text today (`src/compiler/examples.ts:13-15`), so every example would
  silently test nothing. Task 3 pins it.
- **`exactOptionalPropertyTypes` on a program without `strictNullChecks`.**
  tsc prints `error TS5052` with no file position. The adapter throws
  `tsc printed an unparsable line` (`src/adapters/tsc.ts:116`), a stack
  trace instead of exit 2. Warden's example project has no `strict`, so
  `typescript-exact-optional`'s own examples hit it. Verified on 5.9.3.
  Task 4 pins it.
- **A string prefix that is not a parent folder.** `src/ui/**` and
  `src/ui-kit/**` do not overlap. `src/ui/**` and `src/**` do. Task 2 pins
  both.
- **Operators written the normal way.** `subscriber.next(v)` inside
  `new Observable(...)`, `Map.set`, and a local function named `effect` must
  pass. Tasks 6 and 7 pin them.
- **Compliant TypeScript that looks like an assertion.** `as const` and
  `satisfies` pass `typescript-no-assertion`. `<T>x` fails. Task 5 pins
  them.

---

### Task 1: E1, conflicts resolve against every pack

**Files:**
- Modify: `src/compiler/consistency.ts:43`, `:77-97`
- Modify: `src/compiler/compile.ts:98-100`
- Test: `test/compiler/consistency.test.ts`, `test/compiler/compile.test.ts`

**Interfaces:**
- Produces: `checkConsistency(set: RecordSet, elsewhere: ReadonlyMap<string, string> = new Map()): Finding[]`.
  `elsewhere` maps a Practice id to the id of a pack that defines it but is
  not enabled. The default serves callers that check one set by itself.
- Produces: `practicesElsewhere(set: RecordSet, wardenRoot: string): Promise<Map<string, string>>`,
  exported from `src/compiler/compile.ts`. It reads packs only when some
  `conflictsWith` id names no enabled Practice. It then reads every
  `packs/*/pack.yaml` under `wardenRoot` and every
  `.warden/packs/*/pack.yaml` under `set.root` with `readPack`, skipping
  packs already enabled. A disabled pack that fails to read throws its
  `RecordError`, as an enabled one does.
- Consumes: `readPack` from `src/records/load.ts`.

Behavior:

- A `conflictsWith` id that `elsewhere` holds gives no finding: the other
  pack is off, so nothing can overlap.
- A `conflictsWith` id that no pack defines gives `undefined-conflict`:
  `Practice <p> conflicts with <id>, which no pack defines. Next action: remove <id> from conflictsWith of Practice <p> in <pack file>, then run warden compile.`
- `compile` calls `checkConsistency(set, await practicesElsewhere(set, wardenRoot))`.

- [ ] **Step 1: Write the failing tests.**
  - `consistency.test.ts`, `a conflict with a practice in a disabled pack gives no finding`:
    `codes(build([pack("a", 1, [practice("p1", "a", { conflictsWith: ["p2"] })])]))`
    with `elsewhere = new Map([["p2", "b"]])` equals `[]`.
  - `consistency.test.ts`, `flags undefined-conflict` gains: the message holds
    exactly one `Next action:`, and removing `ghost` from `conflictsWith`
    and rechecking gives `[]`.
  - `compile.test.ts`, `a conflict names a practice in a local pack the project has not enabled`:
    a temp project with local packs `left` (Practice `left-p`,
    `conflictsWith: [right-p]`) and `right` (Practice `right-p`), config
    enabling `core` and `left` only. `compile` returns no findings. Then
    the same project with `right-p` renamed to `other-p` returns one
    `undefined-conflict`. Running its next action (remove `right-p`)
    returns no findings.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 test/compiler/consistency.test.ts test/compiler/compile.test.ts`.
  Expected: the three new tests FAIL.
- [ ] **Step 3: Implement** `checkConsistency`'s new parameter and
  `practicesElsewhere`, and call it from `compile`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit`. Expected: exit 0.
- [ ] **Step 6: Commit.**

### Task 2: E2, conflicts need plain folder scopes

**Files:**
- Modify: `src/compiler/consistency.ts:27-37`, `:86-96`, and `CODES`
- Test: `test/compiler/consistency.test.ts`

**Interfaces:**
- Consumes: `checkConsistency(set, elsewhere)` from Task 1, and
  `folderOf(glob: string): string | undefined` from Task 3.
- Produces: the finding code `conflict-scope`, placed after
  `conflict-overlap` in `CODES`.

Rules. They apply to every Practice with a non-empty `conflictsWith` and to
every Practice it names, whether or not the other pack is enabled:

- Each path of the owning pack's config entry must be a plain folder scope:
  `folderOf` returns a folder. An empty `paths` list is refused too, because
  it applies everywhere (`src/records/paths.ts:23`).
- Refusal, one finding per bad path:
  `Pack <id> has path <glob> in <config file>, and Practice <p> conflicts with <q>, so its paths must be folder scopes. Next action: replace <glob> in the paths of pack <id> in <config file> with folder scopes such as src/ui/**, then run warden compile.`
  For an empty list: `... Next action: add a folder scope such as src/** to the paths of pack <id> in <config file>, then run warden compile.`
  `<config file>` is `join(set.root, ".warden", "config.yaml")`.
- A Practice's effective folders: for each pack folder `F` and each
  Practice path `P`, if `folderOf(P)` is defined, take the inner of the two
  when one contains the other, and nothing otherwise. A Practice path that
  is not a plain folder scope, such as `NON_TEST`, yields `F`. Empty
  Practice paths yield the pack folders.
- Two folders overlap exactly when they are equal or one starts with the
  other plus `/`.
- `conflict-overlap` names both folders and gains one next action:
  `Practices <first> and <second> conflict and both apply under <folder a> and <folder b>. Next action: change the paths of pack <pack of second> in <config file> so that no folder contains or is inside <folder a>, then run warden compile.`
- When the other Practice is in `elsewhere`, check only the scope shape.
- Delete `prefix`, `overlaps`, `longer`, and `effectiveGlobs`.

- [ ] **Step 1: Write the failing tests** in `consistency.test.ts`:
  - `a negated glob overlaps every path it does not exclude` becomes
    `a negated pack path is refused as a conflict scope`: code
    `conflict-scope`.
  - `src/{ui,core}/** against src/ui/** is refused as a conflict scope`.
  - `empty pack paths are refused as a conflict scope`, also when the other
    pack is only in `elsewhere`.
  - `it.each` overlap cases `[a, b, overlapping]`:
    `["src/ui/**", "src/ui/**", true]`, `["src/**", "src/ui/**", true]`,
    `["src/ui/**", "src/ui-kit/**", false]`, `["src/ui/**", "docs/**", false]`,
    `["[[]plugins]/a/**", "[[]plugins]/**", true]`.
  - `the conflict-overlap next action clears it`: apply the action (move
    pack `b` to `docs/**`) and recheck: `[]`.
  - `the conflict-scope next action clears it`: replace the glob with
    `src/**` and recheck: `[]`.
  - Keep `narrows conflict paths by a practice's own paths` unchanged; it
    must still pass.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 test/compiler/consistency.test.ts`.
  Expected: the new and changed tests FAIL.
- [ ] **Step 3: Implement** the rules above.
- [ ] **Step 4: Run** the same command, then
  `npx vitest run --maxWorkers=2 test/architecture-pack.test.ts test/folder-json-pack.test.ts`.
  Expected: PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit`. Expected: exit 0.
- [ ] **Step 6: Commit.**

### Task 3: E3, no backslash in a pack glob

**Files:**
- Modify: `src/records/load.ts` (`parseConfig`, `readPack`)
- Modify: `src/records/paths.ts`
- Modify: `src/compiler/examples.ts:13-15`
- Test: `test/records/load.test.ts`, `test/adapters/eslint.test.ts`

**Interfaces:**
- Produces, in `src/records/paths.ts`:
  - `literalOf(glob: string): string`: the text before the first glob
    character, with each `[[]` read as `[`. A negated glob gives `""`.
  - `folderOf(glob: string): string | undefined`: the decoded folder when
    `glob` is `<literal folder>/**`, and `undefined` otherwise. A literal
    folder is one or more `/`-separated segments, none empty, `.`, or `..`,
    made of characters other than `* ? { } [ ] ! \`, plus `[[]` and `]`.
- Changes: `examplePrefix` uses `literalOf`, so example files and bench
  files (`src/compiler/bench.ts:147`) land inside a bracketed scope.

Refusal. Every config `packs[].paths` entry and every Practice `paths`
entry holding `\` throws a `RecordError` at its JSON pointer:
`path <glob> holds a backslash, which Node's glob matcher does not read as an escape. Next action: write <fixed> in place of <glob> in <file>, then run warden compile.`
`<fixed>` replaces each `\[` with `[[]` and each `\]` with `]`. Any other
backslash is removed.

- [ ] **Step 1: Write the failing tests.**
  - `load.test.ts`, `a config path with a backslash is refused with the [[] form`:
    a config with `paths: ["\\[plugins\\]/**"]` throws a `RecordError`
    whose `pointer` is `/packs/0/paths/0`. Writing the glob from its next
    action (`[[]plugins]/**`) and loading again succeeds.
  - `load.test.ts`, `a practice path with a backslash is refused`: the same
    for a local pack, pointer `/practices/0/paths/0`.
  - `load.test.ts`, `examplePrefix reads [[] as [`:
    `examplePrefix(["!**/sources/**", "[[]plugins]/**"])` is `"[plugins]/"`.
  - `load.test.ts`, `folderOf accepts only plain folder scopes`, `it.each`:
    `src/ui/**` gives `src/ui`; `[[]plugins]/frame/**` gives
    `[plugins]/frame`; `**`, `src/*.ts`, `src/{a,b}/**`, `!src/**`,
    `../src/**`, and `src/ui` give `undefined`.
  - `eslint.test.ts`, `a Guardrail scoped to [[]plugins]/** lints [plugins]/a.ts`:
    `no-var` on a config path `[[]plugins]/**` fails `[plugins]/a.ts` and
    leaves `src/a.ts` unchecked. This proves the design's unverified claim
    that ESLint's matcher accepts the form. Warden's `minimatch` returns
    `true` for it in a scratch run; the test makes that permanent.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 test/records/load.test.ts test/adapters/eslint.test.ts`.
  Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `literalOf`, `folderOf`, the refusal, and the
  `examplePrefix` change.
- [ ] **Step 4: Run** the same command, then
  `npx vitest run --maxWorkers=2 test/compiler/examples.test.ts test/collection-folders-pack.test.ts`.
  Expected: PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit`. Expected: exit 0.
- [ ] **Step 6: Commit.**

### Task 4: E5 slice, flag prerequisites and options errors

**Files:**
- Modify: `src/adapters/tsc.ts:38-45`, `:108-118`
- Test: `test/adapters/tsc.test.ts`

**Interfaces:**
- Produces, in `tsc.ts`: `const PREREQUISITES: Record<string, string[]> = { exactOptionalPropertyTypes: ["strictNullChecks"] }`.
  `emit` sets each prerequisite of an emitted flag to `true` unless another
  Guardrail in the same emit already sets it. Its diagnostics keep their
  owner, or count as `tsc:baseline-errors` when no Guardrail owns them.
- Produces: a diagnostic line with no file position, `error TS<n>: <text>`,
  throws a `RecordError` for the project's `tsconfig.json`, pointer
  `/compilerOptions`:
  `tsc refused the compiler options: TS<n>: <text> Next action: change compilerOptions in <root>/tsconfig.json so tsc accepts them, then run warden check again.`
  `warden check` maps a `RecordError` to exit 2.

- [ ] **Step 1: Write the failing tests** in `tsc.test.ts`:
  - `exactOptionalPropertyTypes runs on a program without strictNullChecks`:
    the fixture project, one Guardrail `tsc:exactOptionalPropertyTypes`, a
    file `export const o: { a?: number } = { a: undefined };`. The result for
    that Guardrail is `fail` with message prefix `TS2375`.
  - `an options error exits as a usage failure with one next action`: a
    project `tsconfig.json` with `"exactOptionalPropertyTypes": true,
    "strictNullChecks": false` and a Guardrail on `tsc:noImplicitReturns`.
    `run` rejects with a `RecordError` whose message holds exactly one
    `Next action:`. Setting `strictNullChecks` to `true`, as the action
    says, makes `run` resolve with status `pass`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 test/adapters/tsc.test.ts`.
  Expected: both FAIL, the second with `tsc printed an unparsable line`.
- [ ] **Step 3: Implement** `PREREQUISITES` in `emit` and the options
  error in `run`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Run** `npx tsc --noEmit`. Expected: exit 0.
- [ ] **Step 6: Commit.**

### Task 5: Pack `typescript`

**Files:**
- Create: `packs/typescript/pack.yaml`
- Test: `test/typescript-pack.test.ts`, `test/typescript-pack.scaling.test.ts`

**Interfaces:**
- Consumes: Task 4's `PREREQUISITES`, through
  `typescript-exact-optional`'s examples.
- Produces: pack `typescript`, `layer: 5`, Terms `escape-hatch` (bans
  `cast`) and `floating-promise`, with the design's definitions.

Practices and Guardrails (exact):

| Practice | `paths` | Guardrail | `kind`, `runs`, `budgetMs` | `implementation`, `options` |
|---|---|---|---|---|
| `typescript-strict-compiler`, "The compiler checks null, implicit any, implicit returns, overrides, and optional properties." | `[]` | `typescript-strict-null` | `type`, `[commit]`, 60000 | `tsc:strictNullChecks` |
| | | `typescript-no-implicit-any` | same | `tsc:noImplicitAny` |
| | | `typescript-implicit-returns` | same | `tsc:noImplicitReturns` |
| | | `typescript-implicit-override` | same | `tsc:noImplicitOverride` |
| | | `typescript-exact-optional` | same | `tsc:exactOptionalPropertyTypes` |
| `typescript-no-escape-hatches`, "Code uses no escape-hatch." Terms `[escape-hatch]`. | `[NON_TEST]` | `typescript-no-any` | `lint`, `[edit, commit]`, 5000 | `eslint:no-restricted-syntax`, `[{ selector: "TSAnyKeyword", message }]` |
| | | `typescript-no-non-null` | same | `eslint:no-restricted-syntax`, `[{ selector: "TSNonNullExpression", message }]` |
| | | `typescript-no-assertion` | same | `eslint:no-restricted-syntax`, `[{ selector: "TSAsExpression:not([typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='const'])", message }, { selector: "TSTypeAssertion", message }]` |

The TS-1 statement drops "indexed access", which waits on E5. Messages:

- `typescript-no-any`: "Code uses no escape-hatch. Replace any with the precise type, or with unknown and a check that narrows it."
- `typescript-no-non-null`: "Code uses no escape-hatch. Remove the ! and handle the missing value with a check or a default."
- `typescript-no-assertion`: "Code uses no escape-hatch. Remove the assertion and narrow the value with a check, or write as const or satisfies."

Examples. Each `mustFail` breaks only its own Guardrail:

- `typescript-implicit-returns`: `export const first = (xs: number[]) => { if (xs.length > 0) return xs[0]; };`
  passes with a final `return 0;`. Leave the return type off: under
  `strict`, an annotated function reports TS2366, a baseline error, not
  TS7030.
- `typescript-strict-null`: `export const len = (s: string | undefined): number => s.length;`
  (TS18048); passes as `s?.length ?? 0`.
- `typescript-no-implicit-any`: `export const id = (v) => v;` (TS7006);
  passes as `(v: number): number => v`.
- `typescript-implicit-override`: a class `B extends A` that redeclares
  `run()` (TS4114); passes with `override run()`.
- `typescript-exact-optional`: `export const o: { a?: number } = { a: undefined };`
  (TS2375); passes as `{}`.
- TS-2: the design's must-fail and must-pass for `typescript-no-assertion`;
  `const n: any = 1` and `v!.length` for its siblings, each passing as a
  checked form.

- [ ] **Step 1: Write the failing test** `test/typescript-pack.test.ts`,
  modeled on `test/architecture-pack.test.ts`. Config: `core` and
  `typescript`, both on `["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]`.
  - `is consistent and its examples hold`: `checkConsistency(set)` and
    `await runExamples(set)` both equal `[]`.
  - `it.each` lint cases `[id, file, source, status]`:
    `x as const` passes `typescript-no-assertion`; `x satisfies T` passes;
    `<number>v` in a `.ts` file fails; `v as number` fails;
    `export const n = (v: unknown): number => v as number;` in
    `src/a.test.ts` passes (`NON_TEST`); the same in `test/a.ts` passes.
  - `telemetry pins the escapes and displacements`, `it.each`
    `[id, source, status]`:
    - escape, `typescript-no-any`: `export const f = (g: Function): unknown => g;` passes;
    - displaced, `typescript-no-any` to `typescript-no-assertion`: `export const f = (v: unknown): number => v as number;` fails `typescript-no-assertion`;
    - displaced, `typescript-no-non-null` to `typescript-no-assertion`: `export const f = (s: string | undefined): string => s as string;` fails `typescript-no-assertion`;
    - escape, `typescript-no-non-null`: `export const f = (s: string | undefined): string => { if (!s) throw new Error("s"); return s; };` passes;
    - escape, `typescript-no-assertion`: `declare const cast: <T>(v: unknown) => T; export const n = cast<number>(1);` passes.
    The `tsc` rows' escape is a program Warden does not check, which waits
    on E4; this test names no case for it.
- [ ] **Step 2: Write** `test/typescript-pack.scaling.test.ts` as
  `test/architecture-pack.scaling.test.ts` does, with
  `guardrailIds("typescript", CODE_PATHS)`.
- [ ] **Step 3: Run** `npx vitest run --maxWorkers=2 test/typescript-pack.test.ts`.
  Expected: FAIL, `pack typescript not found`.
- [ ] **Step 4: Write** `packs/typescript/pack.yaml` from the tables above.
- [ ] **Step 5: Run** `npx vitest run --maxWorkers=2 test/typescript-pack.test.ts test/typescript-pack.scaling.test.ts`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 6: Pack `rxjs-declarative`

**Files:**
- Create: `packs/rxjs-declarative/pack.yaml`, `packs/rxjs-declarative/eslint.js`
- Test: `test/rxjs-declarative-pack.test.ts`, `test/rxjs-declarative-pack.scaling.test.ts`

**Interfaces:**
- Produces: pack `rxjs-declarative`, `layer: 6`, Terms `observable` (bans
  `stream`), `subject`, `subscription`, and `operator`, with the design's
  definitions.
- Produces: Practice id `rxjs-state-is-observable`, which Task 7 names.
  Here its `conflictsWith` is `[]`; Task 7 adds `signals-state-is-signal`.
- Produces: `packs/rxjs-declarative/eslint.js`, default export
  `{ "no-relay": rule }`, the shape of `packs/architecture/eslint.js`.

Every Practice has `paths: [NON_TEST]`. Every Guardrail is kind `lint`,
`runs: [edit, commit]`, `budgetMs: 5000`, `version: 1`:

| Practice and statement | Guardrail | `implementation`, `options` |
|---|---|---|
| `rxjs-state-is-observable`: State that changes over time is an observable, never a signal. | `rxjs-no-signal-imports` | `eslint:no-restricted-imports`, `{ paths: [{ name: "@angular/core", importNames: ["signal", "computed", "effect", "linkedSignal"], message }], patterns: [{ group: ["@preact/signals*"], message }] }` |
| `rxjs-subjects-stay-private`: A subject is never exported or public; code outside its owner reads an observable. | `rxjs-no-exposed-subjects` | `eslint:no-restricted-syntax`, the design's two RX-2 selectors, each with `message` |
| `rxjs-subscriptions-kept`: The subscription that subscribe returns is always kept, so the code can end it. | `rxjs-kept-subscriptions` | `eslint:no-restricted-syntax`, `"ExpressionStatement > CallExpression[callee.property.name='subscribe']"` with `message` |
| `rxjs-no-nested-subscribe`: Code never calls subscribe inside a subscribe callback; it composes with an operator such as switchMap. | `rxjs-nested-subscribe` | `eslint:no-restricted-syntax`, `"CallExpression[callee.property.name='subscribe'] CallExpression[callee.property.name='subscribe']"` with `message` |
| `rxjs-no-relay`: A subscribe callback never calls next on a subject; derived values come from an operator. | `rxjs-relay` | `eslint:rxjs-declarative/no-relay` |

Messages:

- `rxjs-no-signal-imports`: "Changing state is an observable. Hold the state in an Observable, and use toSignal from @angular/core/rxjs-interop only at a signal boundary."
- `rxjs-no-exposed-subjects`: "A subject is never exported or public. Make the subject private, and expose subject.asObservable()."
- `rxjs-kept-subscriptions`: "Every subscription is kept. Assign the result of subscribe, and call unsubscribe when its owner ends."
- `rxjs-nested-subscribe`: "Code never subscribes inside a subscribe callback. Replace the inner subscribe with switchMap, mergeMap, or concatMap in the outer pipe."
- `no-relay`'s `meta.messages.relay`: "A subscribe callback never pushes into a subject. Derive the value with an operator in pipe, and expose that observable."

`no-relay` reports a `CallExpression` whose callee is `<receiver>.next`,
when both hold:

- It lies inside a function that is an argument of a call whose callee
  property is `subscribe`.
- The receiver resolves, through `context.sourceCode.getScope`, to a
  variable whose declarator `init` is `new <name>Subject(...)`. Or the
  receiver is `this.<key>` or `this.#<key>`, and the enclosing class has a
  `PropertyDefinition` with that key whose `value` is `new <name>Subject(...)`.

Examples are the design's RX-1 to RX-5 must-fail and must-pass sources.
RX-2's must-pass is a class with `readonly #open = new BehaviorSubject(0);`
and `readonly open$ = this.#open.asObservable();`.

- [ ] **Step 1: Write the failing test** `test/rxjs-declarative-pack.test.ts`.
  Config: `core` and `rxjs-declarative`, both on `["src/**"]`, so the test
  holds after Task 7 makes RX-1 need a folder scope.
  - `is consistent and its examples hold`: `checkConsistency(set)` and
    `await runExamples(set)` both equal `[]`.
  - `it.each` cases `[id, source, status]`:
    `import { toSignal } from "@angular/core/rxjs-interop";` passes
    `rxjs-no-signal-imports`; `import { signal } from "@preact/signals-core";`
    fails it; `private readonly s = new Subject<number>();` and
    `protected readonly s = new Subject<number>();` pass
    `rxjs-no-exposed-subjects`, and `readonly s = new Subject<number>();`
    fails it; `of(1).subscribe();` as a statement fails
    `rxjs-kept-subscriptions`, and `return of(1).subscribe();` passes;
    `subscriber.next(v)` inside `new Observable(...)` inside a `subscribe`
    callback passes `rxjs-relay`; `this.#out.next(v)` in a `subscribe`
    callback, with `#out = new Subject<number>()`, fails it;
    `cache.set(k, v)` in a `subscribe` callback passes it.
  - `telemetry pins the escapes and displacements`, `it.each`
    `[id, source, status]`, every status `pass`:
    - escape, `rxjs-no-signal-imports`: `import { ref } from "@vue/reactivity"; export const n = ref(0);`
    - escape, `rxjs-no-exposed-subjects`: `const open$ = new BehaviorSubject(0); export function getOpen() { return open$; }`
    - displaced, `rxjs-kept-subscriptions`: `const _ = of(1).subscribe();`
    - escape, `rxjs-nested-subscribe`: an inner `subscribe` in a named function that the outer callback calls
    - displaced, `rxjs-relay`: `of(1).pipe(tap((v) => out.next(v))).subscribe()` as a kept `const`
    - escape, `rxjs-relay`: `const o = out;` then `o.next(v)` in the callback
- [ ] **Step 2: Write** `test/rxjs-declarative-pack.scaling.test.ts` with
  `guardrailIds("rxjs-declarative", '["src/**"]')`.
- [ ] **Step 3: Run** `npx vitest run --maxWorkers=2 test/rxjs-declarative-pack.test.ts`.
  Expected: FAIL, pack not found.
- [ ] **Step 4: Write** `pack.yaml` and `eslint.js`.
- [ ] **Step 5: Run** `npx vitest run --maxWorkers=2 test/rxjs-declarative-pack.test.ts test/rxjs-declarative-pack.scaling.test.ts`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 7: Pack `signals` and the conflict pair

**Files:**
- Create: `packs/signals/pack.yaml`
- Modify: `packs/rxjs-declarative/pack.yaml`, the `conflictsWith` of
  `rxjs-state-is-observable`, to `[signals-state-is-signal]`
- Test: `test/signals-pack.test.ts`, `test/signals-pack.scaling.test.ts`

**Interfaces:**
- Consumes: `practicesElsewhere` and `checkConsistency(set, elsewhere)`
  from Task 1, `conflict-scope` and the folder overlap from Task 2,
  `rxjs-state-is-observable` from Task 6.
- Produces: pack `signals`, `layer: 7`, Terms `signal`, `computed-signal`,
  `signal-effect`, and `signal-bridge`, with the design's definitions.

One Practice, `signals-state-is-signal`: "State that changes over time is a
signal; code makes no RxJS subject." Terms `[signal]`, `paths: [NON_TEST]`,
`conflictsWith: [rxjs-state-is-observable]`. One Guardrail,
`signals-no-subjects`: kind `lint`, `runs: [edit, commit]`,
`budgetMs: 5000`, `eslint:no-restricted-imports` with
`{ paths: [{ name: "rxjs", importNames: ["Subject", "BehaviorSubject", "ReplaySubject", "AsyncSubject"], message }] }`.
Message: "Changing state is a signal. Hold the state in signal(), and turn an observable into a signal with toSignal."
Examples are the design's SIG-1 must-fail and must-pass.

- [ ] **Step 1: Write the failing test** `test/signals-pack.test.ts`. Every
  consistency call is `checkConsistency(set, await practicesElsewhere(set, wardenRoot))`.
  - `signals alone is consistent and its examples hold`: `core` on
    `["**/*.ts"]`, `signals` on `["src/**"]`. Findings `[]`, examples `[]`.
  - `rxjs-declarative alone is consistent`, scoped the same way: `[]`. This
    is E1: the other pack is off.
  - `both packs on disjoint folders are consistent and their examples hold`:
    `rxjs-declarative` on `["src/rx/**"]`, `signals` on `["src/sig/**"]`.
  - `both packs on nested folders are refused once, and the next action clears it`:
    `rxjs-declarative` on `["src/**"]`, `signals` on `["src/sig/**"]`. One
    `conflict-overlap`, record `rxjs-state-is-observable`. Applying its next
    action (`signals` to `["lib/sig/**"]`) gives `[]`.
  - `a conflicting pack on a file glob is refused, and the next action clears it`:
    `signals` on `["**/*.ts"]` gives `conflict-scope`; `["src/**"]` gives
    `[]`.
  - `each form's violation is the other form's compliant code`: load both
    packs on `["src/**"]` and run their Guardrails directly, with no
    consistency call. RX-1's `mustFail` fails `rxjs-no-signal-imports` and
    passes `signals-no-subjects`. SIG-1's `mustFail` fails
    `signals-no-subjects` and passes `rxjs-no-signal-imports`. Both
    `mustPass` examples pass both Guardrails, so the bridge stays legal.
    Read the examples from the loaded records.
  - `telemetry pins the escape`: `export const make = () => { const ls: (() => void)[] = []; return new Observable<number>(() => { ls.push(() => undefined); }); };`
    with `import { Observable } from "rxjs";` passes `signals-no-subjects`.
- [ ] **Step 2: Write** `test/signals-pack.scaling.test.ts` with
  `guardrailIds("signals", '["src/**"]')`.
- [ ] **Step 3: Run** `npx vitest run --maxWorkers=2 test/signals-pack.test.ts`.
  Expected: FAIL, pack not found.
- [ ] **Step 4: Write** `packs/signals/pack.yaml`, and set RX-1's
  `conflictsWith`.
- [ ] **Step 5: Run** `npx vitest run --maxWorkers=2 test/signals-pack.test.ts test/signals-pack.scaling.test.ts test/rxjs-declarative-pack.test.ts test/rxjs-declarative-pack.scaling.test.ts`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 8: Pack `declarative-ui`

**Files:**
- Create: `packs/declarative-ui/pack.yaml`
- Test: `test/declarative-ui-pack.test.ts`, `test/declarative-ui-pack.scaling.test.ts`

**Interfaces:**
- Produces: pack `declarative-ui`, `layer: 8`, Terms `view` (bans
  `widget`), `view-state`, `react-effect`, and `bridge-hook`, with the
  design's definitions. `bridge-hook` is identified by path, a `bridges/`
  folder (Q1 (a)).

Every Practice has
`paths: ["!**/{bridges/**,*.test.*,*.spec.*,*.stories.*,test/**,tests/**,__tests__/**,e2e/**}"]`.
Every Guardrail is kind `lint`, `runs: [edit, commit]`, `budgetMs: 5000`,
`eslint:no-restricted-syntax`, with the design's selectors, each with
`message`:

| Practice and statement | Guardrail | Message |
|---|---|---|
| `declarative-ui-reads-through-bridge-hooks`: A view reads changing state through a bridge-hook; a react-effect never calls subscribe. | `declarative-ui-subscribe-in-effect` | "A react-effect never subscribes. Read the observable with a bridge-hook such as useObservableState, or move this hook into a bridges folder." |
| `declarative-ui-derives-while-rendering`: A react-effect never sets view-state directly in its body; a value derived from inputs is computed while rendering. | `declarative-ui-set-in-effect` | "A react-effect never sets view-state directly. Compute the value while rendering, or with useMemo." |
| `declarative-ui-dom-by-rendering`: A view never queries the document and never writes markup or classes on an element directly. | `declarative-ui-dom-writes` | "A view changes the DOM only by rendering. Render the markup or className from state." |

Examples are the design's UI-1 to UI-3 must-fail and must-pass sources.

- [ ] **Step 1: Write the failing test** `test/declarative-ui-pack.test.ts`.
  Config: `core` and `declarative-ui`, both on
  `["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]`.
  - `is consistent and its examples hold`.
  - `it.each` cases `[id, file, source, status]`: UI-1's must-fail in
    `src/ui/bridges/useN.ts` passes; the same in `src/ui/useN.tsx` fails;
    a `setD` inside a callback the effect registers
    (`const id = setInterval(() => setD(1), 10)`) passes
    `declarative-ui-set-in-effect`; a `setD` in an expression-bodied effect
    (`useEffect(() => setD(1), [])`) fails it; `ref.current?.focus()` passes
    `declarative-ui-dom-writes`; `el.innerHTML = html` fails it;
    `document.getElementById("a")` fails it.
  - `telemetry pins the escapes`, `it.each` `[id, source, status]`, every
    status `pass`:
    - escape, `declarative-ui-subscribe-in-effect`: `useEffect(() => start(n$), [n$])`, where `start` is a module function that subscribes
    - escape, `declarative-ui-set-in-effect`: `useEffect(() => { queueMicrotask(() => setD(n * 2)); }, [n])`
    - escape, `declarative-ui-dom-writes`: `ref.current?.setAttribute("a", "b")` and `document.body.append(node)`
- [ ] **Step 2: Write** `test/declarative-ui-pack.scaling.test.ts` with
  `guardrailIds("declarative-ui", CODE_PATHS)`.
- [ ] **Step 3: Run** `npx vitest run --maxWorkers=2 test/declarative-ui-pack.test.ts`.
  Expected: FAIL, pack not found.
- [ ] **Step 4: Write** `packs/declarative-ui/pack.yaml`.
- [ ] **Step 5: Run** `npx vitest run --maxWorkers=2 test/declarative-ui-pack.test.ts test/declarative-ui-pack.scaling.test.ts`.
  Expected: PASS.
- [ ] **Step 6: Commit.**

### Task 9: All four packs together, and their Evidence

**Files:**
- Create: `test/style-packs.test.ts`
- Modify: `docs/design/2026-11-19-style-and-typescript-packs-design.md`, a
  new last section

**Interfaces:**
- Consumes: every pack above; `runInit`, `compile`, and `runCheck`, set up
  the way `test/runner/check.test.ts` sets them up; `readEvidence` from
  `src/runner/evidence.ts`.

- [ ] **Step 1: Write the test** `test/style-packs.test.ts`. Config: `core`
  and `typescript` on `["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]`,
  `rxjs-declarative` on `["src/rx/**"]`, `signals` on `["src/sig/**"]`, and
  `declarative-ui` on `["src/ui/**"]`.
  - `the four packs are consistent and every mustPass passes every other Guardrail on its path`:
    consistency with `practicesElsewhere` and `runExamples` both `[]`. This
    is the design's "Left to the builder" condition on examples.
  - `every new Guardrail records fired and cost Evidence`: derive the
    Guardrail list from the loaded records of the four new packs. For each,
    write its `mustFail` at a path inside its pack's folder, run
    `runCheck` at tier `commit`, and expect exit 1. `readEvidence` then
    holds, for each Guardrail id, a `fired` row with `status: "fail"` and a
    `cost` row with a numeric `ms`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 test/style-packs.test.ts`.
  Expected: PASS. Record that it fails on the base commit, where the packs
  do not exist.
- [ ] **Step 3: Add** a section **Built in version 1** to the end of the
  design doc. Name the shipped Guardrails, the deferred engine gaps E4 and
  E6 to E9 and the rest of E5, and the design gaps below with what was done
  about each.
- [ ] **Step 4: Commit.**

## Release proof (controller, not a task)

1. Run `npm run build:dist`, then confirm `git status` shows no dist drift
   after commit.
2. In a scratch git repo with `WARDEN_HOME` set to a scratch folder, install
   Warden from this branch and run `warden packs`. Expected: rows for
   `typescript`, `rxjs-declarative`, `signals`, and `declarative-ui` with
   their lint and type counts.
3. Run `warden init --packs core,rxjs-declarative,signals` with both packs on
   `src/**`. Expected: exit 2 and one `conflict-overlap` next action.
   Follow it, and expect exit 0.
4. For one Guardrail per pack, `warden check <file> --rule <id>` on its
   `mustFail` and its `mustPass`. Expected: exit 1, then exit 0.
5. Record the commands and exit codes in the plan's bead.

## Design gaps found while planning

1. **Five TS-1 flags ship, not four.** The version split says "four mapped
   flags", but Q2 (a) ships exact optional properties now. All five flags
   already have diagnostic codes (`src/adapters/tsc.ts:14-28`). The plan
   ships five.
2. **`exactOptionalPropertyTypes` needs `strictNullChecks`.** Without it, tsc
   prints TS5052 with no file position, and the adapter crashes. The design
   does not name it. Task 4 is the E5 slice that fixes it.
3. **The conflict goal contradicts the Practices.** The Goals say each
   pack's must-pass example fails the other pack's Guardrail. RX-1 and SIG-1
   say each must-pass passes the other, because the bridge stays legal.
   Task 7 tests the checkable form: each form's must-fail is the other
   form's compliant code, and both must-pass examples pass both Guardrails.
4. **A conflicting pack cannot cover the whole repository.** E2 refuses
   empty paths and every glob that is not `<folder>/**`, so `**` is refused
   even when the other pack is off. The plan builds E2 as written. A
   project with RxJS at its root must list its top folders.
5. **E3 also breaks examples and bench.** Both place files by a scope's
   literal text, so `[[]plugins]/**` would place them outside the scope.
   Task 3 decodes `[[]`. The design's unverified claim that ESLint accepts
   `[[]name]` holds for Warden's `minimatch` in a scratch run; Task 3 makes
   it a test.
6. **The conflict findings have no next action.** `undefined-conflict` and
   `conflict-overlap` end without one today
   (`src/compiler/consistency.ts:84`, `:94`). Tasks 1 and 2 add one each.
7. **Telemetry has no record field.** The Guardrail schema has no telemetry
   property, and only `fired`, `cost`, and `stalled` exist. The plan pins
   each escape and displacement shape as a test, and proves the Evidence
   rows in Task 9.
