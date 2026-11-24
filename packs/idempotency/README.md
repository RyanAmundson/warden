# Idempotency checks

Enable the `idempotency` pack to prove that an operation is safe to replay and safe to retry after a crash. The check runs your real operation code at the boundary tier, on generated inputs.

Add this entry under `packs` in `.warden/config.yaml` and run `warden compile`. Activate the configuration and lock with a signed policy change.

```yaml
- id: idempotency
  paths: []
  settings:
    runs: 50
    seed: 1
```

## Write an operation spec

Name each spec `<operation>.idempotency.js`, `.mjs`, or `.ts`, anywhere in the project outside `node_modules`. Its default export has these members:

- `setup()`: returns a fresh world, such as an in-memory store, a fake client, or a temporary database.
- `run(world, input, step)`: runs the operation under test. Call `await step()` between the operation's writes.
- `snapshot(world)`: returns the state the operation decides, including recorded side effects such as sent messages or charges.
- `inputs`: an array of cases, or a function `(random) => case` that Warden calls `runs` times with a generator seeded by `seed`.
- `teardown(world)`: optional cleanup.

```js
import { charge } from "./src/payments.js";

export default {
  setup: () => ({ charges: {}, receipts: [] }),
  run: (world, request, step) => charge(world, request, step),
  snapshot: (world) => world,
  inputs: (random) => ({ id: `r${Math.floor(random() * 1000)}`, amount: 1 + Math.floor(random() * 100) }),
};
```

## What the check proves

For each case, Warden starts from a fresh `setup()` and compares snapshots:

1. **Deterministic:** two single runs give the same snapshot. If they differ, snapshot only the state the operation decides, not timestamps or random IDs.
2. **Replay:** two runs give the same snapshot as one run. A retried request must not charge, send, or append twice.
3. **Crash and retry:** for each `step()` the operation reaches, Warden throws from that step, runs the operation again, and compares the result with one clean run. This catches an operation that records "done" before its last write, so the retry skips the rest.

Each finding names the spec, the property, the case, and both snapshots. A generated case names its seed, so the same `seed` reproduces it. Warden does not shrink a failing case to a smaller one.

Run `warden check --base main --tier boundary --rule idempotent-operations` to run the check. Run `warden bench --pack idempotency` to measure the declared passing example within the boundary budget. The check's cost grows with `runs` and with the number of `step()` calls, not with the size of the repository.
