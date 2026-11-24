import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { findSpecs, inputsOf, loadSpec, main, same, settingsOf, show } from "./cases.js";

const SUFFIX = [".conformance.js", ".conformance.mjs", ".conformance.ts"];
const MODEL_TIMEOUT_MS = 15_000;
const SHOWN = 3;

// The model reads one JSON case per stdin line and prints one JSON result per stdout line,
// in order. One process serves every case, so a compiled Lean model starts once.
export function runModel(file, spec, cases, root, project) {
  const argv = spec.model;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((w) => typeof w === "string")) {
    throw new Error(`${file}: set model to the command that runs the proved model, as an argument list such as ["lake", "exe", "model"]`);
  }
  const cwd = spec.cwd ?? project;
  if (typeof cwd !== "string" || isAbsolute(cwd)) throw new Error(`${file}: set cwd to a project-relative folder`);
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: join(root, cwd),
    input: `${cases.map(({ input }) => JSON.stringify(input)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: MODEL_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error) throw new Error(`${file}: the model command ${argv.join(" ")} did not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${file}: the model command ${argv.join(" ")} exited with ${result.status ?? result.signal}: ${result.stderr.trim().slice(0, 400)}`);
  const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== cases.length) throw new Error(`${file}: the model printed ${lines.length} results for ${cases.length} cases; print one JSON line per input line`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${file}: model result ${index + 1} is not JSON: ${line.slice(0, 200)}`);
    }
  });
}

export async function checkSpec(file, spec, root, { project, runs, seed }) {
  if (typeof spec.implementation !== "function") throw new Error(`${file}: export implementation as the function under test`);
  const cases = inputsOf(file, spec, runs, seed);
  const expected = runModel(file, spec, cases, root, project);
  const findings = [];
  let differ = 0;
  for (const [index, { input, label }] of cases.entries()) {
    const actual = JSON.parse(JSON.stringify(await spec.implementation(input)) ?? "null");
    if (same(actual, expected[index])) continue;
    differ += 1;
    if (differ <= SHOWN) findings.push(`${file}: the implementation returned ${show(actual)}, but the proved model returns ${show(expected[index])} (${label}, input ${show(input)})`);
  }
  if (differ > SHOWN) findings.push(`${file}: ${differ - SHOWN} more cases differ from the proved model`);
  return findings;
}

export async function check() {
  const root = process.cwd();
  const settings = settingsOf({ project: "proofs", runs: 200, seed: 1 });
  const files = findSpecs(root, SUFFIX);
  if (files.length === 0) throw new Error("Add a conformance spec named <logic>.conformance.js, .mjs, or .ts");
  const findings = [];
  for (const file of files) findings.push(...await checkSpec(file, await loadSpec(root, file), root, settings));
  return findings;
}

if (import.meta.main) await main(check);
