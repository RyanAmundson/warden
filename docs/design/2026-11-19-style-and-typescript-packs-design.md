# Warden style and language packs: typescript, rxjs-declarative, signals, and declarative-ui

Status: approved by Ryan, November 19, 2026 ("Accept all (Recommended)": every open question takes its recommendation). Not built yet.
No task is filed for it yet.

Builds on:

- The Warden design spec,
  [`2026-11-18-warden-guardrail-framework-design.md`](2026-11-18-warden-guardrail-framework-design.md),
  especially [The model](2026-11-18-warden-guardrail-framework-design.md#the-model-seven-record-types),
  [Layers](2026-11-18-warden-guardrail-framework-design.md#layers),
  [Adapters](2026-11-18-warden-guardrail-framework-design.md#adapters-how-records-reach-real-tools),
  and [The learning layer](2026-11-18-warden-guardrail-framework-design.md#the-learning-layer).
- The approved [principles pack](2026-11-18-warden-principles-pack-design.md)
  and [architecture pack](2026-11-18-warden-architecture-pack-design.md), whose
  structure this document copies.
- Ryan's vocabulary, `~/.agents/instructions/vocabulary/data-flow-and-state.md`:
  Subscription model, Reactive composition, Sources pipelines database UI,
  Subscribe don't add a channel, and Empty stream is the correct empty state.

## Intent

The framework lists `typescript` as the language pack and `rxjs-declarative`,
`signals`, and `declarative-ui` as style packs that apply "per path scope"
(framework design, line 227), with `rxjs-declarative` and `signals` as the
example of Practices that conflict (line 74).

Ryan's recorded position (vocabulary, Subscription model, November 10, 2026):
an RxJS Observable and a signal are two forms of one subscription model, and
he treats them as interchangeable; a function such as `toSignal` bridges them.
So these packs do not pick a winner. Each path picks one form, the bridge
between forms stays legal, and compile refuses two forms on one path.

## Goals

- Each pack ships only Practices that a static Guardrail can prove today, or
  names the exact engine change that blocks it.
- Every Guardrail number in this document was measured on a real consumer.
- The `rxjs-declarative` and `signals` conflict is a real, checkable conflict:
  compile finds it through `conflictsWith` and the pack scopes, and each
  pack's must-pass example passes both packs' Guardrails.

## Non-goals

- Angular template rules. `declarative-ui` covers React views only, because
  its measured consumer is React. See [declarative-ui Q2](#open-questions-for-ryan-3).
- A project's own rules. They are project concepts and belong in that
  project's own pack.
- Building any engine change. This document names them; Warden's owner builds
  them.

## How this was measured

Nothing ran inside a consumer checkout that writes files. Every run used
Warden's own `eslint` 9.39.5, `typescript-eslint` 8.73.0, and `typescript`
5.9.3, from a script and tsconfig files in a scratch folder, with
`overrideConfigFile: true` and inline configuration off, the way Warden's
ESLint adapter runs (`src/adapters/eslint.ts:151-164`).

| Consumer | Files |
|---|---|
| A React and TypeScript codebase, called "the React codebase" below | 5,680 tracked `.ts`/`.tsx` files, less `.d.ts` and build output |
| An Angular 20 signals codebase, the only one the search found, called "the Angular codebase" below | 328 |

- Each candidate Guardrail ran as its own namespaced copy of a core rule, as
  Warden does, in one ESLint pass: 19 s for all 5,680 files and 15 rules.
- Two consecutive runs differed by a few hits (8,172 against 8,178
  assertions), because other sessions changed the React codebase's checkout
  during the runs. Treat every count as accurate to about 0.1%.
- "Non-test" means a path with no `.test.`, `.spec.`, or `.stories.` part and
  no `test/`, `tests/`, `__tests__/`, or `e2e/` folder.
- `tsc` counts compare a run of each program with its own tsconfig against a
  run that adds the flags. The React codebase has two programs: the renderer
  program, `tsconfig.json`, and an Electron main-process program with its own
  tsconfig, which already had 309 errors under TypeScript 5.9.3, so its counts
  are new errors only.
- Typed rules ran on a sample: every third of the 348 literal, non-test file
  entries in `tsconfig.json`'s `include`, so 116 files, in 12.7 s.
- The graph at `graphify-out/graph.json` does not exist in either checkout,
  so the search used `git grep` and the scratch ESLint runs.

## Engine gaps

Each gap was checked against Warden at `670f2c5` (0.1.11). The conflict
behavior was run against `dist/src/compiler/consistency.js` with two-pack
record sets.

| # | Gap | Evidence | Blocks | Proposed change |
|---|---|---|---|---|
| E1 | A `conflictsWith` that names a Practice in a pack the project has not enabled fails compile with `undefined-conflict`, because `checkConsistency` sees only enabled packs. | `src/compiler/consistency.ts:80-85`; `readRecordSet` keeps only listed packs (`src/records/load.ts:153-165`). Run: `rxjs-declarative` alone gives `undefined-conflict`. | Any project that enables one of the two conflicting packs. | Resolve `conflictsWith` against every bundled and local pack. Report `undefined-conflict` only when no pack defines the id; skip the overlap check when the other pack is off. |
| E2 | The overlap test compares the literal text before the first `*`. It misses real overlaps and invents false ones. | `src/compiler/consistency.ts:27-37`. Runs: `src/{ui,core}/**` against `src/ui/**` gives no finding; `!src/ui/**` against `src/ui/**` reports an overlap; two packs with empty `paths`, which apply everywhere (`src/records/paths.ts:23`), give no finding. | The promise that "compile must refuse overlapping paths." | For Practices with a `conflictsWith`, require each pack entry's paths to be plain folder scopes, `<literal folder>/**`, and refuse any other shape, including an empty list, with a next action. Two plain scopes overlap exactly when one folder contains the other, so the test is exact for present and future files. |
| E3 | Node's `matchesGlob` reads `[plugins]` as a character class and does not honor `\[`; ESLint's matcher does honor `\[`, and the React codebase's ESLint config uses it. Warden hands one glob to both. | Run: `matchesGlob("[plugins]/a/b.ts", "\\[plugins\\]/**")` is `false`; `"[[]plugins]/**"` is `true`. The React codebase's ESLint config uses `\\[plugins\\]`. | Scoping any pack to a bracketed collection, which is every scope in the React codebase. | Compile refuses a backslash in a pack glob and names the `[[]name]` form. Not verified: that ESLint's matcher also accepts `[[]name]`. |
| E4 | The `tsc` adapter checks one whole program, the project's root `tsconfig.json`, and ignores Practice and pack paths. | `src/adapters/tsc.ts:43` (`extends: "../../tsconfig.json"`); `run` never filters by path. A second program, such as the React codebase's Electron program (1,055 `include` entries, no `extends`), is never checked. | Any `type` Guardrail on a second program, such as an Electron main process; any per-path `tsc` scope. | A pack setting or config field that names the tsconfig files to extend, one emitted tsconfig and one worker run each. Path scoping of `tsc` stays out of scope: compiler flags are per program. |
| E5 | `tsc` flags are attributed by diagnostic code. `noUncheckedIndexedAccess` has no entry and reuses `strictNullChecks` codes 2532 and 18048; `useUnknownInCatchVariables` (18046) has none; codes 1000 to 1999 count as parse errors, so `verbatimModuleSyntax` (1484, 1485) cannot be a Guardrail. | `src/adapters/tsc.ts:14-28` and `:118`. | `typescript-unchecked-index`. | Attribute by a second program run without the flag, or by position, the way `noUnusedParameters` is split today (`src/adapters/tsc-worker.ts:17-31`). |
| E6 | No typed linting. The parser runs without `project` or `projectService`. | `src/adapters/eslint.ts:156`. | Promise and exhaustiveness rules; typed versions of the name-based rules below. | Give the ESLint pass `parserOptions.projectService` for Guardrails of kind `type`, in their own pass at `commit` with a `tsc`-sized budget. The sample above cost 12.7 s for 116 files, over the 5 s `edit` budget. |
| E7 | Only ESLint core rules, `warden/*`, and rules a Warden pack ships can run. `@typescript-eslint/*` and third-party plugins cannot. | `src/adapters/eslint.ts:131`, `:139-150`. | `typescript-eslint` rules (already a Warden dependency, `package.json`), `eslint-plugin-react-hooks`, `eslint-plugin-rxjs-x`. | Load `typescript-eslint`'s plugin by namespace. Third-party plugins are a decision for Ryan (see the open questions). |
| E8 | A `review` Guardrail cannot be a record. Every kind except `instruction` needs an adapter and runnable examples. | `src/compiler/examples.ts:72-75` and `:91-92`. | The "left to review" rows of every pack. | The decision-model adapter, or a `review` adapter. Until then those rows stay in this document, as the principles pack did. |
| E9 | The help-versus-harm signals do not exist. Evidence has no `resolved`, `disputed`, `escaped`, or `hollow` kind, and there is no `warden dispute` command. | `src/runner/evidence.ts:8`; commands in `src/cli/main.ts`. | Every [Telemetry](#telemetry-help-versus-harm) row's "helped" and "upheld disputes" columns. | Build the planned kinds, and one new kind, `displaced`, defined below. |

A Practice's `paths` are alternatives, not conditions (`src/records/paths.ts:3-7`),
so "TSX files that are not tests" can only be written as one negated glob.
The packs below use one negated brace glob per Practice, as the architecture
pack does. This is a limit, not a blocker.

## Telemetry: help versus harm

Ryan wants to see, per Guardrail, whether it does more good than harm. Each
pack section ends with a table of three columns:

- **Helped:** `resolved`, a failure followed by a passing change to the same
  file with no Guardrail change (framework design, The learning layer).
- **Harmed:** an upheld `disputed` ruling (a false positive), `cost` per run
  against `budgetMs`, `stalled` sessions, and `displaced` fixes.
- **Escape:** the shape of a violation the Guardrail misses, which a later
  review records as `escaped` and a mutation of the must-fail example
  records as `hollow`.

One new Evidence kind is needed:

- **`displaced`.** The runner writes it when a change resolves a violation of
  one Guardrail and, in the same file and run, adds a violation of a sibling
  Guardrail in the same Practice or pack. Example: `x!` becomes `x as T`, or
  a subscription in an effect moves into a `subscribe` that is never kept.
  It is computed from `fired` Evidence of one run, so it needs no model. A
  `displaced` fix is harm: the agent learned to move the problem, not fix it.

All thresholds that turn these signals into proposals are settings, as the
framework design says.

## Layers

| Layer | Pack | Uses Terms from |
|---|---|---|
| 0 | core | |
| 1 | architecture | |
| 2 | principles | |
| 3 | collection-folders | |
| 4 | folder-json | |
| **5** | **typescript** | none |
| **6** | **rxjs-declarative** | none |
| **7** | **signals** | none |
| **8** | **declarative-ui** | none |

Warden refuses two packs on one layer (`src/compiler/consistency.ts:116-123`),
and the framework puts language packs below style packs. No pack here uses
another's Terms, so any of them can be enabled alone. Term ids are global, so
each pack prefixes the ones that could collide: `signal-effect` and
`react-effect`, not two Terms named `effect`.

---

## Pack `typescript`

### Purpose and Terms

The compiler checks everything it can, and code never tells it to stop.

| Term | Definition | Bans |
|---|---|---|
| `escape-hatch` | A construct that tells the compiler to stop checking a value: the `any` type, a non-null assertion (`x!`), or a type assertion (`x as T`, `<T>x`) other than `as const`. | `cast` |
| `floating-promise` | A Promise that is neither awaited, returned, nor given a rejection handler. | |

### Practices

Paths for TS-2 to TS-4: `"!**/{*.test.*,*.spec.*,*.stories.*,test/**,tests/**,__tests__/**,e2e/**}"`,
pending [Q1](#open-questions-for-ryan). TS-1 is per program (E4).

#### TS-1. `typescript-strict-compiler`: The compiler runs with every strictness flag on

- **Statement:** The compiler checks null, implicit `any`, implicit returns,
  overrides, optional properties, and indexed access.
- **Compliant:** the React codebase's `tsconfig.json` sets `"strict": true`,
  so `strictNullChecks` and `noImplicitAny` already pass in the renderer.
- **Violating:** with `noPropertyAccessFromIndexSignature`, a Storybook file in
  the React codebase fails TS4111.
- **Guardrails,** each kind `type`, `runs: [commit]`, `budgetMs: 60000` (the
  `principles-unused-parameters` value):

| Guardrail | Implementation | Ships |
|---|---|---|
| `typescript-strict-null` | `tsc:strictNullChecks` | v1 |
| `typescript-no-implicit-any` | `tsc:noImplicitAny` | v1 |
| `typescript-implicit-returns` | `tsc:noImplicitReturns` | v1 |
| `typescript-implicit-override` | `tsc:noImplicitOverride` | v1 |
| `typescript-exact-optional` | `tsc:exactOptionalPropertyTypes` | v1, pending [Q2](#open-questions-for-ryan) |
| `typescript-index-signature-access` | `tsc:noPropertyAccessFromIndexSignature` | not recommended, [Q2](#open-questions-for-ryan) |
| `typescript-unchecked-index` | `tsc:noUncheckedIndexedAccess` | v2, after E5 |

- **Must fail:** `export const first = (xs: number[]): number => { if (xs.length > 0) return xs[0]; };`
  for implicit returns, and one such file per flag.
- **Must pass:** the same function with a final `return 0;`.

#### TS-2. `typescript-no-escape-hatches`: Code uses no escape-hatch

- **Statement:** Code uses no escape-hatch.
- **Compliant:** a check runner in the React codebase uses
  `as const satisfies ReadonlyArray<…>`, which checks the value instead of
  asserting it.
- **Violating:** a database module (`ReadOnlyRxCollection<any>`) and a CLI
  command (`channel!`) in the React codebase.
- **Guardrails,** each kind `lint`, `runs: [edit, commit]`, `budgetMs: 5000`,
  a copy of core `no-restricted-syntax`. They use selectors, not
  `@typescript-eslint/no-explicit-any` and its siblings, because the selectors
  run today (E7) and match the same AST nodes:

| Guardrail | Options |
|---|---|
| `typescript-no-any` | `["TSAnyKeyword"]` |
| `typescript-no-non-null` | `["TSNonNullExpression"]` |
| `typescript-no-assertion` | `["TSAsExpression:not([typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='const'])", "TSTypeAssertion"]` |

- **Must fail:** `export const n = (v: unknown): number => v as number;`
- **Must pass:** `export const n = (v: unknown): number => (typeof v === "number" ? v : 0);`

#### TS-3. `typescript-promises-handled`: No floating-promise

- **Statement:** No floating-promise, and no Promise where the caller expects
  no result.
- **Compliant:** in the 116-file sample, no `no-floating-promises` hit.
- **Violating:** a plugin logger in the React codebase passes the
  Promise-returning `flush` to `pending.delete`, a `no-misused-promises` hit.
- **Guardrails,** kind `type`, `runs: [commit]`, `budgetMs: 60000`, v2 after
  E6 and E7: `eslint:@typescript-eslint/no-floating-promises` and
  `eslint:@typescript-eslint/no-misused-promises`, default options.
- **Must fail:** `const save = async (): Promise<void> => {}; save();`
- **Must pass:** `const save = async (): Promise<void> => {}; await save();`

#### TS-4. `typescript-exhaustive-switch`: A switch over a union names every member

- **Statement:** A `switch` over a union type has a case for every member.
- **Compliant / violating:** 0 hits in the 116-file sample; no `assertNever`
  helper exists in the React codebase.
- **Guardrail,** kind `type`, `runs: [commit]`, `budgetMs: 60000`, v2 after E6
  and E7: `eslint:@typescript-eslint/switch-exhaustiveness-check` with
  `{ considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: false }`.
  The first option stops a `default` from hiding a new member.
- **Must fail:** `type K = "a" | "b"; export const f = (k: K): number => { switch (k) { case "a": return 1; default: return 0; } };`
- **Must pass:** the same with `case "b": return 0;` and no `default`.

### What it flags in the React codebase

| Guardrail | Non-test hits (files) | All hits (files) |
|---|---|---|
| `typescript-strict-null`, `typescript-no-implicit-any` | 0, renderer program | 0 |
| `typescript-implicit-returns` | 4 renderer, 2 Electron | 4 (4) renderer, 2 (2) Electron |
| `typescript-implicit-override` | 15 renderer, 1 Electron | 25 (12) renderer, 1 (1) Electron |
| `typescript-exact-optional` | 594 renderer, 331 Electron | 860 (344) renderer, 386 (136) Electron |
| `typescript-index-signature-access` | 7,043 renderer, 4,269 Electron | 7,819 (675), 5,478 (383) |
| `typescript-unchecked-index` (approximate: new TS2532, TS18048, TS2538, TS2345, and TS2322 errors not about optional properties) | 1,233 renderer, 868 Electron | 3,358 (511), 1,852 (291) |
| `typescript-no-any` | 168 (38) | 593 (153) |
| `typescript-no-non-null` | 852 (227) | 5,205 (941) |
| `typescript-no-assertion` | 2,857 (817) | 8,178 (1,954) |
| `typescript-promises-handled` | 2 in the 116-file sample | |
| `typescript-exhaustive-switch` | 0 in the 116-file sample | |

The Electron counts are what E4 would let Warden see; today's adapter checks
the renderer program only. A project's baseline absorbs these at adoption.

### Layer, dependencies, and conflicts

Layer 5. Depends on no pack. Conflicts with none. TS-2 overlaps `core`'s
`no-suppressions` by intent only: `@ts-ignore` is a comment, which `core`
already bans.

### Left to review

- Whether a type is precise or merely wide, such as `Record<string, unknown>`
  where a union belongs. Ryan's settled preference ("enums where they fit;
  never a bare string") has no static proxy.

### Telemetry, help versus harm

| Guardrail | Helped | Harmed | Escape looks like |
|---|---|---|---|
| `tsc` flag Guardrails | `resolved` per diagnostic | `cost` per run against 60 s, measured 30 to 36 s for the renderer program; `stalled` on a file that keeps the same diagnostic | the error moves into a program Warden does not check (E4), or into a file the root tsconfig does not include, which the framework's known limit already names |
| `typescript-no-any` | `resolved` | upheld `disputed` where a library type forces `any`; `displaced` to `unknown as T` | `Function`, `object`, or `{}` used as a wide type |
| `typescript-no-non-null` | `resolved` | `displaced` to `as T` or to `?? (undefined as never)` | `if (!x) throw` dead branches added only to narrow |
| `typescript-no-assertion` | `resolved` | upheld `disputed` for DOM and test fixtures; `displaced` to a generic that returns `T` unchecked | a helper `function cast<T>(v: unknown): T` |
| `typescript-promises-handled` | `resolved` | `cost` (typed lint); `displaced` to `void promise`, which hides the rejection | a Promise stored in a field and never read |
| `typescript-exhaustive-switch` | `resolved` | `displaced` to a `default` added only to pass | an `if` chain over the union instead of a `switch` |

### Open questions for Ryan

1. **Q1. Do TS-2 to TS-4 cover test files?** Options: (a) all files, 13,976
   hits to baseline; (b) non-test only, 3,877; (c) non-test, plus `any` in
   tests. **Recommendation: (b).** Test fixtures assert shapes on purpose, the
   baseline is a third the size, and a later Guardrail can tighten tests.
2. **Q2. Which extra compiler flags ship?** Options: (a) implicit returns,
   override, and exact optional properties now, unchecked index after E5,
   index-signature access never; (b) all six; (c) only implicit returns and
   override. **Recommendation: (a).** Exact optional properties and
   unchecked index catch real `undefined` bugs; index-signature access only
   changes `a.b` to `a["b"]` 7,819 times and catches no bug the others miss.
3. **Q3. Load `typescript-eslint`'s plugin rules (E7) now, or keep
   `no-restricted-syntax` selectors?** Options: (a) selectors in v1, the plugin
   only with typed linting in v2; (b) the plugin for everything in v1.
   **Recommendation: (a).** Selectors need no engine change and match the
   same nodes; the plugin's value is its typed rules, which need E6 anyway.

---

## Pack `rxjs-declarative`

### Purpose and Terms

State that changes over time is an Observable composed with operators. Code
subscribes once, at the edge, and keeps every subscription so it can end.

| Term | Definition | Bans |
|---|---|---|
| `observable` | An RxJS `Observable`: a value the reader subscribes to and that pushes each change. | `stream` (as a type name) |
| `subject` | An RxJS `Subject`, `BehaviorSubject`, `ReplaySubject`, or `AsyncSubject`: an observable that code can push values into. | |
| `subscription` | The result of calling `subscribe` on an observable, which ends the subscription when `unsubscribe` is called. | |
| `operator` | A function passed to `pipe` that turns one observable into another. | |

### Practices

Paths for every Practice: `"!**/{*.test.*,*.spec.*,*.stories.*,test/**,tests/**,__tests__/**,e2e/**}"`.
The project's pack entry scopes the pack to folders (E2), for example
`"[[]plugins]/**"`.

#### RX-1. `rxjs-state-is-observable`: Changing state is an observable

- **Statement:** State that changes over time is an observable, never a
  signal.
- **`conflictsWith`:** `[signals-state-is-signal]`.
- **Compliant:** all of the React codebase: 0 signal imports.
- **Violating:** a store in the Angular codebase imports `signal` and
  `computed` from `@angular/core`.
- **Guardrail** `rxjs-no-signal-imports`, kind `lint`, `runs: [edit, commit]`,
  `budgetMs: 5000`: core `no-restricted-imports` with
  `{ paths: [{ name: "@angular/core", importNames: ["signal", "computed", "effect", "linkedSignal"] }], patterns: ["@preact/signals*"] }`.
  `toSignal` and `toObservable` live in `@angular/core/rxjs-interop`, so the
  bridge stays legal.
- **Must fail:** `import { signal } from "@angular/core"; export const count = signal(0);`
- **Must pass:** `import { Observable, of } from "rxjs"; export const count: Observable<number> = of(0);`
  It must not import a `subject`, so it also passes `signals-state-is-signal`
  wherever the compile-time cross-check runs both.

#### RX-2. `rxjs-subjects-stay-private`: A subject is never exported or public

- **Statement:** A subject is never exported and never a public class
  property; code outside its owner reads an observable.
- **Compliant:** a slot registry in the React codebase holds
  `new BehaviorSubject(0)` in a local `const`.
- **Violating:** a dialog module
  (`export const openDialogs = new BehaviorSubject…`) and a source registry
  class (`readonly state = new BehaviorSubject…`) in the React codebase.
- **Guardrail** `rxjs-no-exposed-subjects`, kind `lint`, `runs: [edit, commit]`,
  `budgetMs: 5000`: core `no-restricted-syntax` with
  `["ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > NewExpression[callee.name=/Subject$/]", "PropertyDefinition:not([accessibility='private']):not([accessibility='protected']):not([key.type='PrivateIdentifier']) > NewExpression[callee.name=/Subject$/]"]`.
- **Must fail:** `import { BehaviorSubject } from "rxjs"; export const open$ = new BehaviorSubject(0);`
  That example imports a `subject`, so it would fail `signals-state-is-signal`
  too; must-fail examples are not cross-checked (`src/compiler/examples.ts:118-131`).
- **Must pass:** a class with `readonly #open = new BehaviorSubject(0);` and
  `readonly open$ = this.#open.asObservable();`.
- **Limit:** a subject returned from an exported function passes; the typed
  check waits for E6.

#### RX-3. `rxjs-subscriptions-kept`: Every subscription is kept

- **Statement:** The subscription that `subscribe` returns is always kept,
  so the code can end it.
- **Compliant:** a root component in the React codebase keeps
  `const subscription` and returns `subscription.unsubscribe()`.
- **Violating:** a main-process registration module in the React codebase
  discards the result of `combineLatest([...]).subscribe(...)`.
- **Guardrail** `rxjs-kept-subscriptions`, kind `lint`, `runs: [edit, commit]`,
  `budgetMs: 5000`: core `no-restricted-syntax` with
  `["ExpressionStatement > CallExpression[callee.property.name='subscribe']"]`.
- **Must fail:** `import { of } from "rxjs"; of(1).subscribe(() => undefined);`
- **Must pass:** `import { of } from "rxjs"; export const kept = of(1).subscribe(() => undefined);`
- **Limit:** it matches the name `subscribe`, so a discarded store
  subscription, such as Zustand's, fails too. That is also a leak, so the
  statement holds.

#### RX-4. `rxjs-no-nested-subscribe`: Code never subscribes inside a subscribe callback

- **Statement:** Code never calls `subscribe` inside a `subscribe` callback;
  it composes with an operator such as `switchMap`.
- **Compliant:** the React codebase's live-query hook uses `switchMap`.
- **Violating:** a module in the React codebase that starts installed bundles
  subscribes inside an outer `subscribe` callback.
- **Guardrail** `rxjs-nested-subscribe`, kind `lint`, `runs: [edit, commit]`,
  `budgetMs: 5000`: core `no-restricted-syntax` with
  `["CallExpression[callee.property.name='subscribe'] CallExpression[callee.property.name='subscribe']"]`.
- **Must fail:** `import { of } from "rxjs"; export const s = of(1).subscribe(() => { const t = of(2).subscribe(); t.unsubscribe(); });`
- **Must pass:** `import { of, switchMap } from "rxjs"; export const s = of(1).pipe(switchMap(() => of(2))).subscribe();`

#### RX-5. `rxjs-no-relay`: A subscribe callback never pushes into a subject

- **Statement:** A `subscribe` callback never calls `next` on a subject;
  derived values come from an operator.
- **Compliant:** the same live-query hook derives with `switchMap`.
- **Violating:** the dialog module (`openDialogs.next(...)` inside a
  `subscribe` callback), and the bundle-starting module (`onRuns.next`,
  `running.next`, and `boundSources.next` inside one).
- **Guardrail** `rxjs-relay`, kind `lint`, `runs: [edit, commit]`,
  `budgetMs: 5000`: a rule the pack ships, `eslint:rxjs-declarative/no-relay`,
  in `packs/rxjs-declarative/eslint.js`. It uses scope analysis to fail only
  when the receiver of `next` resolves to a variable or class field
  initialized with `new <name>Subject(`. A selector cannot do that: the
  `subscriber.next(v)` inside `new Observable(...)` is the normal way to write
  an operator and must pass.
- **Must fail:** `import { of, Subject } from "rxjs"; const out = new Subject<number>(); export const s = of(1).subscribe((v) => out.next(v));`
- **Must pass:** `import { Observable, type Subscriber } from "rxjs"; export const copy = (src: Observable<number>): Observable<number> => new Observable<number>((subscriber: Subscriber<number>) => { const s = src.subscribe((v: number) => subscriber.next(v)); return () => s.unsubscribe(); });`

### What it flags in the React codebase

| Guardrail | Non-test hits (files) | All hits (files) |
|---|---|---|
| `rxjs-no-signal-imports` | 0 | 0 |
| `rxjs-no-exposed-subjects` | 2 (2) | 2 (2) |
| `rxjs-kept-subscriptions` | 6 (4) | 110 (33) |
| `rxjs-nested-subscribe` | 3 (3) | 13 (5) |
| `rxjs-relay` | 5 (3), measured with a selector approximation that skips receivers named `subscriber`, `observer`, `sub`, `o`, or `s` | 6 (4) |

In the Angular codebase, `rxjs-no-signal-imports` flags 36 imports in 29
files: the codebase mixes both forms on the same paths, which is exactly
what the conflict check exists to stop.

### Layer, dependencies, and conflicts

Layer 6. Depends on no pack. RX-1 conflicts with `signals-state-is-signal`,
which needs E1 and E2 before compile can refuse an overlap honestly.

### Left to review

- Each operator chain is a few small named pieces (Reactive composition).
- A view reads a live query and stays subscribed rather than taking one value
  with `firstValueFrom` (20 non-test files in the React codebase use it,
  mostly for commands, where one value is right). See Q2.

### Telemetry, help versus harm

| Guardrail | Helped | Harmed | Escape looks like |
|---|---|---|---|
| `rxjs-no-signal-imports` | `resolved` | upheld `disputed` where a framework API returns a signal | a signal library not in the list, such as `@vue/reactivity` |
| `rxjs-no-exposed-subjects` | `resolved` | `displaced` to an exported getter that returns the subject | `export function getOpen() { return open$; }` |
| `rxjs-kept-subscriptions` | `resolved` | upheld `disputed` for a deliberate app-lifetime subscription; `displaced` to `const _ = x.subscribe()` that is never ended | a kept subscription that is never unsubscribed |
| `rxjs-nested-subscribe` | `resolved` | `displaced` to a helper function that subscribes | the inner `subscribe` moved into a named function called from the callback |
| `rxjs-relay` | `resolved` | `cost` of scope analysis; `displaced` to `tap(v => out.next(v))` | `next` called through an alias, or inside `tap` |

### Open questions for Ryan

1. **Q1. Third-party rules for RxJS?** Options: (a) the pack ships its own
   rules (`no-relay` now, typed versions after E6); (b) allow
   `eslint-plugin-rxjs-x`, whose typed rules already cover these. 
   **Recommendation: (a).** It adds no dependency and stays inside Warden's
   sandbox; four of the five Guardrails are core rules anyway.
2. **Q2. Is a one-value read (`firstValueFrom`, `lastValueFrom`) a violation?**
   Options: (a) leave it to review; (b) ban it in views only, through
   `declarative-ui`; (c) ban it everywhere. **Recommendation: (a)** for v1.
   Commands legitimately take one value, and no static rule can tell a command
   from a live query without types.

---

## Pack `signals`

### Purpose and Terms

The same subscription model, in signal form. State is a signal, derived state
is computed, and an observable enters only through a bridge.

The first real consumer is not the React codebase, which has no signals: the
search found none in its 5,680 files. The only signals codebase found is the
Angular codebase, so this pack is grounded there, and it targets Angular's
`@angular/core` signals. See Q1.

| Term | Definition | Bans |
|---|---|---|
| `signal` | A writable Angular signal, made by `signal()`. | |
| `computed-signal` | A read-only signal made by `computed()`, derived from other signals. | |
| `signal-effect` | A function passed to Angular's `effect()`, which runs when the signals it reads change. | |
| `signal-bridge` | `toSignal` or `toObservable` from `@angular/core/rxjs-interop`. | |

### Practices

Paths for every Practice: the same non-test negated glob as `rxjs-declarative`.

#### SIG-1. `signals-state-is-signal`: Changing state is a signal

- **Statement:** State that changes over time is a signal; code makes no RxJS
  subject.
- **`conflictsWith`:** `[rxjs-state-is-observable]`.
- **Compliant:** the Angular codebase: 0 subject imports.
- **Violating:** the React codebase, if it enabled this pack: its slot
  registry imports `BehaviorSubject`.
- **Guardrail** `signals-no-subjects`, kind `lint`, `runs: [edit, commit]`,
  `budgetMs: 5000`: core `no-restricted-imports` with
  `{ paths: [{ name: "rxjs", importNames: ["Subject", "BehaviorSubject", "ReplaySubject", "AsyncSubject"] }] }`.
  Importing `Observable` or operators stays legal, since an HTTP client hands
  back observables.
- **Must fail:** `import { BehaviorSubject } from "rxjs"; export const open = new BehaviorSubject(0);`
- **Must pass:** `import { toSignal } from "@angular/core/rxjs-interop"; import { of } from "rxjs"; export const open = toSignal(of(0));`
  It imports neither a `subject` nor a name RX-1 bans, so it also passes
  `rxjs-no-signal-imports` wherever compile's must-pass cross-check
  (`src/compiler/examples.ts:118-131`) runs both packs on one example path.

#### SIG-2. `signals-writable-stays-private`: A signal is never exported or public

- **Statement:** A `signal` is never exported and never a public class
  property; others read a `computed-signal` or `asReadonly()`.
- **Compliant:** a store in the Angular codebase
  (`readonly repoName = computed(...)`).
- **Violating:** the same store
  (`readonly repoPath = signal<string | null>(null)`).
- **Guardrail** `signals-no-exposed-writable`, kind `lint`,
  `runs: [edit, commit]`, `budgetMs: 5000`: core `no-restricted-syntax` with
  `["ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > CallExpression[callee.name='signal']", "PropertyDefinition:not([accessibility='private']):not([accessibility='protected']):not([key.type='PrivateIdentifier']) > CallExpression[callee.name='signal']"]`.
  `protected` passes, because Angular templates can read protected members.
- **Must fail:** `import { signal } from "@angular/core"; export const count = signal(0);`
- **Must pass:** a class with `readonly #count = signal(0);` and
  `readonly count = this.#count.asReadonly();`.

#### SIG-3. `signals-derive-with-computed`: A signal-effect never writes a signal

- **Statement:** A `signal-effect` never sets or updates a `signal`; derived
  state is a `computed-signal`.
- **Compliant / violating:** the Angular codebase calls `effect()` nowhere, so
  0 hits.
- **Guardrail** `signals-effect-writes`, kind `lint`, `runs: [edit, commit]`,
  `budgetMs: 5000`: a pack rule, `eslint:signals/effect-writes`. It fails on
  `.set(` or `.update(` inside a call to the `effect` imported from
  `@angular/core`, when the receiver resolves to a `signal()` initializer. A
  selector would also flag `Map.set` and any local function named `effect`.
- **Must fail:** `import { effect, signal } from "@angular/core"; const a = signal(1); const b = signal(0); effect(() => b.set(a() * 2));`
- **Must pass:** `import { computed, signal } from "@angular/core"; const a = signal(1); export const b = computed(() => a() * 2);`

#### SIG-4. `signals-bridge-only`: An observable becomes a signal only through a signal-bridge

- **Statement:** A `subscribe` callback never sets a `signal`; an observable
  becomes a signal only through a `signal-bridge`.
- **Compliant:** none yet in the Angular codebase: `toSignal` appears nowhere.
- **Violating:** a collection stream module in the Angular codebase
  (`.subscribe((vm) => state.set(vm))`).
- **Guardrail** `signals-subscribe-sets`, kind `lint`, `runs: [edit, commit]`,
  `budgetMs: 5000`: a pack rule, `eslint:signals/subscribe-sets`, with the
  same receiver check as SIG-3. The selector form measured 3 non-test hits in
  the React codebase, all false positives on `Map.set`.
- **Must fail:** `import { signal } from "@angular/core"; import { of } from "rxjs"; const s = signal(0); export const sub = of(1).subscribe((v) => s.set(v));`
- **Must pass:** `import { toSignal } from "@angular/core/rxjs-interop"; import { of } from "rxjs"; export const s = toSignal(of(1));`

### What it flags today

| Guardrail | Angular codebase, non-test (files) | React codebase, non-test (files), if enabled |
|---|---|---|
| `signals-no-subjects` | 0 | 33 (27) |
| `signals-no-exposed-writable` | 15 (3) | 0 |
| `signals-effect-writes` | 0 | 0 |
| `signals-subscribe-sets` | 2 (1), selector form | 3 (2), all `Map.set` false positives in selector form |

### Layer, dependencies, and conflicts

Layer 7. Depends on no pack. SIG-1 conflicts with `rxjs-state-is-observable`
(E1, E2). It never conflicts with `declarative-ui`, which is about React
views.

### Left to review

- Whether a `signal-effect` does only outside work (logging, storage), which
  is its only legitimate use.

### Telemetry, help versus harm

| Guardrail | Helped | Harmed | Escape looks like |
|---|---|---|---|
| `signals-no-subjects` | `resolved` | upheld `disputed` for a library that needs a subject | `new Observable` with a hand-kept listener list |
| `signals-no-exposed-writable` | `resolved` | `displaced` to a public method that returns the signal | `getCount() { return this.#count; }` |
| `signals-effect-writes` | `resolved` | `cost`; `displaced` to `untracked(() => b.set(...))` | the write moved into a function the effect calls |
| `signals-subscribe-sets` | `resolved` | `displaced` to `tap(v => s.set(v))` | `set` inside `tap`, or through an alias |

### Open questions for Ryan

1. **Q1. Build `signals` now, with the Angular codebase as its consumer, or wait
   for a consumer that adopts Warden?** Options: (a) build SIG-1 only now, so
   the conflict with RX-1 is real and tested, and the rest when a consumer
   adopts Warden; (b) build all four now; (c) wait. **Recommendation: (a).**
   The React codebase has no signals, and the conflict machinery (E1, E2) needs
   two real Practices to test against.
2. **Q2. Which signal libraries?** Options: (a) Angular only; (b) Angular and
   Preact. **Recommendation: (a).** Angular is the only signals code found.

---

## Pack `declarative-ui`

### Purpose and Terms

A React view describes what to show from its inputs. It reads changing state
through a bridge hook, derives values while rendering, and changes the DOM
only by rendering. This is Ryan's "the UI just watches the database"
(vocabulary, Sources pipelines database UI, paraphrased there).

| Term | Definition | Bans |
|---|---|---|
| `view` | A React component or hook that returns or computes what to render. | `widget` |
| `view-state` | A value held by `useState` or `useReducer` in a view. | |
| `react-effect` | A function passed to `useEffect` or `useLayoutEffect`. | |
| `bridge-hook` | A hook in a `bridges/` folder, or from a library, that turns a subscription-model value into view-state, such as `useObservableState` or `useSyncExternalStore`. | |

### Practices

Paths for every Practice:
`"!**/{bridges/**,*.test.*,*.spec.*,*.stories.*,test/**,tests/**,__tests__/**,e2e/**}"`.
The pack entry scopes it to renderer folders. Where a `bridge-hook` lives is
[Q1](#open-questions-for-ryan-3).

#### UI-1. `declarative-ui-reads-through-bridge-hooks`: A react-effect never subscribes

- **Statement:** A `view` reads changing state through a `bridge-hook`; a
  `react-effect` never calls `subscribe`.
- **Compliant:** a settings dialog in the React codebase calls
  `useObservableValue(read$, LOADING)`, a hook that wraps `observable-hooks`.
- **Violating:** a root component and a dock hook in the React codebase,
  each subscribing in a `useEffect` and copying values into view-state.
- **Guardrail** `declarative-ui-subscribe-in-effect`, kind `lint`,
  `runs: [edit, commit]`, `budgetMs: 5000`: core `no-restricted-syntax` with
  `["CallExpression[callee.name=/^use(Layout)?Effect$/] CallExpression[callee.property.name='subscribe']"]`.
- **Must fail:** `import { useEffect, useState } from "react"; import type { Observable } from "rxjs"; export const useN = (n$: Observable<number>): number => { const [n, setN] = useState(0); useEffect(() => { const s = n$.subscribe(setN); return () => s.unsubscribe(); }, [n$]); return n; };`
- **Must pass:** `import { useObservableState } from "observable-hooks"; import type { Observable } from "rxjs"; export const useN = (n$: Observable<number>): number => useObservableState(n$, 0);`
  The example project has no `observable-hooks`; the rule reads syntax only,
  so the import need not resolve.

#### UI-2. `declarative-ui-derives-while-rendering`: A react-effect never sets view-state directly

- **Statement:** A `react-effect` never sets `view-state` directly in its
  body; a value derived from inputs is computed while rendering.
- **Compliant:** the same root component derives
  `const root = readRoot(slots, read)` while rendering.
- **Violating:** a markdown component in the React codebase calls
  `setErrors([])` at the top of an effect.
- **Guardrail** `declarative-ui-set-in-effect`, kind `lint`,
  `runs: [edit, commit]`, `budgetMs: 5000`: core `no-restricted-syntax` with
  `["CallExpression[callee.name=/^use(Layout)?Effect$/] > :function > BlockStatement > ExpressionStatement > CallExpression[callee.name=/^set(?!Timeout|Interval|Immediate)[A-Z]/]", "CallExpression[callee.name=/^use(Layout)?Effect$/] > :function > CallExpression[callee.name=/^set(?!Timeout|Interval|Immediate)[A-Z]/]"]`.
  It matches only a call at the top of the effect, so a set inside a callback
  the effect registers passes.
- **Must fail:** `import { useEffect, useState } from "react"; export const useDouble = (n: number): number => { const [d, setD] = useState(0); useEffect(() => { setD(n * 2); }, [n]); return d; };`
- **Must pass:** `export const useDouble = (n: number): number => n * 2;`

#### UI-3. `declarative-ui-dom-by-rendering`: A view changes the DOM only by rendering

- **Statement:** A `view` never queries the document and never writes markup
  or classes on an element directly.
- **Compliant:** the markdown component sets `className` by rendering.
- **Violating:** the same component writes `content.innerHTML = html`.
- **Guardrail** `declarative-ui-dom-writes`, kind `lint`,
  `runs: [edit, commit]`, `budgetMs: 5000`: core `no-restricted-syntax` with
  `["MemberExpression[object.name='document'][property.name=/^(querySelector|querySelectorAll|getElementById|getElementsByClassName|getElementsByTagName)$/]", "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]", "CallExpression[callee.object.property.name='classList'][callee.property.name=/^(add|remove|toggle|replace)$/]"]`.
  Reading through a ref, such as `focus()` or `contains()`, passes.
- **Must fail:** `export const mark = (): void => { document.querySelector("#a")?.classList.add("on"); };`
- **Must pass:** `export const mark = (on: boolean): string => (on ? "on" : "off");`

#### UI-4. `declarative-ui-hook-rules`: Hooks follow React's rules

- **Statement:** A `view` calls hooks unconditionally, and every
  `react-effect` lists what it reads.
- **Violating:** a plugin settings tab in the React codebase calls
  `useSettings()` inside a nested component factory (`rules-of-hooks`).
- **Guardrails,** kind `lint`, v2 after E7 and Q3:
  `eslint:react-hooks/rules-of-hooks` and `eslint:react-hooks/exhaustive-deps`.
  The React codebase's own ESLint config already runs both, and turns them
  off for one scope, which is the bypass Warden exists to close.

### What it flags in the React codebase

| Guardrail | Non-test hits (files) | All hits (files) |
|---|---|---|
| `declarative-ui-subscribe-in-effect` | 22 (17), including two in the codebase's live-query bridge hook, which leave the count when the bridge moves to `bridges/` | 27 (22) |
| `declarative-ui-set-in-effect` | 65 (46) | 78 (57) |
| `declarative-ui-dom-writes` | 16 (10) | 172 (76) |
| `react-hooks/rules-of-hooks` | 1 (1) | 27 (15) |
| `react-hooks/exhaustive-deps` | 53 (34) | 61 (41) |

Measured over every `.tsx` file and every `use*.ts` hook file.

### Layer, dependencies, and conflicts

Layer 8. Depends on no pack, and uses no `rxjs-declarative` Term, so a
project on signals can enable it without RxJS. Conflicts with none.

### Left to review

- Whether a component is small and does one thing, beyond what `principles`
  measures.
- Whether a view shows an empty stream as the empty state rather than fake
  data (Empty stream is the correct empty state).

### Telemetry, help versus harm

| Guardrail | Helped | Harmed | Escape looks like |
|---|---|---|---|
| `declarative-ui-subscribe-in-effect` | `resolved` | upheld `disputed` for a bridge written outside `bridges/`; `displaced` to a subscribe in an event handler | `subscribe` called in a helper the effect calls |
| `declarative-ui-set-in-effect` | `resolved` | upheld `disputed` for a reset on prop change, which React documents; `stalled` when the agent cannot find the render-time form | `setX` inside `queueMicrotask` or `Promise.resolve().then` in the effect |
| `declarative-ui-dom-writes` | `resolved` | upheld `disputed` for markdown or third-party widgets that need raw HTML | `ref.current.setAttribute(...)`, or `document.body` access |
| `react-hooks/*` | `resolved` | `cost`; `displaced` to a `useRef` that hides a dependency | a dependency read through a ref |

### Open questions for Ryan

1. **Q1. How is a bridge-hook identified?** Options: (a) by path, a
   `bridges/` folder, like `sources/` and `sinks/` in the architecture pack;
   (b) by a pack setting that lists bridge files; (c) only library bridges,
   so a project writes none. **Recommendation: (a).** The path carries the
   claim, as the architecture pack decided, and no second list drifts.
   The React codebase's live-query hook would move to a `bridges/` folder.
2. **Q2. React only?** Options: (a) React only, and the pack says so;
   (b) add Angular template rules later in the same pack; (c) a separate
   Angular pack later. **Recommendation: (a), then (c)** when an Angular
   project adopts Warden.
3. **Q3. Third-party ESLint plugins (E7) for UI-4?** Options: (a) let Warden
   load an allowed list of plugins pinned in Warden's own `package.json`, so
   the lock covers their version; (b) leave hook rules to each project's own
   ESLint config; (c) port the two rules into the pack. **Recommendation:
   (a)**, with `eslint-plugin-react-hooks` as its first entry. Project config
   can turn the rules off, as the React codebase does today.

---

## Calls made in this document, for Ryan to check

These are the author's calls, not Ryan's decisions:

- No pack picks RxJS or signals over the other. Each path picks one, and the
  bridge stays legal in both.
- Name-based selectors where a core rule can match the syntax exactly; a pack
  rule with scope analysis where a selector would flag `Map.set` or a
  `subscriber.next`.
- Practices exclude test files, except `typescript` TS-1, which runs per
  program.
- The packs take layers 5 to 8 in the order the framework lists them.
- A new Evidence kind, `displaced`.

## Version split

| Release | Ships | Waits on |
|---|---|---|
| v1 | `typescript` TS-1 (four mapped flags) and TS-2; `rxjs-declarative` RX-1 to RX-5; `signals` SIG-1; `declarative-ui` UI-1 to UI-3 | E1, E2, and E3 before any conflicting pair is enabled; a pack `eslint.js` for `rxjs-relay` |
| v2 | TS-1 unchecked index, TS-3, TS-4; SIG-2 to SIG-4; UI-4 | E4 to E7, and the answers above |
| later | every "Left to review" row | E8 |

Telemetry columns light up as E9 lands; until then only `fired`, `cost`, and
`stalled` are recorded.

## Left to the builder

- The exact example code, as long as each `mustPass` example passes every
  other Guardrail on its path, including `core` and the other style packs.
- The scope-analysis details of `rxjs-declarative/no-relay`,
  `signals/effect-writes`, and `signals/subscribe-sets`, as long as each fails
  its must-fail example and passes its must-pass example.
- Messages, which follow Warden's one-formatter rule: the compliant example
  and one next action.

## Built in version 1

### Shipped Guardrails

| Pack | Practice | Guardrails |
|---|---|---|
| `typescript` | TS-1 `typescript-strict-compiler` | `typescript-strict-null`, `typescript-no-implicit-any`, `typescript-implicit-returns`, `typescript-implicit-override`, `typescript-exact-optional` |
| `typescript` | TS-2 `typescript-no-escape-hatches` | `typescript-no-any`, `typescript-no-non-null`, `typescript-no-assertion` |
| `rxjs-declarative` | RX-1 `rxjs-state-is-observable` | `rxjs-no-signal-imports` |
| `rxjs-declarative` | RX-2 `rxjs-subjects-stay-private` | `rxjs-no-exposed-subjects` |
| `rxjs-declarative` | RX-3 `rxjs-subscriptions-kept` | `rxjs-kept-subscriptions` |
| `rxjs-declarative` | RX-4 `rxjs-no-nested-subscribe` | `rxjs-nested-subscribe` |
| `rxjs-declarative` | RX-5 `rxjs-no-relay` | `rxjs-relay` |
| `signals` | SIG-1 `signals-state-is-signal` | `signals-no-subjects` |
| `declarative-ui` | UI-1 `declarative-ui-reads-through-bridge-hooks` | `declarative-ui-subscribe-in-effect` |
| `declarative-ui` | UI-2 `declarative-ui-derives-while-rendering` | `declarative-ui-set-in-effect` |
| `declarative-ui` | UI-3 `declarative-ui-dom-by-rendering` | `declarative-ui-dom-writes` |

These are 17 Guardrails. Engine gaps E1, E2, and E3 are built, and so is
the slice of E5 that `exactOptionalPropertyTypes` needs.
`test/style-packs.test.ts` enables all five packs together: `core` and
`typescript` on every code file, and `rxjs-declarative`, `signals`, and
`declarative-ui` on their own folders. The test proves three things:

- Consistency finds nothing, and every `mustPass` passes every other
  Guardrail on its path.
- The bench admits every new Guardrail.
- `warden check` at `commit` records a `fired` row with status `fail` and a
  `cost` row with a measured time for each new Guardrail.

Not built in version 1: TS-1 unchecked index, TS-3, TS-4, SIG-2 to SIG-4,
UI-4, and `typescript-index-signature-access`, which will never be built.

### Deferred engine gaps

- **E4, more than one `tsc` program.** TS-1 checks only the root
  `tsconfig.json` program. A second program, such as an Electron main
  process, waits.
- **The rest of E5.** Attribution for `noUncheckedIndexedAccess`,
  `useUnknownInCatchVariables`, and `verbatimModuleSyntax` waits with
  `typescript-unchecked-index`.
- **E6, typed linting.** Blocks TS-3, TS-4, and the typed form of RX-2.
- **E7, `typescript-eslint` and third-party plugins.** Blocks TS-3, TS-4,
  and UI-4.
- **E8, `review` Guardrails.** Every "Left to review" row stays in this
  document.
- **E9, the help-versus-harm Evidence kinds and `warden dispute`.** Version 1
  records `fired`, `cost`, and `stalled` only. Each pack test pins the
  escape and displacement shapes from its Telemetry section with today's
  status.

### Design gaps and what was done about each

1. **Five TS-1 flags ship, not four.** The version split says four. Q2 (a)
   adds exact optional properties, so five ship.
2. **`exactOptionalPropertyTypes` needs `strictNullChecks`.** Without
   `strictNullChecks`, tsc prints TS5052 with no file position, and the
   adapter used to crash. The `tsc` adapter now turns on a flag's
   prerequisites. An options error from tsc is now a usage failure, exit 2,
   with one next action.
3. **The conflict goal contradicts the Practices.** The Goals say each
   pack's must-pass example fails the other pack's Guardrail, but RX-1 and
   SIG-1 keep the bridge legal in both forms. The test checks the form that
   can hold: each form's must-fail example is the other form's compliant
   code, and both must-pass examples pass both Guardrails.
4. **A conflicting pack cannot cover the whole repository.** E2 refuses
   empty paths and every glob that is not `<folder>/**`, even when the other
   pack is off. This was built as the design wrote it. A project with RxJS at
   its root lists its top folders.
5. **E3 also breaks examples and the bench.** Both place files by a scope's
   literal text. Path prefixes now decode `[[]` to `[`, and a test confirms
   that Warden's matcher accepts `[[]name]`.
6. **The conflict findings had no next action.** `undefined-conflict` and
   `conflict-overlap` now each end in one next action, and a test runs it.
7. **Telemetry has no record field.** No telemetry property was added to the
   Guardrail schema. Each pack test pins its escape and displacement shapes,
   and `test/style-packs.test.ts` proves the `fired` and `cost` rows.
8. **Found while combining the packs: `rxjs-relay`'s must-pass example
   failed `typescript-no-implicit-any`.** The example project has no `rxjs`
   types, so the untyped callback parameters were implicit `any`. The
   example now types `subscriber` and `v`. It still passes `rxjs-relay`.
9. **Found while combining the packs: lint Guardrails have no `cost` row of
   their own.** ESLint Guardrails share one pass. Their `cost` row is the
   shared row, which lists them in `members` and gives each one's time in
   `rules`. Only a Guardrail that runs alone gets a `cost` row under its own
   id. The test accepts either form and requires a numeric time for the
   Guardrail in both.
