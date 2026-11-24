// Shared by the idempotency and proofs packs. Each pack keeps its own byte-identical
// copy because a pack script may load only files inside its own folder, which the
// lock hashes. test/cli/property-packs.test.ts keeps the copies identical.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect, isDeepStrictEqual } from "node:util";

const SKIP = new Set(["node_modules", ".git", ".lake", ".warden", "dist", "build"]);

export function findSpecs(root, suffix) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && suffix.some((s) => entry.name.endsWith(s))) found.push(relative(root, path));
    }
  };
  walk(root);
  return found.sort();
}

export async function loadSpec(root, file) {
  const spec = (await import(pathToFileURL(join(root, file)).href)).default;
  if (spec === null || typeof spec !== "object") throw new Error(`${file}: export the spec object as the default export`);
  return spec;
}

// mulberry32: a small seeded generator, so a failing case reproduces from its seed.
export const seeded = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ponytail: no shrinking; the finding names the seed and the full input. Add shrinking
// when generated inputs grow too large to read in a finding.
export function inputsOf(file, spec, runs, seed) {
  if (Array.isArray(spec.inputs)) {
    if (spec.inputs.length === 0) throw new Error(`${file}: give inputs at least one case`);
    return spec.inputs.map((input, index) => ({ input, label: `inputs[${index}]` }));
  }
  if (typeof spec.inputs !== "function") throw new Error(`${file}: set inputs to an array of cases or a function (random) => case`);
  const random = seeded(seed);
  return Array.from({ length: runs }, (_, index) => ({ input: spec.inputs(random), label: `generated case ${index + 1} of seed ${seed}` }));
}

export const same = isDeepStrictEqual;

export const show = (value) => inspect(value, { depth: 6, breakLength: Infinity, maxArrayLength: 20, maxStringLength: 200 });

export function settingsOf(defaults) {
  const settings = { ...defaults, ...JSON.parse(process.env.WARDEN_SETTINGS ?? "{}") };
  for (const key of ["runs", "seed"]) {
    if (!Number.isSafeInteger(settings[key]) || settings[key] < (key === "runs" ? 1 : 0)) throw new Error(`Set the ${key} setting to a whole number`);
  }
  return settings;
}

// Exit 0 when every case holds, 1 with one line per finding, 2 when the spec or setup is broken.
export async function main(check) {
  try {
    const findings = await check();
    for (const line of findings) console.log(line);
    process.exitCode = findings.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`${String(error?.message ?? error).replace(/\.$/, "")}. Next action: fix the spec or setup named above, then rerun the check.`);
    process.exitCode = 2;
  }
}
