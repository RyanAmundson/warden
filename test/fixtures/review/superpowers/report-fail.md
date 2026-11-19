I read the requirements and the diff, then ran the scoped tests.

Verdict: FAIL
Reviewed head: 1111111111111111111111111111111111111111

Some prose the parser ignores.

### Important 1. The retry still swallows the error
- Where: src/run.ts:42
- Reproduces on: head
- Spec: yes
- Earlier: 1
- Flaky: no
- Correction condition: run throws the original error after the last retry.

### Minor 2. The help text names the old flag
- Where: src/cli.ts:7
- Reproduces on: head, base
- Spec: no
- Flaky: no
- Correction condition: the help text names --base.

### Environment 3. vitest is not installed in the worktree
- Reproduces on: head
- Spec: no
- Flaky: no
- Correction condition: npx vitest --version exits 0 in the worktree.

That is all.
