import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { benchKey, subjectsOf } from "../../src/compiler/bench.js";
import { loadRecords } from "../../src/records/load.js";
import { BENCH_DEFAULTS } from "../../src/records/types.js";

let root: string;

const pack = (word: string): string =>
  [
    "id: local",
    "layer: 1",
    "terms: []",
    "settings:",
    "  type: object",
    "  properties: { word: { type: string } }",
    `  examples: [{ word: ${word} }]`,
    "practices:",
    "  - { id: p, statement: s, terms: [], paths: [], conflictsWith: [], guardrails: [{ id: g, kind: lint, runs: [commit], budgetMs: 100, version: 1, implementation: \"fs:local/c\", mustFail: { a.ts: x }, mustPass: { a.ts: y } }] }",
    "",
  ].join("\n");

const key = async (): Promise<string> => {
  const set = await loadRecords(root, ".");
  const [subject] = subjectsOf(set, set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails)));
  return benchKey(subject as never, "0.0.0", BENCH_DEFAULTS);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-bench-key-"));
  await mkdir(join(root, ".warden/packs/local"), { recursive: true });
  await writeFile(join(root, ".warden/config.yaml"), "project: p\nbase: main\npacks:\n  - { id: local, paths: [] }\ntierBudgetMs: { edit: 1, commit: 1, boundary: 1 }\nloopBreakerRepeats: 3\n");
  await writeFile(join(root, ".warden/packs/local/pack.yaml"), pack("a"));
  await writeFile(join(root, ".warden/packs/local/fs.js"), "export default { c: () => [] };\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("an edit to a pack's shipped code makes compile bench its Guardrails again", async () => {
  const before = await key();
  await writeFile(join(root, ".warden/packs/local/fs.js"), "export default { c: ({ files }) => files.flatMap(() => []) };\n");
  expect(await key()).not.toBe(before);
});

it("a change to a pack's example settings makes compile bench its Guardrails again", async () => {
  const before = await key();
  await writeFile(join(root, ".warden/packs/local/pack.yaml"), pack("b"));
  expect(await key()).not.toBe(before);
});
