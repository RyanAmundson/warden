# Warden principles pack: KISS, single responsibility, composition, and YAGNI proxies

Status: approved by Ryan, November 18, 2026. The second release waits on an
engine task.

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
  an engine change, because a `cmd` Guardrail can't locate a
  script inside its pack today.
- **Moderate limits:** complexity 10, nesting depth 3, function 50 lines,
  4 parameters, file 300 lines, 7 interface members, 1 class per file.
- **Inheritance:** no class extends anything except `Error`. A project pack
  may add its own framework bases later. This check and the interface-size
  check moved to the second release after approval: both need
  `no-restricted-syntax`, which the architecture pack owns, and Warden lets
  one ESLint rule back only one Guardrail across all packs (a coordinator
  ruling). Sharing a rule is a separate engine task.

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
  owns registries and import direction.
- A `review` kind entry for what no proxy measures. No `review` adapter
  exists, and `warden compile` rejects a Guardrail it cannot run. The "left
  to review" column of the spec stays in the spec until the decision-model
  adapter lands.
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

## Measured on a sample codebase

All ten candidate rules ran in one ESLint pass over a sample of 483 files, every
eleventh tracked TypeScript file of a large TypeScript codebase, November 18, 2026. The rules added about 80 ms of rule time
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
  (sibling note from the collection-folders session). The second release
  therefore runs its cross-file checks through the `fs` adapter, whose
  findings are per file.
- **The YAGNI single-implementation proxy needs a port exception.** The
  architecture pack requires each port to have one implementation at first,
  so that proxy's statement must exclude a `port`.

## Second release

Cross-file checks as tree checks shipped in the pack, each an `fs` or
`graph` Guardrail of kind `lint` at `boundary`:

- Duplicate blocks of 8 or more significant lines (DRY). A spike measured
  1.4 s across that whole codebase and found 679 duplicates.
- Interfaces with one implementation, except a `port`, and unused exports
  (YAGNI).
- One name exported from two files (SSOT).
- Unused parameters through `tsc`, once the adapter maps their codes.
- Practice `composition-and-narrow-interfaces` (Liskov and interface
  segregation): no class extends anything except `Error`, and an interface
  has at most 7 members. It uses `no-restricted-syntax` or a `warden/*`
  rule.

### What shipped

- Practices `no-repeated-code` (`principles-duplicate-blocks`),
  `no-speculative-code` (`principles-unused-exports`,
  `principles-single-implementation`), and `one-home-per-name`
  (`principles-duplicate-exports`). Each is a check that runs in the pack's
  sandbox: `graph:principles/unused-exports` in `packs/principles/graph.js`,
  and the other three as `fs:principles/<name>` in `packs/principles/fs.js`.
- The unused-export check uses the `graph` adapter's import graph to skip
  each file that no other file imports. Such a file is an entry point, such
  as a script, a package's main file, or a page a framework loads, and its
  exports are its interface. This also keeps a one-file example of another
  Guardrail from failing the check.
- List public entry files under `settings.entryPoints` on the Principles
  pack entry in `.warden/config.yaml`. Use exact repository-relative paths
  such as `src/api.ts`. This preserves their public exports after an internal
  file starts importing the entry. Run `warden compile` and include the
  config and updated lock in a signed commit.
- The checks share `packs/principles/code.js`. They read the files Warden
  gives them through `read`, never the disk, and parse them with the `ts`
  compiler API Warden passes in. Each finding names one file and line, and
  a duplicate block also its last line, so the baseline counts it per file.
  Each finding's Do this names the exact edit for that finding.
- Test, spec, and story files are read as users: their imports and
  implementing classes count. Violations are never reported in them, and
  the duplicate-block check does not read them. Declaration files are not
  read.
- The unused-export check reads users from every code file Warden lists for
  the project, including files outside the Practice's paths, such as
  `.jsx`, and reports only in files on those paths.
- `import()` counts as a use: of each name destructured from it or read from
  its awaited result or its `then` callback, and otherwise of every export
  of the file it names. A type `import("./x").Name` counts as a use of
  `Name`.
- A single-implementation finding names a class outside test files. An
  interface also counts as implemented by a function outside test files
  whose return type it is, a variable it types that holds an object literal,
  or an object literal that `satisfies` it. A method or getter with that
  return type counts when it returns an object literal from its own body.
- A project lists names that a host contract requires every such file to
  export, such as a plugin's `start`, in the pack's `contractExports`
  setting on its entry in `.warden/config.yaml`. Both name checks skip
  them. A change to the setting is recorded as loosening, like any other
  setting. The SSOT check's Do this names the setting.
- `export * from` and `export * as` with a relative specifier count as a use
  of every export of the file they name.
- Import lists and export lists are not significant lines for the
  duplicate-block check.
- List generated source under `settings.generatedPaths` on the Principles
  pack entry in `.warden/config.yaml`. Use repository-relative glob patterns
  such as `src/generated/**` or `src/client.ts`. Write a literal opening
  bracket as `[[]`, as in `src/[[]components]/generated/**`.
  The duplicate-block check skips matching files. Run `warden compile` and
  include the config and updated lock in a signed commit.
- Both name checks skip export names that a framework requires by name:
  Next.js page, layout, and route exports (`metadata`, `generateMetadata`,
  `viewport`, `generateViewport`, `generateStaticParams`,
  `generateImageMetadata`, `generateSitemaps`, `dynamic`, `dynamicParams`,
  `revalidate`, `fetchCache`, `runtime`, `preferredRegion`, `maxDuration`,
  the HTTP method handlers, `config`, `middleware`); React Router and Remix
  route exports (`loader`, `action`, `clientLoader`, `clientAction`,
  `meta`, `links`, `headers`, `handle`, `shouldRevalidate`,
  `ErrorBoundary`, `HydrateFallback`, `Layout`); and SvelteKit (`load`,
  `prerender`, `ssr`, `csr`, `trailingSlash`, `entries`). The list is
  `FRAMEWORK_EXPORTS` in `code.js`.
- A port is the file named after its group folder inside a bracketed
  collection. Files named `create` are skipped by the SSOT check, because the
  architecture layout gives every group one.
- `principles-unused-parameters` is `tsc:noUnusedParameters` in Practice
  `no-unused-code`. TS6133 and TS6198 come from both `noUnusedParameters`
  and `noUnusedLocals`, so the `tsc` worker marks each one that starts inside
  a parameter name or a type parameter list, and the adapter gives those to
  the `noUnusedParameters` Guardrail and the rest to `noUnusedLocals`. TS6205
  belongs to `noUnusedParameters`, and TS6138 to `noUnusedLocals`. Unused
  locals stay with the ESLint Guardrail `principles-unused-locals`, so the
  pack adds no `tsc:noUnusedLocals` Guardrail.
- `composition-and-narrow-interfaces` is not built yet. Its engine
  dependency, letting Guardrails share an ESLint rule, is closed.

## Left to the builder

- The exact example code for each Guardrail, as long as each `mustPass`
  example also passes every other Guardrail on its path, including `core`.
- The tests that prove the pack compiles and that `warden packs` lists it.
