# Folder-json pack

An opt-in pack that requires the
[collection-folders pack](2026-11-18-collection-folders-pack.md).

Below a collection, folders are shaped like JSON. A file is a property, a
folder is an object, and a collection is an array. A folder with subfolders
holds at most one file; only a leaf folder, one with no subfolders, such as a
component folder, holds many files.

## Practice

| Practice | Guardrail | Fails on |
|---|---|---|
| `folders-hold-one-file-until-the-leaf` | `warden-folders-hold-one-file-until-the-leaf` | a folder below a collection that has subfolders and more than one file |

Each failure lists the folder, its file count, and its files, then a count and
one next action.

## Decisions

- The rule is Ryan's (November 18, 2026). He agreed that it is a separate
  opt-in pack that requires collection-folders, which stays limited to
  bracketed folders.
- The one file in a non-leaf folder is allowed, not required. This was left
  open for Ryan; a folder with subfolders and no files passes.

## Calls made here, for Ryan to check

- The rule applies to every folder below a collection: each item folder and
  every folder under it. Folders outside any collection, such as the
  repository root or `src/`, are not checked, because the pack cannot tell a
  feature folder from any other folder there.
- A collection's own files are left to `warden-collection-holds-only-folders`,
  so one stray file is not reported twice.

## How it requires collection-folders

The Practice names the `collection` Term, which collection-folders defines.
Without that pack, `warden compile` reports `undefined-term`, whose next action
says to enable the pack that defines the Term before this one. The pack's layer,
4, sits above collection-folders' 3, so it is listed after it.

## Limits

The Guardrail is a `cmd` Guardrail with the same inline file listing and the
same limits as the [collection-folders Guardrails](2026-11-18-collection-folders-pack.md#limits):
a failure is project-wide and cannot be baselined, the configured paths are
ignored, and at most 19 folders show before the count line.
- The script sets `process.exitCode` instead of calling `process.exit`, so a
  listing larger than a pipe buffer still reaches its count and next action.
