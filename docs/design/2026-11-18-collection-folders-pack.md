# Collection-folders pack

A collection is a folder with a bracketed name, such as `[services]`. It is an
array: it holds item folders of one kind. Every other folder is an object.

## Practices

| Practice | Guardrail | Fails on |
|---|---|---|
| `collection-holds-only-folders` | `warden-collection-holds-only-folders` | a file directly inside a collection |
| `collections-do-not-nest` | `warden-collections-do-not-nest` | `[a]/[b]` |
| `collection-names-are-plural-kebab-case` | `warden-collection-names-are-plural-kebab-case` | a collection name that is not `[kebab-case]` ending in `s` |
| `collection-items-share-one-shape` | `warden-collection-items-share-one-shape` | an item whose top-level file and folder names differ from the shape most items in its collection share |

Each failure names one file, says what is wrong there, and gives one "Do this" line.

## Decisions (Ryan, November 18, 2026)

- A collection holds only folders. Single-file items are deviations.
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

Each Guardrail is an `fs` Guardrail of kind `lint`, whose check ships in
`packs/collection-folders/fs.js`. `warden check` runs it over every file in
the config's pack paths that `git ls-files --cached --others --exclude-standard`
lists, so ignored files are skipped. Only folders that contain at least one
file are seen.

Each violation names a file, so `warden init` and `warden compile` baseline
existing deviations file by file:

- A loose file is reported on itself.
- A nested or misnamed collection is reported on the first file inside it, in
  path order.
- An item that differs in shape is reported on its first file.

## Limits

- A collection or an item is anchored to its first file. When a file sorts
  before the anchor, the baselined entry moves to the new file and counts as a
  new violation there.
- The checks read the config's pack paths, so Next.js dynamic route folders
  such as `[id]` look like collections. Leave them out of the pack's paths.
