---
name: main-audit
description: Find Warden's published findings for the files you are changing. Use when asked what to check or fix in the current task based on the main audit.
---

# Check your change against published findings

From your project or linked worktree, run the installed helper. Pass the
repository-relative files you own in this task. Repeat `--path` for each file.

```sh
python3 /path/to/main-audit/scripts/read-audit.py --path src/example.ts
```

Without paths, the helper uses the current Git diff from the merge base of
the watched ref, plus untracked, unignored files. Use explicit paths in a
shared worktree or when the branch contains unrelated changes. Without explicit
paths, an empty diff with no untracked files returns no scope.

The helper returns up to ten findings in the selected files. Each item names
its published commit and whether it matches the locally available watched ref.
The receipt describes the published snapshot. Confirm each finding in the
current code and run the project's targeted check before calling it your regression or
claiming a fix. An empty result means no matching detail was available. Some
receipts cap their details or report check errors.

Use `--watch` for live results in the same scope and stop the command when
you're done. The subscription prints an initial result and another JSON line
when scoped results change. It never creates a project watch or runs checks.
For a daemon on a different local port, pass `--port PORT`.

Use the dashboard for the full audit. Keep the task focused on its own files
and the checks needed to verify its changes.
