# Architecture pack, version 1: build plan

Spec: `docs/design/2026-11-18-warden-architecture-pack-design.md` (approved by
Ryan, November 18, 2026). Tracking bead: `cm-wkqedr.24`. Engine needs for the
rest of the spec: `cm-wkqedr.25`.

## Scope

Version 1 ships what existing adapters enforce with per-file results that the
ratchet can baseline:

- ARCH-6, **only a source reaches the world**, as two ESLint core-rule
  Guardrails.
- ARCH-7 (one direction) and ARCH-9 (syntactic proxy) merged into one practice,
  **sources only emit**, as one ESLint core-rule Guardrail.

Every other ARCH practice waits on `cm-wkqedr.25`:

- cmd results count project-wide, and `writeBaseline` refuses a project-wide
  failure.
- The ESLint adapter registers only the `warden` plugin.
- `ProjectConfig` has no per-pack settings.

## Global constraints

- Write only `packs/architecture/**`, `test/architecture-pack.test.ts`, and
  `docs/design/**`. Never edit `src/`, `eslint-plugin/`, `schema/`, `scripts/`,
  `packs/core/`, `packs/principles/`, or `packs/collection-folders/`.
- No comments in any `.ts` file (Warden checks itself with `no-comments`).
- Tests set `WARDEN_HOME` to a temp directory and run with
  `npx vitest run <file> --maxWorkers=2`.
- Never use `--no-verify`. Commit subjects end with `(cm-wkqedr.24)`.
- Practice and Guardrail ids start with `architecture-`, because ids are
  unique across all packs.
- Terms carry no `bans`. A ban applies to every pack's practice statements.
- The pack is `layer: 1`.

## Task 1: Pack file with the world boundary

Create `packs/architecture/pack.yaml`:

```yaml
id: architecture
layer: 1
terms:
  - id: world
    definition: Anything outside the process's own memory, which is the file system, child processes, the network, and the clock.
    bans: []
  - id: source
    definition: Code in a sources folder that reads the world and produces data as an Observable.
    bans: []
  - id: sink
    definition: Code in a sinks folder that consumes data and writes it to a store, a log, or a view.
    bans: []
  - id: port
    definition: The one file through which code outside a group reaches it, declaring only the group's types and its factory type.
    bans: []
practices:
  - id: architecture-world-only-in-sources
    statement: Only a source reaches the world.
    terms: [source, world]
    paths: ["!**/{sources/**,*.test.*,*.spec.*}"]
    conflictsWith: []
    guardrails:
      - id: architecture-world-modules
        kind: lint
        runs: [edit, commit]
        budgetMs: 5000
        version: 1
        implementation: "eslint:no-restricted-imports"
        options:
          patterns:
            - regex: "^(node:)?(fs|fs/promises|child_process|net|http|https|http2|dgram|dns|dns/promises|tls|worker_threads)$"
              message: "Only a source reaches the world. Move this read into the sources folder of its group, and return its data as an Observable."
        mustFail:
          src/git/format.ts: "import { readFileSync } from \"node:fs\";\nexport const readConfig = (path: string): string => readFileSync(path, \"utf8\");\n"
        mustPass:
          src/git/sources/config-file.ts: "import { readFileSync } from \"node:fs\";\nexport const readConfig = (path: string): string => readFileSync(path, \"utf8\");\n"
      - id: architecture-world-timers
        kind: lint
        runs: [edit, commit]
        budgetMs: 5000
        version: 1
        implementation: "eslint:no-restricted-globals"
        options:
          - { name: setTimeout, message: "Only a source reaches the clock. Move this timer into the sources folder of its group." }
          - { name: setInterval, message: "Only a source reaches the clock. Move this timer into the sources folder of its group." }
          - { name: setImmediate, message: "Only a source reaches the clock. Move this timer into the sources folder of its group." }
          - { name: fetch, message: "Only a source reaches the network. Move this call into the sources folder of its group." }
          - { name: XMLHttpRequest, message: "Only a source reaches the network. Move this call into the sources folder of its group." }
          - { name: WebSocket, message: "Only a source reaches the network. Move this call into the sources folder of its group." }
        mustFail:
          src/git/retry.ts: "export const later = (run: () => void): void => {\n  setTimeout(run, 1000);\n};\n"
        mustPass:
          src/git/sources/ticks.ts: "export const later = (run: () => void): void => {\n  setTimeout(run, 1000);\n};\n"
```

If ESLint 9.39.5 rejects `regex` in `no-restricted-imports` patterns, stop and
report BLOCKED. Don't switch to `group`, because a gitignore-style `fs`
pattern also matches a relative `../fs`.

Create `test/architecture-pack.test.ts`, modeled on `test/core-pack.test.ts`.
Use a config with packs `core` and `architecture`, each with paths
`["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]`, and `WARDEN_HOME` set to a temp
directory. The tests:

1. `checkConsistency(set)` returns `[]`, and `runExamples(set)` returns `[]`.
2. Each of `fs`, `node:fs`, `fs/promises`, `node:child_process`, `net`,
   `http`, `https`, and `worker_threads`, imported from `src/g/a.ts`, fails
   `architecture-world-modules`.
3. The same `node:fs` import passes in `src/g/sources/a.ts`, `src/g/a.test.ts`,
   and `src/g/sources/deep/a.ts`.
4. Relative imports `../fs` and `./net`, and the package `fs-extra`, pass in
   `src/g/a.ts`.
5. `setTimeout`, `setInterval`, and `fetch` used in `src/g/a.ts` fail
   `architecture-world-timers`, and pass in `src/g/sources/a.ts`.
6. A parameter named `fetch` (`export const call = (fetch: () => void): void
   => fetch();`) passes in `src/g/a.ts`.

## Task 2: Sources only emit

Add to `practices` in `packs/architecture/pack.yaml`:

```yaml
  - id: architecture-sources-only-emit
    statement: A source imports no sink, and every function a source exports returns an Observable.
    terms: [source, sink]
    paths: ["**/sources/**"]
    conflictsWith: []
    guardrails:
      - id: architecture-source-shape
        kind: lint
        runs: [edit, commit]
        budgetMs: 5000
        version: 1
        implementation: "eslint:no-restricted-syntax"
        options:
          - selector: "ImportDeclaration[source.value=/(^|\\/)sinks(\\/|$)/]"
            message: "A source imports no sink. Return an Observable, and let the composition root connect it to the sink."
          - selector: "ExportAllDeclaration[source.value=/(^|\\/)sinks(\\/|$)/], ExportNamedDeclaration[source.value=/(^|\\/)sinks(\\/|$)/], ImportExpression[source.value=/(^|\\/)sinks(\\/|$)/]"
            message: "A source re-exports or loads no sink. Return an Observable, and let the composition root connect it to the sink."
          - selector: "ExportNamedDeclaration > FunctionDeclaration:not([returnType.typeAnnotation.typeName.name='Observable']), ExportDefaultDeclaration > FunctionDeclaration:not([returnType.typeAnnotation.typeName.name='Observable']), ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression:not([returnType.typeAnnotation.typeName.name='Observable']), ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > FunctionExpression:not([returnType.typeAnnotation.typeName.name='Observable'])"
            message: "Every function a source exports declares an Observable return type."
        mustFail:
          src/git/sources/status.ts: "import { writeStatus } from \"../sinks/status\";\nexport const readStatus = (): number => writeStatus(1);\n"
        mustPass:
          src/git/sources/status.ts: "import { Observable } from \"rxjs\";\nexport const watchStatus = (): Observable<number> => new Observable<number>((subscriber) => subscriber.next(1));\n"
```

Add tests to `test/architecture-pack.test.ts`:

1. In `src/g/sources/bad.ts`, each of these fails `architecture-source-shape`
   with the matching message: an import from `../sinks/status`, an
   `export * from "../sinks/x"`, a re-export `export { x } from "../sinks/x"`,
   a dynamic `import("../sinks/y")` inside an exported Observable function, an
   exported `async function` returning `Promise<number>`, an exported arrow
   function returning `number`, an exported function with no return type, and
   an `export default function` returning `number`.
2. In `src/g/sources/good.ts`, these pass: functions returning
   `Observable<number>`, an exported type, an exported string constant, and an
   import from `../parse`.
3. An import from `../sinks/status` in `src/g/format.ts` (outside `sources`)
   passes this Guardrail.
4. An import from `../sinkhole/x` in a source passes.

Then add a section **Built in version 1** at the end of
`docs/design/2026-11-18-warden-architecture-pack-design.md`:

- Name the three Guardrails and their practices.
- Say the merged practice covers ARCH-7 in one direction only.
- Say it covers ARCH-9 by the declared return type, not the inferred one.
- Say every other ARCH practice waits on `cm-wkqedr.25`.

## Release (controller, not a task)

1. Merge `architecture-pack` into Warden `main` and push.
2. In a scratch git repo with `WARDEN_HOME` set to scratch, run
   `warden init --packs core,architecture`.
3. Show that `warden check` passes with a world read inside `sources/`.
4. Show that it fails with a world read outside `sources/`.
5. Record the commands and output in `cm-wkqedr.24`.
