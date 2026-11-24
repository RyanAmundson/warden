import { findSpecs, inputsOf, loadSpec, main, same, settingsOf, show } from "./cases.js";

const SUFFIX = [".idempotency.js", ".idempotency.mjs", ".idempotency.ts"];

class Crash extends Error {}

// Runs the operation once per plan entry against one fresh world. A nonzero entry throws
// from the operation's k-th step() call, standing in for a process crash at that point.
async function outcome(spec, input, plan) {
  const world = await spec.setup();
  try {
    let steps = 0;
    for (const crashAt of plan) {
      let count = 0;
      const step = () => {
        count += 1;
        if (count === crashAt) throw new Crash();
      };
      try {
        await spec.run(world, input, step);
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
      }
      steps = Math.max(steps, count);
    }
    return { state: await spec.snapshot(world), steps };
  } finally {
    await spec.teardown?.(world);
  }
}

export async function checkSpec(file, spec, { runs, seed }) {
  for (const key of ["setup", "run", "snapshot"]) {
    if (typeof spec[key] !== "function") throw new Error(`${file}: export ${key} as a function`);
  }
  const findings = [];
  const found = new Set();
  const report = (kind, label, input, message) => {
    if (found.has(kind)) return;
    found.add(kind);
    findings.push(`${file}: ${message} (${label}, input ${show(input)})`);
  };
  for (const { input, label } of inputsOf(file, spec, runs, seed)) {
    const once = await outcome(spec, input, [0]);
    const again = await outcome(spec, input, [0]);
    if (!same(once.state, again.state)) {
      report("deterministic", label, input, `one run from a fresh setup gave two different snapshots, ${show(once.state)} and ${show(again.state)}, so snapshot only state the operation decides`);
      continue;
    }
    const twice = await outcome(spec, input, [0, 0]);
    if (!same(once.state, twice.state)) {
      report("replay", label, input, `running twice left ${show(twice.state)}, but one run leaves ${show(once.state)}`);
    }
    for (let crashAt = 1; crashAt <= once.steps; crashAt += 1) {
      const retried = await outcome(spec, input, [crashAt, 0]);
      if (!same(once.state, retried.state)) {
        report("retry", label, input, `a crash at step ${crashAt} of ${once.steps} and a retry left ${show(retried.state)}, but one clean run leaves ${show(once.state)}`);
        break;
      }
    }
  }
  return findings;
}

export async function check() {
  const root = process.cwd();
  const settings = settingsOf({ runs: 50, seed: 1 });
  const files = findSpecs(root, SUFFIX);
  if (files.length === 0) throw new Error("Add an operation spec named <operation>.idempotency.js, .mjs, or .ts");
  const findings = [];
  for (const file of files) findings.push(...await checkSpec(file, await loadSpec(root, file), settings));
  return findings;
}

if (import.meta.main) await main(check);
