import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Guardrail, RecordSet } from "../../src/records/types.js";

export const treeGuardrail = (implementation: string, packDir: string): Guardrail => ({ id: "g", kind: "lint", runs: ["commit"], budgetMs: 10000, version: 1, implementation, packDir });

export const treeSet = (g: Guardrail): RecordSet => ({
  root: "",
  config: { project: "p", base: "main", packs: [{ id: "local", paths: ["src/**"], settings: { word: "b" } }], tierBudgetMs: { edit: 1000, commit: 1000, boundary: 1000 }, loopBreakerRepeats: 3 },
  packs: [{ id: "local", file: "pack.yaml", layer: 0, capabilities: [], terms: [{ id: "t", definition: "d", bans: [] }], practices: [{ id: "x", pack: "local", statement: "s", terms: [], paths: ["**/*.ts"], conflictsWith: [], guardrails: [g] }] }],
});

export async function shippedPack(adapter: string, code: string): Promise<{ dir: string; remove: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), "warden-tree-pack-"));
  const dir = join(base, "local");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${adapter}.js`), code);
  return { dir, remove: () => rm(base, { recursive: true, force: true }) };
}
