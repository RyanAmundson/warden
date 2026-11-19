# Warden architecture pack: groups, ports, adapters, sources, and sinks

Status: approved by Ryan, November 18, 2026. Tracking task:
`cm-wkqedr.13`, under the Warden epic `cm-wkqedr`.

Builds on:

- The Warden design spec,
  [`2026-11-18-warden-guardrail-framework-design.md`](2026-11-18-warden-guardrail-framework-design.md),
  including its collection-folders pack.
- Ryan's Histra decisions in Context Manager Next `docs/ARCHITECTURE.md`
  (branch `claude/context-manager-restructure-190639`), November 7 and 10,
  2026.
- Context Manager's `docs/architecture/file-structure.md` and
  `docs/architecture/core-boundaries.md` (rules B1 to B10) on `origin/main`.
- Ryan's vocabulary: Source and sink, Adapter inversion, Co-location,
  Contract, Separability, Lean but swappable.

## Intent

Ryan's description (November 18, 2026): organize "by responsibility and
implementation, so that things are organized in logical groups that also
theoretically could be pulled out and replaced without digging through a
bunch of different modules," using "ports and adapters" and "sinks and
sources."

This restates decisions Ryan already made for Histra:

- "I prefer logical groups around functionality rather than type."
- Units meet only through their contract, and only the composition root wires
  implementations.
- "Everything that is consumed from filesystem/native cli and other places are
  considered data sources."
- A replacement is admitted only if it passes the role's conformance tests.

Histra enforced most of these by review only. On November 10, 2026, it
removed its lint bans ("No lint rule encodes an architecture rule"). Warden
exists to make rules like these fail deterministically, so this pack replaces
that decision.

**The core idea (Ryan, November 18, 2026).** A judgment such as "is this a
port or an adapter?" becomes static when each Term declares checkable
obligations. A file's path says which Term it claims to be. Warden proves the
file meets that Term's obligations. Paths carry the claim, Terms carry the
meaning, and Guardrails check the match.

## Goals

- Every responsibility lives in one group folder, which is replaceable by
  changing only the composition root.
- A file's role (port, implementation, adapter, source, sink) can be read from
  its path, with no record to look up.
- Every obligation a role carries is checked by a static Guardrail. What can't
  be checked is named, given a static proxy where one exists, and offered to
  the decision-model adapter (`cm-wkqedr.12`).
- An existing codebase, such as Context Manager, adopts the pack through the
  ratchet without a big-bang move.

## Non-goals

- Designing the decision-model adapter. This doc lists only what the pack asks
  of it.
- Changing Warden source. Another session owns Warden's code (`cm-wkqedr.11`).
  This doc names the Warden changes the pack needs, and their owners build
  them.
- Moving Context Manager's files. The ratchet records the current state, and
  later tasks move files.

## Anti-goals

- A second map of the folders. Groups are never listed one by one in
  configuration. ("Generate, don't maintain two copies.")
- An interface for its own sake. A group with one implementation gets no
  `adapters/` folder (Lean but swappable, YAGNI).
- A rule that passes on code that breaks it. Each Guardrail ships a
  multi-file must-fail example that it must fail.
- Prose-only rules. Each Practice has at least one Guardrail whose kind is not
  `instruction`.

## Approaches

| Approach | How groups are known | Trade-off | Verdict |
|---|---|---|---|
| A. Path-derived groups with Term obligations | Each item of a declared group collection is a group. Its role folders and port file have fixed names. | Needs a uniform layout; an existing repo baselines its deviations. | **Chosen by Ryan, November 18, 2026.** |
| B. Declared groups | `.warden/` lists every group, its port, and its adapters. | Works on any layout, but the list is a second copy of the tree and drifts. | Rejected: breaks "Generate, don't maintain two copies." |
| C. Model-judged structure | The decision model reads each folder and judges its role. | No layout rules, but probabilistic, slow, and not reproducible. | Rejected as primary; kept as a backstop for the one judgment that stays (see [What stays a judgment](#what-stays-a-judgment)). |

## Terms

Each Term has a fixed definition and the synonyms it bans. The obligations are
the Practices below; a Term record links to them.

| Term | Definition | Bans |
|---|---|---|
| `responsibility` | One capability the system provides, named by one Term. | `concern` (as a folder name), `domain` (as a folder name) |
| `group` | A Unit that owns one responsibility behind one port. It is an item of a group collection. | `module` (for a group), `package` (for a group), `feature` (for a group) |
| `group collection` | A collection (a bracketed folder, or a declared root such as `plugins/`) whose items are groups. | |
| `port` | The one file through which code outside a group reaches it. It declares the group's types and one factory type. In Ryan's vocabulary, the group's Contract. | `interface file`, `facade`, `api` (as a file name) |
| `implementation` | The code inside a group that fulfills its port. With one implementation, it sits beside the port. | |
| `adapter` | One of several swappable implementations of a port, in `<group>/adapters/<name>/`. | `driver`, `provider`, `plugin` (for an adapter) |
| `conformance suite` | The tests a port defines, which every implementation of that port must pass. | `contract test` |
| `world` | Anything outside the process's own memory: the file system, child processes, the network, and the clock. | |
| `source` | Code that reads the world and produces data as an Observable. It lives in a `sources/` folder. | `reader`, `fetcher`, `poller` (as folder names) |
| `sink` | Code that consumes data and writes it to a store, a log, or a view. It lives in a `sinks/` folder. | `writer` (as a folder name) |
| `composition root` | The only files that choose which implementation fills each port, and that connect sources to sinks. | `bootstrap`, `wiring` (as folder names) |

`plugin` stays a Term owned by the project pack. The `adapter` ban on `plugin`
applies only inside a group's `adapters/` folder.

## Layout

```text
[services]/                         group collection
└── git-service/                    group (Term: git)
    ├── git-service.ts              port
    ├── git-service.conformance.ts  conformance suite
    ├── CONTRACT.md                 the Unit's document (core pack)
    ├── sources/                    sources, when the group reads the world
    │   └── status-watcher.ts
    ├── sinks/                      sinks, when the group writes a store or log
    ├── create.ts                   the single implementation's factory, when there is one
    ├── adapters/                   only when there are two or more implementations
    │   ├── cli/create.ts
    │   └── libgit2/create.ts
    └── <other files>               the implementation's other files
```

Reserved names inside a group: the port file, the conformance file,
`create.ts`, `sources/`, `sinks/`, and `adapters/`. A group has either
`create.ts` or `adapters/`, never both. Any other folder or file is part of
the implementation.

## Practices and Guardrails

Each Practice names its paths, the tool that enforces it, and a must-fail and
a must-pass example. "Group paths" means every file under an item of a
declared group collection. Examples use `[services]/git-service`.

### ARCH-1. Outside a group, code imports only its port

- **Paths:** every source file.
- **Guardrail:** `eslint:warden/group-boundaries`, kind `lint`, runs at edit,
  commit, and boundary. It generalizes Context Manager's B10. It resolves each
  import to a file and fails when the target is inside a group, the importer
  is outside that group, and the target is not that group's port. A
  composition root may also import an implementation's `create.ts` (see
  ARCH-2), and nothing else inside a group.
- **Must fail:** `[services]/process-service/run.ts` imports
  `../git-service/sources/status-watcher`.
- **Must pass:** the same file imports `../git-service/git-service`.

### ARCH-2. A port declares only types, and imports only types

- **Paths:** port files.
- **Guardrail:** `eslint:warden/port-shape`, kind `lint`. It fails on any
  runtime statement, including a re-export of an implementation's `create`,
  and on any import that is not `import type` from another group's port, the
  group's own models, or a declared library.
- **Why types only:** Histra's rule is that units import each other's contract
  "as types" and "factories are wired only by `lifecycle`." If a port
  re-exported one implementation, swapping it would mean editing the port, not
  only the composition root.
- **Must fail:** `git-service.ts` contains `export { create } from
  './create'`.
- **Must pass:** `git-service.ts` exports `type GitStatus` and `type
  CreateGitService = (deps: GitDeps) => GitService`, and nothing else.

The composition root imports an implementation's `create` directly: from
`<group>/create.ts` for a single implementation, or from
`<group>/adapters/<name>/create.ts`. ARCH-1 allows exactly those two imports
from a composition root and no other non-port import.

### ARCH-3. Every implementation satisfies its port's factory type

- **Paths:** `<group>/create.ts` for a single implementation, and each
  `<group>/adapters/<name>/create.ts`.
- **Guardrail:** `eslint:warden/implements-port`, kind `type` (a typed lint
  rule). It fails when the exported `create` is not assignable to the port's
  factory type.
- **Must fail:** `adapters/cli/create.ts` exports `create` returning an object
  that lacks `status()`.
- **Must pass:** `export const create: CreateGitService = (deps) => ({ status
  })`.

### ARCH-4. Adapters never import each other

- **Paths:** `**/adapters/*/**` in group paths.
- **Guardrail:** `eslint:warden/adapter-isolation`, kind `lint`. It fails on an
  import from a sibling adapter folder.
- **Must fail:** `adapters/libgit2/parse.ts` imports `../cli/parse`.
- **Must pass:** both adapters import a shared parser from the group's
  implementation files or from a declared library.

### ARCH-5. Every port has a conformance suite, and every implementation runs it

- **Paths:** group folders.
- **Guardrails:**
  - `fs:warden/conformance-present`, kind `lint`: fails when a group has no
    `<group>.conformance.ts`.
  - `eslint:warden/runs-conformance`, kind `lint`: fails when the single
    implementation, or an adapter, has no test file that imports the
    conformance suite and calls it with that implementation's `create`.
- **Must fail:** `adapters/libgit2/` has `create.ts` and `create.test.ts`, and
  the test does not import `git-service.conformance`.
- **Must pass:** `create.test.ts` contains `runGitConformance(create)`.

This is Histra's "replacement by conformance," applied to every group.

### ARCH-6. Only sources reach the world

- **Paths:** every source file except `**/sources/**`, composition roots, and
  test files.
- **Guardrail:** `eslint:warden/world-only-in-sources`, kind `lint`. It fails
  on an import of a declared world module, and on a use of `setTimeout`,
  `setInterval`, or `fetch`. It is a custom rule, not the built-in
  `no-restricted-imports`, for two reasons: Warden's ESLint adapter lets one
  ESLint rule back only one Guardrail, and ARCH-8 needs the same kind of check;
  and in a flat config, two entries for one rule on overlapping paths replace
  each other.
- **Plugins:** Context Manager's project pack forbids `sources/` under
  `plugins/`, so a plugin never uses a timer or a network read directly.
  CANON 44 already says everything that changes over time reaches a plugin as
  a subscription, so a plugin gets the clock from a host source. Whether the
  host offers a clock source today is a Context Manager contract question,
  recorded as a follow-up, not part of this pack.
- **Must fail:** `[services]/git-service/format.ts` imports `node:fs`.
- **Must pass:** `[services]/git-service/sources/status-watcher.ts` imports
  `node:fs`.

### ARCH-7. A source never imports a sink, and a sink never imports a source

- **Paths:** `**/sources/**` and `**/sinks/**`.
- **Guardrail:** `eslint:warden/flow-direction`, kind `lint`. It fails when a
  source imports a file under any `sinks/` folder or a declared sink module,
  and the reverse. The composition root connects them.
- **Must fail:** `sources/status-watcher.ts` imports `../sinks/status-collection`.
- **Must pass:** `status-watcher.ts` returns `Observable<GitStatus>`, and the
  composition root pipes it into the sink.

### ARCH-8. Only sinks write a store

- **Paths:** every source file except `**/sinks/**`, composition roots, and
  test files.
- **Guardrail:** `eslint:warden/store-writes-only-in-sinks`, kind `lint`. It
  fails on an import of a declared sink module (for Context Manager, the RxDB
  write surface). It is a custom rule for the reasons given in ARCH-6.
- **Must fail:** `sources/status-watcher.ts` imports the store's write API.
- **Must pass:** `sinks/status-collection.ts` imports it.

### ARCH-9. A source returns an Observable

- **Paths:** exported functions in `**/sources/**`.
- **Guardrail:** `eslint:warden/source-returns-observable`, kind `type`. It
  fails when an exported function's return type is not an `Observable`.
- **Must fail:** `export async function readStatus(): Promise<GitStatus>`.
- **Must pass:** `export function watchStatus(root: string):
  Observable<GitStatus>`.

### ARCH-10. A group is named for a defined Term

- **Paths:** items of group collections.
- **Guardrail:** `fs:warden/group-named-by-term`, kind `lint`. The folder name,
  less the collection's declared suffix (`-service` for `[services]`), must be
  a defined Term id and not a banned synonym.
- **Must fail:** `[services]/helpers-service/` with no `helpers` Term.
- **Must pass:** `[services]/git-service/` with a `git` Term.

### ARCH-11. Responsibility before technical kind

- **Paths:** technical-kind collections that the project declares, such as
  `[hooks]`, `[utils]`, `[stores]`, and `[types]`.
- **Guardrail:** `graph:warden/shared-by-two-groups`, kind `lint`. It fails
  when an item of a technical-kind collection is imported by fewer than two
  groups. An item that only one group uses belongs in that group
  (Co-location).
- **Must fail:** `src/[hooks]/useGitStatus.ts` is imported only by files in
  `git-service`.
- **Must pass:** `src/[utils]/canonical-json.ts` is imported by two groups.

### ARCH-12. Groups depend on each other without cycles

- **Paths:** group collections.
- **Guardrail:** `graph:warden/acyclic-groups`, kind `lint`. It builds the
  group-to-group graph and fails on a cycle. An edge from group X to group Y
  is any import, from any non-test file in X, that resolves to a file in Y.
  Test files and composition roots add no edges. Histra's
  lifecycle already refuses a cycle in `needs` at run time; this finds it
  before run time.
- **Must fail:** `git-service.ts` imports `process-service.ts`, which imports
  `git-service.ts`.
- **Must pass:** the shared type moves to a third group, or into one of the
  two.

### Proxies for one responsibility

The `principles` pack already limits a Unit's import fan-out and file length.
This pack adds no second copy. It sets those limits on group paths and adds one
setting, the number of runtime exports a port may have, which is baselined
like any other setting.

## What stays a judgment

One question stays that no static Guardrail answers: **does the group's code
match its name?** A `git` group whose source also parses pull request comments
passes every Practice above.

The static proxies narrow it: the port export limit, the fan-out limit, and
ARCH-10. The rest is offered to the decision-model adapter (`cm-wkqedr.12`) as
`model` kind Guardrails. They are optional, and a `review` kind Guardrail
covers them until that adapter exists.

| Check | Input the pack gives the model | Output the pack needs |
|---|---|---|
| The group's code serves its Term | Term definition, group name, port file, exported symbol names, file list | verdict, probability, reason |
| The port names a capability, not an implementation | port file, Term definition | verdict, probability, the offending names |
| A misplaced file's owner | file path, its imports and importers, candidate group Terms | suggested group, probability |

These three checks and their interface are recorded in `cm-wkqedr.12`. The
adapter's own design (kind, threshold, cache, budget, tamper rules) stays in
that task.

## Configuration

A project declares its group collections once. Groups, roles, and Units are
derived from the tree.

```yaml
packs: [core, architecture, principles, collection-folders]
architecture:
  groupCollections:
    - collection: "[services]"
      suffix: "-service"
      port: "{name}/{name}.ts"
    - collection: "plugins"
      port: "{name}/plugin.ts"
  technicalCollections: ["src/[hooks]", "src/[utils]", "src/[stores]", "src/[types]"]
  compositionRoots: ["[apps]/desktop/plugins.ts", "[apps]/desktop/main.ts"]
  world: ["fs", "fs/promises", "child_process", "net", "http", "https", "worker_threads"]
  sinkModules: ["rxdb"]
```

- The port file pattern is configurable because projects already differ:
  Context Manager uses `<name>/<name>.ts` (B10) and `plugin.ts` (CANON 37), and
  Histra uses `contract.ts`.
- Each group is a Warden Unit. Warden generates its Unit record (id from the
  folder name, kind from its collection, document `CONTRACT.md`), so the core
  pack's Unit rules apply to it with no hand-written record.
- The project pack may tighten. Context Manager's pack, for example, forbids a
  `sources/` folder under `plugins/` entirely, because CANON 42 says no plugin
  reads the world. It may not loosen.

### With the collection-folders pack

- A group collection is a collection, so its items are directories. This pack
  requires that only for group collections.
- Context Manager's `file-structure.md` lets other collections hold files
  (`[models]/app.ts`), while the collection-folders pack says a collection
  holds only directories. That open question belongs to the collection-folders
  pack. This pack doesn't depend on its answer.
- Technical-kind collections (ARCH-11) are collections that the collection-folders
  pack checks for shape. This pack checks only who imports their items.

## Rollout and ratchet in Context Manager

Measured on `origin/main` at `74d4bc7f48`, November 18, 2026:

- 12 groups in `[services]`, and all 12 have a root port file. ARCH-1 starts
  close to clean, because B10 already enforces it with a shrink-only exception
  list.
- 2 of the 12 port files export runtime code (a `grep` for exported
  functions, constants, classes, and variables), so ARCH-2 baselines about 2
  files.
- No `adapters/` folder exists, so ARCH-4 has no subjects yet.
- No group has a conformance file, so ARCH-5 baselines 12 entries.
- About 414 non-test files import `fs`, `fs/promises`, `child_process`, `net`,
  `http`, or `https` (a `git grep` of those six names). ARCH-6 starts with a
  large baseline. The ratchet only lets it shrink.

Order:

1. **Legacy first.** As the Warden spec's adoption plan already says, CANON
   invariants and B1 to B10 run as `legacy` `cmd` Guardrails in the
   `context-manager` pack. Nothing changes in the lint.
2. **Pack on, scoped.** Enable the architecture pack on `[services]` only.
   `warden init` writes the baseline. New violations fail; existing ones are
   listed in the burn-down.
3. **Retire duplicates.** When ARCH-1 covers the same paths as B10, and B10's
   probes in `test/plugin-conformance/boundaryRules.test.ts` pass as ARCH-1's
   must-fail examples, delete B10 and its exception list from
   `eslint.architecture.mjs`. Do the same for B9 when ARCH-6 and ARCH-8 cover
   plugins.
4. **Widen.** Add `plugins` and the technical-kind collections, one at a time,
   each with its own baseline.

CANON invariants 36 to 44 stay in the project pack: they are about plugins and
the host, which is a project concept. This pack holds only the general part
(ports, flow direction, and the world boundary), which the project pack builds
on.

## What Warden needs, and who builds it

| Need | Why | Owner |
|---|---|---|
| `mustFail` and `mustPass` accept a fixture directory as well as a string | Import rules need two or more files to fail. | Warden schema (`cm-wkqedr.11` or its successor) |
| The `fs` adapter | ARCH-5 and ARCH-10. It is already proposed by the collection-folders pack. | Warden adapters |
| A `graph` adapter that builds the import graph once with the TypeScript compiler API | ARCH-11 and ARCH-12. Warden already depends on TypeScript for the `tsc` adapter, so this adds no new dependency. A `cmd` wrapper around dependency-cruiser was considered; it adds a dependency and a second module resolver that can disagree with `tsc`. | Warden adapters |
| Typed ESLint rules (`warden/implements-port`, `warden/source-returns-observable`) | ARCH-3 and ARCH-9 need type information. | Warden ESLint plugin |
| Generated Unit records for items of group collections | Groups come from the tree, not from records (Approach A). | Warden compiler |
| A per-pack settings block in the project config | `ProjectConfig` today holds only `packs: { id, paths }[]` (`src/records/types.ts:43`), so the `architecture:` block has nowhere to go. | Warden schema |

**What the build covers.** The pack's plan covers the whole stack, in order:
the Warden changes above go first, through Warden's owner, then the pack's
records and fixture trees, then the Context Manager rollout. The custom rules
live in Warden's ESLint plugin, beside `no-comments`. The `principles` and
`collection-folders` packs don't exist yet. This pack needs neither to start:
it uses neither pack's Guardrails, and the fan-out and length proxies wait for
`principles`.

The custom ESLint rules read the pack configuration at lint time rather than
emitting one zone per group. If the emitter generated per-group zones, every
new folder would change a generated file and its lock, which would make adding a
group a lock change.

## Conflict to resolve in the principles pack

The `principles` pack's YAGNI row says "no interface with a single
implementation." A port with one implementation is exactly that. Because a
higher pack may never loosen a lower one, this pack can't carve an exception.
The principles pack's statement must name the exception itself: "no interface
with a single implementation, except a `port`."

Warden loads packs in layer order and refuses two packs on one layer
(`src/compiler/consistency.ts`), and the design spec says a lower layer
never depends on a higher one. For `principles` to use the `port` Term, the
architecture pack takes layer 1, directly above `core`, and `principles`
takes layer 2.
This needs no Warden change. Both packs are generic. Layer order here only
says which one's Terms the other may use.

## Calls made in this doc, for Ryan to check

These are the author's calls, not Ryan's decisions:

- A port holds types only, and an implementation's factory lives in
  `create.ts`. This follows Histra's "as types" rule. In Context Manager, the
  2 port files that export runtime code are baselined.
- Every group has a conformance suite, even with one implementation. That
  makes Histra's "replacement by conformance" apply to every group, not only
  core roles. In Context Manager, all 12 services are baselined.
- `adapters/` appears only with a second implementation.
- The role folder names (`sources/`, `sinks/`, `adapters/`) are fixed.
  Context Manager's `data-source-service` keeps its `git/` and `ingestion/`
  folders in the baseline until it moves.
- The architecture pack is layer 1, below `principles`.
- The `graph` adapter uses the TypeScript compiler API, not
  dependency-cruiser.

## Left to the builder

- The exact AST checks inside each custom rule, as long as each one fails its
  must-fail example and passes its must-pass example.
- The conformance suite's calling convention, as long as ARCH-5 can detect a
  call to the suite with the implementation's `create`.
- Messages, which follow Warden's one-formatter rule: the compliant example and
  one next action.

## Built in version 2

Version 2 ships every ARCH practice. The pack ships its own code beside
`pack.yaml`: `eslint.js` holds ESLint rules, `fs.js` holds tree checks, and
`graph.js` holds import-graph checks. A Guardrail names one as
`<adapter>:architecture/<name>`, and Warden loads it from the pack's folder,
the same folder `WARDEN_PACK_DIR` names for a `cmd` Guardrail. The lock hashes
these files with the rest of the pack. Pack code may import only Node
built-in modules and files inside its own pack folder, so everything it runs
is hashed. Warden refuses any other import, and any link that points outside
the folder. A non-literal `import()` is not checked.

The project sets the pack's settings on its config entry. `pack.yaml`
declares their JSON Schema, with defaults, and Warden refuses settings that do
not match it:

```yaml
packs:
  - id: architecture
    paths: ["**/*.ts"]
    settings:
      groupCollections: [{ collection: "[services]", suffix: "-service", port: "{name}/{name}.ts" }]
      technicalCollections: ["src/[hooks]", "src/[utils]"]
      compositionRoots: ["[apps]/desktop/main.ts"]
      world: [fs, fs/promises, child_process, net, http, https]
      sinkModules: [rxdb]
```

Examples run with the schema's first `examples` entry, never with the
project's settings, so a project's settings cannot break a bundled example.
The lock records each Guardrail's resolved settings, so a change to them
against the base branch is loosening, like a change to its options. An edit
to a local pack's shipped code is loosening too. Bench admission is keyed on
the hash of every file in the pack's folder, so an edit to the code benches
its Guardrails again.

| Practice | Guardrail | Adapter |
|---|---|---|
| ARCH-1 | `architecture-group-boundaries` | `eslint` |
| ARCH-2 | `architecture-port-shape` | `eslint` |
| ARCH-3 | `architecture-implements-port` | `eslint` |
| ARCH-4 | `architecture-adapter-isolation` | `eslint` |
| ARCH-5 | `architecture-conformance-present`, `architecture-runs-conformance` | `fs`, `graph` |
| ARCH-6 | `architecture-world-modules`, `architecture-world-globals` | `eslint` |
| ARCH-7 | `architecture-source-shape`, `architecture-sink-imports-no-source` | `eslint` |
| ARCH-8 | `architecture-store-writes` | `eslint` |
| ARCH-9 | `architecture-source-shape` | `eslint` |
| ARCH-10 | `architecture-group-named-by-term` | `fs` |
| ARCH-11 | `architecture-shared-by-two-groups` | `graph` |
| ARCH-12 | `architecture-acyclic-groups` | `graph` |

The `fs` and `graph` Guardrails read the whole tree, so `warden check` runs
them at the commit and boundary tiers over every file in the config's pack
paths, not only changed files. Each violation names a file, so `warden init`
and `warden compile` baseline them file by file.

Limits of what version 2 covers:

- ARCH-1, ARCH-3, and ARCH-4 resolve only relative imports. An alias such as
  `@/[services]/x` passes.
- ARCH-2 checks that a port holds only types. It does not check where a
  port's type imports come from; ARCH-1 covers imports from other groups.
- ARCH-3 checks that `create` is declared with a type imported from the
  port. The project's own type-check proves that `create` is assignable to it.
- ARCH-5 counts an implementation as running its suite when a test file in
  the implementation's folder imports both the suite and `create`. It does
  not check the call.
- ARCH-9 checks the declared return type, not the inferred one.
- A source may still export a call result, such as
  `export const read = promisify(readFile)`.
- ESLint core rules no longer belong to one pack: each Guardrail runs its own
  copy of the rule with its own options.
