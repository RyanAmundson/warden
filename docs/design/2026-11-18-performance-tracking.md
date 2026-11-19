# Warden performance tracking: pack totals, input size, and scaling verdicts

Status: approved by Ryan, 2026-11-18 ("Approve design"). Bead: `cm-wkqedr.16`, under `cm-wkqedr`.
Depends on `cm-wkqedr.17`, the ESLint timing fix. Destination:
`~/Code/warden/docs/design/2026-11-18-performance-tracking.md`, landed by the
Warden first-slice coordinator, who is the only writer in that repository.

## Intent

Ryan wants to know how long Warden takes and whether that time grows in
proportion to what it checks. In his words: "a combined total and individual
total on how much time it's taking, and determine if we're scaling linearly
with the size of the thing we're validating or if we could do better. Ideally,
we're scaling linearly or logarithmically."

This extends the Speed section of the Warden framework design: "The runner
times every run" and "Over budget is a framework defect, not a pass." A
Guardrail whose cost grows faster than its input is the same kind of defect
caught earlier, before the project grows into the budget.

## Goals

1. `warden report` shows, for each tier, a total for each pack and a combined
   total.
2. Every `cost` Evidence record carries the input size it ran on.
3. Each Guardrail and each pack gets a scaling verdict: `constant`,
   `sublinear`, `linear`, or `superlinear`. A superlinear verdict is a defect,
   and it fails.

## Non-goals

- Measuring scaling by line count within one file. Size here is files and
  bytes. Add a line axis when a Guardrail is shown to scale with file length.
- Profiling inside a Guardrail. The verdict says which Guardrail is slow, not
  why.
- Charts. The report stays text and JSON.

## Anti-goals

- **A warning.** Ryan wants no warnings. A verdict either passes or fails.
- **A raised budget or a loosened threshold** as the fix for a superlinear
  verdict. The fix is a faster Guardrail.
- **A verdict computed from real runs.** Those runs vary in size and machine
  load, so a verdict from them would not be deterministic.

## Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| A. Verdict from real-run Evidence | Free, but a changed-files run covers only about 1 to 20 files, so startup cost dominates. Other sessions load the machine, so the same input gives different times. | Rejected: not deterministic. |
| B. Benchmark only | Deterministic verdict, but the report would show no real time spent. | Rejected: Ryan asked for real totals. |
| C. Both: real-run totals plus a benchmark verdict | Totals reflect what agents actually wait for. The verdict comes from fixed inputs. | **Chosen by Ryan, 2026-11-18: "C: both (recommended)".** |

## Design

### 1. Timing model, built on `cm-wkqedr.17`

The model assumes the fix in `cm-wkqedr.17` has landed: ESLint batch times are
summed, and the shared ESLint pass is charged once. This design adds the
following on top of that fix.

- **Per-Guardrail time for lint Guardrails comes from ESLint's own per-rule
  timing.** ESLint 9 (installed: 9.39.5) returns each rule's time per file
  when it is constructed with `stats: true`. A lint Guardrail's `ms` is the sum
  of its rule's time over all files in the pass.
- **The shared pass is its own row.** The pass's wall time, minus the sum of
  its rule times, is parsing and setup. It is recorded once as the
  `eslint-pass` cost, belongs to no pack, and counts once in the combined
  total.
- **Other adapters already run one Guardrail per invocation** (`tsc`, `cmd`,
  and later `graph` and `fs`), so their `ms` is already that Guardrail's own
  time.

`cm-wkqedr.17` had not landed when this was written. This work starts after
it lands. If it charges the shared pass differently, this section follows its
model, and the brief is updated to match before work starts.

### 2. Cost Evidence gains run, tier, and size

`Evidence` in `src/runner/evidence.ts` gains these optional fields on `cost`
records:

| Field | Meaning |
|---|---|
| `run` | An id shared by every record from one `warden check` invocation. |
| `tier` | `edit`, `commit`, or `boundary`. |
| `pack` | The pack that owns the Guardrail. Absent on `eslint-pass` and `run` totals. |
| `files` | The number of files the adapter actually ran on. For lint, that means cache misses. For whole-project adapters, it means every file the tool read: `tsc`'s program files, and the tree for `graph` and `fs`. |
| `bytes` | The total size of those files. |

Each check also writes one total record, `{ kind: "cost", guardrail: "run",
run, tier, ms, files, bytes }`, whose `ms` is the wall time of the whole check,
from start to the final verdict. That record is the combined total. It is the
measured time, not a sum, so overlap and overhead are counted honestly.

**Which checks write a `run` record (my call).** Every `warden check`
invocation writes one, including early exits: tampering found, unstaged
files, or no files scanned. The record carries `outcome` (`ran`, `tampered`,
`unstaged`, or `empty`). The combined total uses only `ran` records, so cheap
refusals don't pull the median down. The report shows how many early exits
there were for each tier.

A cost record written by an older Warden has none of these fields. The report
leaves such records out of the pack and combined totals. It does not guess at
the missing values. (Ryan is the only user, so this needs no migration.)

### 3. Report: pack and combined totals for each tier

`warden report` changes in `src/cli/report.ts`:

- **Combined total for each tier:** the median and slowest `run` record for
  that tier, compared with `tierBudgetMs`. This replaces the current sum of
  per-Guardrail medians, which counts the shared ESLint pass once per lint
  Guardrail.
- **Pack total for each tier:** for each run, the sum of that pack's
  Guardrail `ms`; the report then shows the median and slowest over runs.
  A run in which none of the pack's Guardrails ran, for example because every
  file was answered from the cache, is left out of that pack's median rather
  than counted as 0 ms. The report shows the number of runs counted (my
  call). The pack total measures what the pack costs when it does work.
  The `eslint-pass` row appears once for each tier, beside the packs.
- **Per Guardrail:** the existing median and slowest, plus the median `ms`
  per file. The per-file figure is information only; no verdict comes from
  real runs.
- **Scaling:** the latest benchmark verdict and exponent for each Guardrail
  and pack (section 4), with the Warden version and date it ran on.

Text sketch:

```text
tier commit: median 3120ms, slowest 4810ms of 10000ms
  pack core          median 2410ms  slowest 3900ms
  pack architecture  median  540ms  slowest  760ms
  eslint-pass        median  170ms  slowest  240ms
scaling (warden bench at 0.1.3, 2026-11-18)
  pack core          linear       k=1.02
    core/no-comments linear       k=0.98
  pack architecture  superlinear  k=1.71  DEFECT
    arch/acyclic     superlinear  k=1.71  DEFECT
```

`--format json` returns the same rows.

### 4. Benchmark: `warden bench`

A new command, `warden bench [--rule <id>] [--pack <id>]`, measures how each
non-instruction Guardrail's time grows with input size, on generated input.

**Fixtures.** The benchmark reuses the temporary project that
`src/compiler/examples.ts` builds to run examples. For each Guardrail, it
writes N copies of the Guardrail's `mustPass` example:

- A single-file example becomes `<prefix>warden-example-<i>.ts`, where
  `<prefix>` is the path prefix that `exampleFile` already computes.
- A multi-file example becomes `<prefix>bench-<i>/<its own paths>`.
- Before timing anything, the benchmark checks that every copy still passes
  the Guardrail. If one fails, it exits 2 with a next action that names the
  Guardrail. A fixture that stops matching the Guardrail's paths would
  otherwise give a false fast result.
- Known limit: a `cmd` Guardrail is exempt from the paths check, because
  its command, not a path glob, decides what it reads. A command that reads
  only its example's own paths never reads the `bench-<i>/` copies, so its
  time does not grow and the benchmark reports `constant`. Read a `constant`
  verdict on a `cmd` Guardrail as unmeasured unless its command reads every
  copy, for example by walking the project tree.

Sizes are `base × 1, 2, 4, 8` files, where `base` is a config setting with a
default of 25. That makes 25, 50, 100, and 200 files. For the whole-tree
adapters (`tsc`, `graph`, `fs`), the copies are disjoint, so a linear
algorithm stays linear and a pairwise one shows up as superlinear.

**Isolation.** Every run uses a fresh `WARDEN_HOME` in the temporary project,
so the cache never answers. It also runs unbudgeted (`ctx.unbudgeted`), so a
slow size is measured instead of killed. Runs go one at a time, which follows
the shared-compute rule and keeps them from competing for the CPU.

**Removal.** A measurement returns before its temporary project is removed.
The project is removed in the background, and every `warden` command waits for
those removals before it exits. When removals fail, the command exits 2 with
one message that names every folder it could not remove and one next action:
delete those folders, then run the command again. A command that already
failed reports its own error first, then the removal error.

**Test timeout (Ryan, 2026-11-18).** Only the `scaling` vitest project raises
the test timeout, to 10 s; every other test keeps the 5 s default. The limit
covers the bench's worst case, two from-scratch measurements of one
Guardrail. At load 8 to 10, the slowest observed scaling test that measured
once took 4.4 s, so two measurements take up to about 8.9 s; 10 s leaves
about 1 s above that.

**Lint Guardrails are fitted on their own rule time (my call),** taken from
ESLint's `stats`, not on the whole pass. The verdict is about the rule alone.
The shared pass is benchmarked as its own row, `eslint-pass`. A superlinear
`eslint-pass` fails like any other row; it is a defect in Warden's ESLint
adapter, and the fix belongs there.

**Calibration.** Sub-millisecond timings are mostly noise. Before fitting, the
benchmark doubles `base` until the Guardrail's own time at 1x, minus fixed
cost, is at least `minMarginalMs` (default 20), up to `maxFiles` (default
3200). If it never gets there, the verdict is `constant`.

**Re-measure before failing.** A `superlinear` result is measured again from
scratch, with new fixtures and new runs. It fails only if the second
measurement is also superlinear. If the two disagree, the row passes and both
results are kept in the `scaling` Evidence, so a Guardrail that flips often
shows up in review. A real defect repeats; a burst of machine noise usually
doesn't.

**Measurement.** Each size runs 3 times, and the benchmark keeps the fastest
run. It measures fixed cost `f` with a single file, as the fastest of 9 runs. The exponent `k` is the
least-squares slope of `log(ms − f)` against `log(files)` over the four sizes.
Subtracting `f` stops startup time, such as ESLint or `tsc` launching, from
making a linear Guardrail look sublinear.

**Verdict.** The thresholds below are settings in `config.yaml` (`bench:` with
`baseFiles`, `maxFiles`, `minMarginalMs`, `linearMax`, `sublinearMax`,
`constantMs`). The values are Ryan's
to tune; these are the defaults:

| Verdict | Rule | Result |
|---|---|---|
| `constant` | `ms − f` stays under `constantMs` (default 5) at 8x | pass |
| `sublinear` | `k < 0.9` | pass |
| `linear` | `0.9 ≤ k ≤ 1.15` | pass |
| `superlinear` | `k > 1.15` | **fail**, named as a defect |

A pack's verdict is the worst verdict among its Guardrails. A Guardrail's cost
does not depend on its neighbours. The exception is the shared ESLint pass,
which the benchmark also measures as its own row, `eslint-pass`.

**Output and Evidence.** Bench prints one row per Guardrail and per pack. It
appends `scaling` Evidence with `guardrail` or `pack`, `k`, `verdict`, the
four `[files, ms]` points, `f`, and the Warden version. Exit status is 1 when
any verdict is superlinear, and 0 otherwise. A failing row says what to do:
"Next action: make `<guardrail>` linear in files; see the four points above."

**Where it runs (my call).** Bench is a command, not a Guardrail, so it is not
wired into a check tier.

- **`warden compile` admission.** Compile already runs each Guardrail on its
  examples and rejects one over budget. It also benches each Guardrail and
  rejects a superlinear one. A result is cached by Guardrail id, version,
  implementation, options, and Warden version, so only a new or changed
  Guardrail, or a new Warden release, is benched again. This covers a
  project's own local packs too, at the moment a Guardrail is added or
  changed. Bench time counts toward no tier budget.
- **Warden's own `npm test`** runs `warden bench` over every shipped pack and
  fails on any superlinear verdict, so a shipped Guardrail is proven before
  release. This follows the bootstrap rule that Warden checks itself.
- **`warden bench`** on its own reruns the benchmark on demand.

### 5. Files touched

| File | Change |
|---|---|
| `src/runner/evidence.ts` | New optional fields; the `scaling` kind. |
| `src/adapters/types.ts` | `RunResult` gains `files` and `bytes`. |
| `src/adapters/eslint.ts` | `stats: true`; per-rule `ms`; the `eslint-pass` result. |
| `src/adapters/tsc.ts`, `src/adapters/cmd.ts` | Report `files` and `bytes`. |
| `src/cli/check.ts` | Writes `run`, `tier`, `pack`, size, and the `run` total record. |
| `src/cli/report.ts` | Pack and combined totals for each tier; scaling rows. |
| `src/cli/bench.ts` (new), `src/cli/main.ts` | The `bench` command. |
| `src/compiler/examples.ts` | Exports the temporary-project setup for `bench` to reuse. |
| `src/records/types.ts`, `schema/records.schema.json` | `bench` config settings. |
| `test/cli/bench.test.ts` (new), `test/cli/cli.test.ts`, `test/runner/check.test.ts` | Tests below. |

### 6. Tests, each failing without its change

- A check run writes one `run` record and one `cost` record per Guardrail,
  each with `run`, `tier`, `pack`, `files`, and `bytes`. `files` for lint
  counts only cache misses.
- The report's combined total for a tier is the median of `run` records, not a
  sum. A fixture with two lint Guardrails in one pass gives a combined total
  below the sum of their per-Guardrail times plus the pass.
- The report shows one pack total per pack per tier, and the `eslint-pass` row
  once.
- `bench` gives `linear` for a fake adapter whose time is proportional to
  files, `superlinear` for one proportional to files squared, and `constant`
  for one with a fixed delay. It exits 1 only on the superlinear one. These
  use injected timings, so the tests are deterministic and fast.
- `bench` re-measures a superlinear result. Injected timings that are
  superlinear once, then linear, pass. Timings that are superlinear twice
  fail.
- `bench` exits 2 when a copied `mustPass` example fails its Guardrail.
- The Warden self-test runs `bench` on every shipped pack and passes.
- A change to a pack's `pack.yaml` runs `npx vitest run test/<pack>-pack`,
  because vitest's import graph cannot see YAML and `vitest related` selects
  no test for it.

## Decided by Ryan

- Totals from real runs; verdict from a deterministic benchmark (approach C).
- No warnings; superlinear fails (from the brief and the Speed section).
- Re-measure before failing (Ryan, 2026-11-18: "Tell it to re-measure before
  failing").

## My calls, open for Ryan to overrule

- Size counts files and bytes, not lines.
- Default sizes: 25, 50, 100, and 200 files. Default linear band: 0.9 to 1.15.
  Both are settings.
- Fixed cost is subtracted before fitting.
- A pack's verdict is its worst Guardrail's verdict.
- Bench runs in Warden's own test and at the `boundary` tier, never at `edit`
  or `commit`.
- Real-run per-file time is shown as information, with no verdict.

- Bench runs at compile admission and in Warden's own test, cached per
  Guardrail, not at a check tier.
- Lint verdicts use rule time; `eslint-pass` is its own row and can fail.
- Early-exit checks write a `run` record but are left out of the combined
  median. A pack's median leaves out runs where it did no work.

## Left to the builder

- The exact name and wording of each report column.
- How `tsc` reports its program's file count (for example,
  `--listFilesOnly`, or counting from the tsconfig include).
- Whether the timing injection for tests is a fake adapter or a clock
  parameter.
