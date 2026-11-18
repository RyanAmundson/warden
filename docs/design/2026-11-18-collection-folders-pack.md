# Collection-folders pack

Bead: cm-wkqedr.10. Source design: the "Collection-folders pack" section of
Context Manager's `docs/superpowers/specs/2026-11-18-warden-guardrail-framework-design.md`
(commit 49b788d).

A collection is a folder with a bracketed name, such as `[services]`. It is an
array: it holds item folders of one kind. Every other folder is an object.

## Practices

| Practice | Guardrail | Fails on |
|---|---|---|
| `collection-holds-only-folders` | `warden-collection-holds-only-folders` | a file directly inside a collection |
| `collections-do-not-nest` | `warden-collections-do-not-nest` | `[a]/[b]` |
| `collection-names-are-plural-kebab-case` | `warden-collection-names-are-plural-kebab-case` | a collection name that is not `[kebab-case]` ending in `s` |
| `collection-items-share-one-shape` | `warden-collection-items-share-one-shape` | an item whose top-level file and folder names differ from the shape most items in its collection share |

Each failure lists the offending paths, then a count and one next action.

## Decisions (Ryan, November 18, 2026)

- A collection holds only folders. Single-file items, as in Context Manager's
  root `[models]`, are deviations.
- "Items are one type" uses a same-shape check: every item has the same
  top-level entries as the most common item shape in its collection. The design
  asked for a declared item layout per collection; a pack cannot know a
  project's layouts, so Ryan chose the heuristic.
- An entry named after its item's folder, exactly or followed by a dot, is
  compared with that prefix replaced by `<item>`, so `Button/Button.tsx` and `Card/Card.tsx` share
  the shape `<item>.tsx` (Ryan, after review). Without this, every component
  folder had a unique shape. An entry matches when either its own name or its
  `<item>` form is expected, and a failure names the real file, such as
  `Knob.tsx`.
- A collection whose two most common shapes tie is skipped, because no shape
  is the one its items should match.
- Plural is approximated: the last word ends in `s`. `[lib]`, `[delivery]`,
  and `[timeline]` fail.

## How the Guardrails run

There is no `fs` adapter yet, so each Guardrail is a `cmd` Guardrail running an
inline `node -e` script. The script lists files with
`git ls-files --cached --others --exclude-standard` inside a git work tree, so
ignored files are skipped. Outside a work tree, such as Warden's example
project, it walks the directory and skips `node_modules` and `.git`. Only folders
that contain at least one file are seen.

The kind is `runtime`, not `lint`. `warden check` treats `lint` results as
per-file and drops a `cmd` violation, whose file is empty, so a `cmd` Guardrail
of kind `lint` would never fail. `type` would run, but it would misstate a
filesystem script as a type check.

## Limits

- A `cmd` failure is project-wide, and `writeBaseline` refuses project-wide
  failures. `warden init` with this pack therefore fails in a repository that
  already has a violation, and existing deviations cannot be baselined. An `fs`
  adapter that reports per-file violations removes this limit.
- The failure message starts with the whole inline command, because the `cmd`
  adapter prints the command before the output. The adapter keeps the last 20
  output lines, so a failure shows at most 19 paths before its count line.
- The same file-listing prefix is repeated in all four scripts, because a `cmd`
  command cannot reference a file inside the pack.
- A `cmd` script scans the whole repository and ignores the pack's configured
  paths. Next.js dynamic route folders such as `[id]` look like collections, so
  do not enable this pack in a repository that uses them.
- Outside a git work tree, the walk descends into `node_modules` before
  filtering it, and skips symbolic links.

## Measured in Context Manager (November 18, 2026)

Tracked and untracked, not ignored, files:

| Guardrail | Violations |
|---|---|
| holds only folders | 204 loose files |
| do not nest | 1: `[libs]/ui-kit/src/[primitives]/[utils]` |
| plural kebab-case | 5 folders: `[lib]`, `[delivery]`, `[timeline]` |
| one shape | 80 items in 8 of 68 collections; 30 tied collections skipped |

The whole scan of 6,875 files takes about 0.2 seconds per Guardrail.
