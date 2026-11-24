# Proof checks

Enable the `proofs` pack to prove rules about your logic in Lean 4 and to check that the shipped code follows the proved model. The pack has two boundary checks:

- `proofs-check` builds the Lean project and fails on any proof error, `sorry`, `admit`, or `axiom`.
- `code-matches-proved-model` runs the compiled Lean model and your implementation on the same generated inputs, and fails when they return different results.

A proof covers only the Lean model. The conformance check ties that model to the code you ship.

## Setup

Install Lean with [elan](https://github.com/leanprover/elan) so `lake` is on `PATH`. Add this entry under `packs` in `.warden/config.yaml` and run `warden compile`. Activate the configuration and lock with a signed policy change.

```yaml
- id: proofs
  paths: []
  settings:
    project: proofs
    runs: 200
    seed: 1
```

## Write the proofs

Keep a Lake project at `project`, with `lakefile.toml` or `lakefile.lean` and a `lean-toolchain` that pins the Lean version. `lake build` builds its default targets, so include both the proofs library and the model executable.

```toml
name = "proofs"
defaultTargets = ["Proofs", "model"]

[[lean_lib]]
name = "Proofs"

[[lean_exe]]
name = "model"
root = "Model"
```

State the rules as theorems about a Lean definition:

```lean
def clamp (lo hi x : Nat) : Nat := max lo (min hi x)

theorem clamp_le_hi (lo hi x : Nat) (h : lo ≤ hi) : clamp lo hi x ≤ hi := by
  unfold clamp; omega
```

The check scans the Lean sources, skipping comments and strings, and reports each `sorry`, `admit`, and `axiom` by line. It also reports each Lean error and each `declaration uses sorry` warning from the build. The build has a 50-second limit.

## Bind the model to the code

The model executable reads one JSON case per input line and prints one JSON result per line, in order:

```lean
import Lean.Data.Json
import Proofs

structure Case where
  lo : Nat
  hi : Nat
  x : Nat
  deriving Lean.FromJson

partial def loop (stdin stdout : IO.FS.Stream) : IO Unit := do
  let line ← stdin.getLine
  if line.isEmpty then return
  match Lean.Json.parse line >>= Lean.fromJson? (α := Case) with
  | .ok c => stdout.putStrLn (toString (clamp c.lo c.hi c.x))
  | .error e => throw (IO.userError e)
  loop stdin stdout

def main : IO Unit := do loop (← IO.getStdin) (← IO.getStdout)
```

Name each conformance spec `<logic>.conformance.js`, `.mjs`, or `.ts`. Its default export has these members:

- `model`: the command that runs the model, as an argument list. It runs in `cwd`, which defaults to the `project` setting.
- `implementation(input)`: calls the shipped code and returns its result. Warden compares results as JSON.
- `inputs`: an array of cases, or a function `(random) => case` that Warden calls `runs` times with a generator seeded by `seed`.

```js
import { clamp } from "./src/clamp.ts";

export default {
  model: ["lake", "exe", "model"],
  implementation: ({ lo, hi, x }) => clamp(lo, hi, x),
  inputs: (random) => {
    const lo = Math.floor(random() * 50);
    return { lo, hi: lo + Math.floor(random() * 50), x: Math.floor(random() * 120) };
  },
};
```

Node loads a `.ts` spec or implementation with its built-in type stripping, so import TypeScript files by their full name. Each finding names the case, the implementation's result, and the model's result. Warden shows the first three differences and counts the rest.

Run `warden check --base main --tier boundary --rule proofs-check` or `--rule code-matches-proved-model`. Run `warden bench --pack proofs` to measure the declared passing examples within the boundary budget.
