# Principles pack v1 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `packs/principles/pack.yaml` with three Practices and nine stock ESLint Guardrails, each proven by its own examples.

**Architecture:** The pack is data only. Each Guardrail names a core ESLint rule (`eslint:<rule>`) with its options; Warden's ESLint adapter runs them all in its single pass. A vitest file proves the examples and the limits.

**Tech Stack:** YAML records, ESLint 9 core rules, vitest 4.

**Spec:** [`2026-11-18-warden-principles-pack-design.md`](2026-11-18-warden-principles-pack-design.md)

## Global Constraints

- Write only `packs/principles/`, `test/principles-pack.test.ts`, and `docs/`. No change under `src/`, `eslint-plugin/`, `schema/`, or `scripts/`.
- No comments in any source or test file.
- Pack `id: principles`, `layer: 2`, `terms: []`.
- Every Practice: `paths: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]`, `conflictsWith: []`, `terms: []`.
- Every Guardrail: `kind: lint`, `runs: [edit, commit]`, `budgetMs: 5000`, `version: 1`.
- Tests: `npx vitest run --maxWorkers=2 <file>`, affected files only. Tests use a temp directory, never `~/.warden`.

## Review Focus

- A `mustPass` example that fails another Guardrail on the same path, including `core`'s `no-comments`. `runExamples` reports `example-conflict`; the examples test catches it.
- A limit off by one. Each limit gets a test at the limit (passes) and one past it (fails).
- Rest-sibling destructuring (`const { a, ...rest } = x`) must not count `a` as unused.
- A parameter name inside a TypeScript function type must not count as unused.

---

### Task 1: The principles pack and its proof

**Files:**
- Create: `packs/principles/pack.yaml`
- Test: `test/principles-pack.test.ts`

**Interfaces:**
- Consumes: `loadRecords`, `runExamples`, `runGuardrails`, `eslintAdapter`, as `test/core-pack.test.ts` uses them.
- Produces: Guardrail ids, in this order: `principles-complexity`, `principles-nesting-depth`, `principles-function-length`, `principles-parameter-count`, `principles-file-length`, `principles-one-class-per-file`, `principles-unused-locals`, `principles-useless-constructor`, `principles-unused-private-members`.

Practices, statements, and rule options (exact):

| Practice | Statement | Guardrail: `implementation`, `options` |
|---|---|---|
| `small-functions` | Functions stay small. Complexity at most 10, so at most 9 decisions such as if, loop, case, ?:, &&, ||, and ??; at most 3 levels of nesting, 50 lines, and 4 parameters. | `eslint:complexity` `[{ max: 10 }]`; `eslint:max-depth` `[{ max: 3 }]`; `eslint:max-lines-per-function` `[{ max: 50, skipBlankLines: true, skipComments: true }]`; `eslint:max-params` `[{ max: 4 }]` |
| `one-responsibility-per-file` | A file holds one responsibility: at most 300 lines and one class. | `eslint:max-lines` `[{ max: 300, skipBlankLines: true, skipComments: true }]`; `eslint:max-classes-per-file` `[1]` |
| `no-unused-code` | Code declares nothing it does not use: no unused local, no useless constructor, and no unused private member. | `eslint:no-unused-vars` `[{ args: "none", ignoreRestSiblings: true }]`; `eslint:no-useless-constructor`; `eslint:no-unused-private-class-members` |

Practice `composition-and-narrow-interfaces` moved to the second release during execution: the architecture pack owns `no-restricted-syntax`.

Each `mustFail` breaks only its own Guardrail's limit by one. Each `mustPass` is the compliant rewrite and must pass all nine plus `core`.

- [ ] **Step 1: Write the failing test** `test/principles-pack.test.ts`, with config packs `core` then `principles`, both on `["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]`, and a `check(id, source)` helper like `core-pack.test.ts`'s.
  - `principles pack examples hold`: the ids equal the list above and `await runExamples(set)` equals `[]`.
  - `it.each` limit cases, each `[id, source, status]`: complexity 10 pass, 11 fail; depth 3 pass, 4 fail; function of 50 lines pass, 51 fail; 4 parameters pass, 5 fail; 300-line file pass, 301 fail; one class pass, two fail; `const { a, ...rest } = x; export { rest };` pass; `export type F = (unused: number) => void;` pass; `const unused = 1;` fail.
  - Generate long sources with `Array.from` in the test, not literal text.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=2 test/principles-pack.test.ts`. Expected: FAIL, `pack principles` not found.
- [ ] **Step 3: Write `packs/principles/pack.yaml`** from the table above.
- [ ] **Step 4: Run** the same command. Expected: every test passes.
- [ ] **Step 5: Run** `npx tsc --noEmit` and `bash scripts/self-check.sh` if it covers tests. Expected: exit 0.
- [ ] **Step 6: Commit** `packs/principles/pack.yaml test/principles-pack.test.ts`.

### Task 2: The CLI lists the bundled packs, whatever they are

Cancelled: the collection-folders branch fixed these tests on main (920df24).

The pack-picker tests in `test/cli/cli.test.ts` assume `core` is the only bundled pack, so they fail once `packs/principles/` exists. The collection-folders branch (`claude/pack-collection-folders-2c64fa`, commit `af4bf38`) already replaces those assumptions with a list read from `packs/`.

- [ ] **Step 1:** `git fetch origin` and check whether `af4bf38` is on `origin/main`. If it is, rebase onto `origin/main` and skip to Step 3.
- [ ] **Step 2:** If it is not, make the same change in `test/cli/cli.test.ts`: derive the bundled list from `readdirSync(join(wardenRoot, "packs"))` sorted with `localeCompare`. Do not name `principles` in the test.
- [ ] **Step 3: Run** `npx vitest run --maxWorkers=2 test/cli/cli.test.ts -t "pack picker"`. Expected: PASS.
- [ ] **Step 4: Commit** if Step 2 changed anything.

### Task 3: Release proof

- [ ] **Step 1:** In a scratch repo with `WARDEN_HOME` set to a scratch folder, install Warden from this branch, run `warden packs`, and confirm a `principles  bundled  3 practices  lint=9` row.
- [ ] **Step 2:** Run `warden init --packs core,principles`. Expected: exit 0.
- [ ] **Step 3:** For each of the nine Guardrails, commit-check one passing file and one failing file with `warden check <file> --rule <id>`. Expected: exit 0 then exit 1, with the failure naming the Practice.
- [ ] **Step 4:** Record the commands and exit codes.
