# Warden principles pack: KISS, single responsibility, composition, and YAGNI proxies

Status: approved by Ryan, November 18, 2026. Tracking task:
`cm-wkqedr.5`, under the Warden epic `cm-wkqedr`. Second release:
`cm-wkqedr.27`, which waits on the engine task `cm-wkqedr.26`.

Builds on the
[Principles pack section](2026-11-18-warden-guardrail-framework-design.md#principles-pack)
of the Warden design spec.

## Intent

The spec lists deterministic proxies for each engineering principle (SSOT,
DRY, YAGNI, KISS, and SOLID), so a principle fails a check instead of living
only as prose. This pack ships the proxies that existing tools can prove
today.

## Decisions (Ryan, November 18, 2026)

- **Split the pack in two.** This release uses only stock ESLint rules. The
  cross-file proxies (duplicate code blocks for DRY, interfaces with one
  implementation and unused exports for YAGNI, one name exported from two
  files for SSOT) ship next, as tested scripts the pack carries. They need
  the engine change `cm-wkqedr.26`, because a `cmd` Guardrail can't locate a
  script inside its pack today.
- **Moderate limits:** complexity 10, nesting depth 3, function 50 lines,
  4 parameters, file 300 lines, 7 interface members, 1 class per file.
- **Inheritance:** no class extends anything except `Error`. A project pack
  may add its own framework bases later. This check and the interface-size
  check moved to the second release after approval: both need
  `no-restricted-syntax`, which the architecture pack owns, and Warden lets
  one ESLint rule back only one Guardrail across all packs (coordinator
  ruling in `cm-wkqedr.1`). Sharing a rule is engine task `cm-wkqedr.25`.

## Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| Engine task first, then the cross-file checks as script files | Clean, testable scripts; the cross-file part waits on the engine session | Chosen |
| Inline each script as a `node -e` command in `pack.yaml` | Ships everything now, but the scripts can't be read, tested, or linted | Rejected |
| Stock ESLint rules only, forever | Smallest, but DRY gets no check | Rejected |

## Goals

- Each Practice has at least one Guardrail proven by its own `mustFail` and
  `mustPass` examples, through `warden compile`.
- Every Guardrail is a stock ESLint core rule, so the pack adds no code.
- Every Guardrail runs at `edit` and `commit`, in Warden's single ESLint pass.

## Non-goals

- Open/closed and dependency inversion. The architecture pack
  (`cm-wkqedr.24`) owns registries and import direction.
- A `review` kind entry for what no proxy measures. No `review` adapter
  exists, and `warden compile` rejects a Guardrail it cannot run. The "left
  to review" column of the spec stays in the spec until the decision-model
  adapter (`cm-wkqedr.12`) lands.
- Import fan-out per Unit. No core ESLint rule measures it.

## The Practices

Pack `principles`, layer 2. The architecture pack takes layer 1, so this pack
may use its `port` Term in the second release. Every Practice covers
`**/*.{ts,tsx,mts,cts,js,mjs,cjs}`, the same as `core`.

| Practice | Principle | Guardrail | ESLint rule and options |
|---|---|---|---|
| `small-functions` | KISS | `principles-complexity` | `complexity` max 10 |
| | | `principles-nesting-depth` | `max-depth` max 3 |
| | | `principles-function-length` | `max-lines-per-function` max 50, blank lines and comments skipped |
| | | `principles-parameter-count` | `max-params` max 4 |
| `one-responsibility-per-file` | Single responsibility | `principles-file-length` | `max-lines` max 300, blank lines and comments skipped |
| | | `principles-one-class-per-file` | `max-classes-per-file` 1 |
| `no-unused-code` | YAGNI | `principles-unused-locals` | `no-unused-vars` with `args: "none"` and `ignoreRestSiblings: true` |
| | | `principles-useless-constructor` | `no-useless-constructor` |
| | | `principles-unused-private-members` | `no-unused-private-class-members` |

Every Guardrail: kind `lint`, `runs: [edit, commit]`, `budgetMs: 5000`
(the `core` value), `version: 1`.

That is three Practices and nine Guardrails in this release.

## Measured on Context Manager

All ten candidate rules ran in one ESLint pass over a sample of 483 files, every
eleventh tracked TypeScript file, November 18, 2026. The rules added about 80 ms of rule time
in total; the 1.9 s wall time was mostly parsing, which Warden's single pass
already pays.

| Rule | Violations | Files |
|---|---|---|
| `complexity` | 124 | 70 |
| `max-depth` | 48 | 15 |
| `max-lines-per-function` | 218 | 137 |
| `max-params` | 23 | 16 |
| `max-lines` | 34 | 34 |
| `max-classes-per-file` | 5 | 5 |
| `no-restricted-syntax` | 62 | 35 |
| `no-unused-vars` (`args: "none"`) | 9 | 6 |
| `no-useless-constructor` | 0 | 0 |
| `no-unused-private-class-members` | 0 | 0 |

The baseline absorbs these at adoption, so the ratchet never blocks work.

## Findings that shaped the design

- **Unused parameters are not covered yet.** Core `no-unused-vars` treats
  parameter names inside TypeScript function types as unused: 626 false hits
  in the sample above. `args: "none"` removes them, and with them real unused
  parameters. The fix is `tsc:noUnusedParameters` and `tsc:noUnusedLocals`,
  but the `tsc` adapter maps only `strictNullChecks` and `noImplicitAny`
  diagnostics to their Guardrails; any other flag's errors go to the baseline
  Guardrail, so its `mustFail` example never fails. That mapping is part of
  the second release's engine needs.
- **A `cmd` Guardrail can't be baselined** and must not use kind `lint`
  (sibling note from the collection-folders session). Both apply to the
  second release.
- **The YAGNI single-implementation proxy needs a port exception.** The
  architecture pack requires each port to have one implementation at first,
  so that proxy's statement must exclude a `port`.

## Second release (`cm-wkqedr.27`)

Cross-file checks as tested `.mjs` scripts under `packs/principles/bin/`,
each a `cmd` Guardrail of kind `runtime` at `boundary`:

- Duplicate blocks of 8 or more significant lines (DRY). A spike measured
  1.4 s across all of Context Manager and found 679 duplicates.
- Interfaces with one implementation, except a `port`, and unused exports
  (YAGNI).
- One name exported from two files (SSOT).
- Unused parameters through `tsc`, once the adapter maps their codes.

Shipped in `cm-wkqedr.27`: Practices `no-repeated-code`
(`principles-duplicate-blocks`), `no-speculative-code`
(`principles-unused-exports`, `principles-single-implementation`), and
`one-home-per-name` (`principles-duplicate-exports`), each running a script
from `packs/principles/bin/` through `$WARDEN_PACK_DIR`. The scripts share
`project.mjs`, which lists files with `git ls-files` (or walks the folder
outside git), skips test, spec, story, and declaration files, and parses with
the TypeScript parser in one process. They print one `<file>:<line>` line per
violation, which the `cmd` adapter reads as per-file violations, so they can be
baselined. A port is the file named after its group folder inside a bracketed
collection. Files named `create` are skipped by the SSOT check, because the
architecture layout gives every group one. Unused parameters and
`composition-and-narrow-interfaces` stay open: they wait on the `tsc` code
mapping and on `cm-wkqedr.25`.
- Practice `composition-and-narrow-interfaces` (Liskov and interface
  segregation): no class extends anything except `Error`, and an interface
  has at most 7 members. It uses `no-restricted-syntax` once
  `cm-wkqedr.25` lets packs share a rule, or a `warden/*` rule.

## Left to the builder

- The exact example code for each Guardrail, as long as each `mustPass`
  example also passes every other Guardrail on its path, including `core`.
- The tests that prove the pack compiles and that `warden packs` lists it.
