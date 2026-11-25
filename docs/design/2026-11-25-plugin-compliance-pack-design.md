# Plugin-compliance pack

Status: built. Ryan decided the open questions on November 25, 2026 (see
"Decisions").

Ryan, November 25, 2026: "if plugins were isolated from the compliance checks,
and the compliance checks were isolated from the actual app, then all we need
to do is, when we're building a plugin, we just run Warden. It will tell us if
we're there or not."

The `plugin-compliance` pack checks plugins written for the plugin SDK that
declares a plugin with `definePlugin` and a manifest of features, services,
slots, and collections. It replaces a compliance check that lived inside a
host application and ran 17 rows against one plugin folder. The pack reads
nothing of an app: only the plugin's folder and the SDK package the plugin has
installed.

## What the pack is

- The SDK's plugin contract is the pack's domain, the way Lean is the proofs
  pack's domain: `definePlugin`, the manifest's shape, the reserved `host`
  namespace, the absence of `shell.*` slots, and the `[absent:<id>]` and
  `[contract:<id>]` test tags are SDK facts the pack knows.
- A project's layout is not. Where plugins live, which folders they may share
  code from, which import specifiers reach host code, and which are legacy
  bridges are pack settings. No default names one project.
- It is a registry admission check that a person runs on demand. Every
  Guardrail runs at the `boundary` tier only, so the pre-commit hook and the
  edit hook never run it. The pack adds no hook, CI job, or per-commit step.
  Like every Warden check, it reports and exits 0.
- It follows Warden's pack rule: a pack holds normalized definitions and pure
  check functions, and an adapter does the tool work. The pack imports no
  tool. The `fs:` adapter hands it file text and the TypeScript parser; the
  new `module:` adapter also hands it a module's exports.

## How a plugin author runs it

```bash
warden check --tier boundary --base main
```

Run it anywhere in the plugin's checkout. Warden's root is the Git root, so:

- In a repository that holds one plugin, the default `plugins: ["."]` checks
  the root.
- In a repository of many plugins, set `plugins` to the folders that hold
  them, such as `["plugins/*"]`. One run checks every plugin. Each finding
  names a file inside its plugin's folder, and every plugin's known gaps sit
  in the baseline, so only a new gap fails.

A clean run prints nothing and records `pass` for all 17 rules, which
`warden runs` lists. Each failure line names its row, such as
`FAIL plugins/notes/main/main.ts:12  pq-logs-1`. Add `--rule pq-sdk-2` to run
one row.

## Settings

```yaml
packs:
  - id: plugin-compliance
    paths: ["**/*"]
    settings:
      plugins: ["plugins/*"]           # folders that each hold one plugin; default ["."]
      sharedCode: [libs]               # folders a plugin may import by relative path; default []
      hostImports: ["^@app/"]          # PQ-sdk.2: regexes for host code or another plugin; default []
      legacyImports: ["^@sdk/shims/"]  # PQ-sdk.3: regexes for legacy bridges; default []
      worldModules: [electron]         # PQ-world.1: added to the Node built-ins the pack lists
      consoleFolders: [cli]            # PQ-logs.1: folder names where console output is allowed; default []
      nonProduction: []                # regexes added to the pack's test, story, and fixture patterns
      skipFolders: []                  # folder names skipped, added to node_modules, dist, coverage
      contractLock: contracts.lock.json  # PQ-interop.11's record, inside each plugin folder
```

`plugins` and `sharedCode` are folder paths, not globs, because bracketed
folder names such as `[libs]` are character classes in a glob. An entry of
`plugins` ending in `/*` names each folder directly inside it. Keep the pack's
`paths` at `["**/*"]`: Warden runs each Guardrail's examples under `plugin/`,
and a narrower `paths` would hide them.

The check this pack replaces hard-coded its host's shared-library folder in
PQ-sdk.2: a relative import that left the plugin folder passed when its target
was inside that folder. In the pack that folder is `sharedCode`. The host's
import aliases, its plugin package prefix, its legacy bridges, its extra world
modules, its command-line folders, its story file patterns, and its archive
folders are settings too.

## The 17 rows

Eight rows are decided from the plugin's source files. They run as `fs:`
Guardrails and parse each file with the TypeScript parser that the adapter
supplies, so comments and strings never count. Each finding names a file and a
line, which lets Warden's baseline hold it.

| Row | Guardrail | Implementation | Reads |
|---|---|---|---|
| PQ-sdk.1 | `warden-pq-sdk-1` | `fs:plugin-compliance/declaration` | `plugin.ts` calls `definePlugin`; no `plugin.json` |
| PQ-sdk.2 | `warden-pq-sdk-2` | `fs:plugin-compliance/isolation` | every import; relative ones resolved against the plugin folder and `sharedCode` |
| PQ-sdk.3 | `warden-pq-sdk-3` | `fs:plugin-compliance/legacy` | every import against `legacyImports`, tests included |
| PQ-world.1 | `warden-pq-world-1` | `fs:plugin-compliance/world` | production value imports of world modules; world globals; `process.env` |
| PQ-world.2 | `warden-pq-world-2` | `fs:plugin-compliance/polling` | `setInterval`, `createPoller`, rxjs `interval`, periodic rxjs `timer` |
| PQ-effects.1 | `warden-pq-effects-1` | `fs:plugin-compliance/git-writes` | git write strings and `('git', [verb, ...])` calls |
| PQ-logs.1 | `warden-pq-logs-1` | `fs:plugin-compliance/console` | `console.*` outside `consoleFolders` |
| PQ-docs.1 | `warden-pq-docs-1` | `fs:plugin-compliance/documents` | `README.md`, `CONTRACT.md`, and a `CHANGELOG.md` heading for `package.json`'s version |

Nine rows are decided from the manifest. An SDK manifest is composed from
features when `plugin.ts` runs, so no parser can read it. These rows run as
`module:` Guardrails: the check calls `load("<plugin>/plugin.ts")` and gets
the exports as data.

| Row | Guardrail | Implementation | Also reads |
|---|---|---|---|
| PQ-interop.1 | `warden-pq-interop-1` | `module:plugin-compliance/namespaced` | — |
| PQ-interop.2 | `warden-pq-interop-2` | `module:plugin-compliance/presented` | — |
| PQ-interop.3 | `warden-pq-interop-3` | `module:plugin-compliance/peers-listed` | production `registry.request` targets; `CONTRACT.md` |
| PQ-interop.4 | `warden-pq-interop-4` | `module:plugin-compliance/peers-absent` | test files for `[absent:<id>]` |
| PQ-interop.5 | `warden-pq-interop-5` | `module:plugin-compliance/commands` | — |
| PQ-interop.8 | `warden-pq-interop-8` | `module:plugin-compliance/keyed` | — |
| PQ-interop.9 | `warden-pq-interop-9` | `module:plugin-compliance/documented` | `CONTRACT.md`; test files for `[contract:<id>]` |
| PQ-interop.11 | `warden-pq-interop-11` | `module:plugin-compliance/recorded` | the plugin's `contractLock` file |
| PQ-interop.12 | `warden-pq-interop-12` | `module:plugin-compliance/contributions` | — |

A plugin with no `plugin.ts` passes the nine manifest rows; PQ-sdk.1 reports
the missing declaration. A `plugin.ts` that does not load fails each manifest
row with the load error.

Each row keeps the old check's logic, with these changes:

- The project-specific names above come from settings.
- A finding about a missing file, such as `README.md is missing`, names the
  plugin's `package.json`, or its `plugin.ts` or first file when it has none,
  because Warden's baseline counts findings per file.
- A manifest-row finding names `plugin.ts`, the contract lock, or the line of
  the `registry.request` it is about.
- `worldModules` and `hostImports` entries match a module and its subpaths, so
  `fs` also covers `fs/promises`.
- PQ-interop.11's finding for an unrecorded contract prints the entry to add,
  so no recording command is needed.

## The module adapter

`module:` is a Warden adapter, not pack code, so any pack can use it. It is
the `fs:` adapter's input plus `load(file)`:

- `load` accepts only a file the check was given.
- A loader process imports the file with a Node module hook that transpiles
  TypeScript with Warden's bundled compiler and resolves bundler-style
  specifiers (`./x.js` for `./x.ts`, and extensionless `./x`). Bare imports
  resolve from the project's installed `node_modules`.
- The exports come back as data, as `JSON.stringify` would write them, except
  that a function becomes `{ "$function": "<name>" }` and only a true cycle
  becomes `"[Circular]"`; an object two fields share is written in both.
  The pack's fingerprints drop `$function` values, so they equal fingerprints
  taken from the live manifest.
- Each file loads once per run, in its own Node process, outside the sandbox,
  because loading runs the module's code. The check itself still runs in the
  sandbox.

## How the ratchet becomes a Warden baseline

Warden's `.warden/baseline.json` holds counts per Guardrail and per file:

- A file whose findings rise above its baselined count fails.
- A boundary check lowers a count when gaps are fixed, so it can never rise
  back unseen.
- Counting per file closes the gap the old code's `ponytail:` note named:
  fixing a gap in one file and adding one in another no longer passes.

Migration translates no counts. When a project enables the pack, `warden
compile` measures every new Guardrail and writes the current gaps into
`.warden/baseline.json`.

PQ-interop.11's record of published contracts is not a gap count. It is the
plugin's statement of what it published, so it stays in the plugin folder, in
`contracts.lock.json`, an object of `"<id>@<major>": { "<part>": "<fingerprint>" }`.

## What stays in the app

The replaced check ran five steps besides compliance. They all read the app's
configuration, so they stay app gates:

| Step | Why it stays in the app |
|---|---|
| generated plugin catalog check | checks the app's own generated catalog |
| scoped type-check, including the composition root | compiles the plugin with the app's compiler options and host declarations |
| the plugin's tests | runs them with the app's test runner configuration |
| lint | applies the app's own lint rules |
| strict types (PQ-types.1) | the app's strict TypeScript profile for certification |

## Decisions (Ryan, November 25, 2026)

1. **How the manifest rows get the manifest.** Ryan: "It needs to follow
   Warden's pack rules. They're normalized definitions, and then an adapter is
   used to convert them into the thing that does the analysis." So the
   loading lives in the new `module:` adapter, and the pack keeps pure check
   functions. The proposed pack-owned loader script and the project's `tsx`
   were both rejected.
2. **Ratchet.** Warden's baseline, which lowers counts itself, per file.
3. **Contract record.** `contracts.lock.json` in each plugin folder.
4. **App gates.** None of the five other steps move.

## Evidence

- `test/plugin-compliance-pack.test.ts` runs every Guardrail's must-pass and
  must-fail example, and checks the exact findings of each row on sample
  plugins, including a plugin whose `plugin.ts` does not load.
- `test/adapters/module.test.ts` checks the module adapter: TypeScript and
  bundler-style imports, an installed package, shared objects and cycles, a
  load error, and a refused file.
- Run against a repository of 10 plugins, the pack and the check it replaces
  reported the same gaps for every plugin and row, including every recorded
  contract fingerprint. Seeding the baseline, adding one gap, and fixing one
  gap behaved as described above.

## Limits

- Loading `plugin.ts` runs the plugin's declaration module and what it
  imports. `main` and `renderer` stay unloaded when they are lazy imports.
  Run the check only on code you would run.
- The SDK must be installed, and built where its package's `exports` point at
  built files.
- The module adapter starts one Node process per loaded module, with a
  2-minute timeout. A run that loads many modules would batch them into one
  process.
- `warden check` cannot restrict a run to one plugin folder. In a repository
  of many plugins, a run checks all of them.
