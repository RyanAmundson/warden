import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, vi } from "vitest";
import { runBench } from "../src/cli/bench.js";
import { loadRecords } from "../src/records/load.js";

const wardenRoot = resolve(import.meta.dirname, "..");

export const CODE_PATHS = '["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]';

const project = async (pack: string, paths: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), `warden-${pack}-scaling-`));
  await mkdir(join(root, ".warden"), { recursive: true });
  await writeFile(
    join(root, ".warden/config.yaml"),
    ["warden: 0.1.0", "project: sample", "base: main", "packs:", `  - id: ${pack}`, `    paths: ${paths}`, "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }", "loopBreakerRepeats: 3", ""].join("\n"),
  );
  return root;
};

export async function guardrailIds(pack: string, paths: string): Promise<string[]> {
  const root = await project(pack, paths);
  try {
    const found = (await loadRecords(root, wardenRoot)).packs.find((p) => p.id === pack);
    if (found === undefined) throw new Error(`no bundled pack has id ${pack}`);
    return found.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction").map((g) => g.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function bench(pack: string, paths: string, opts: { rule: string }, { signal, onTestFinished }: TestContext): Promise<{ code: number; out: string }> {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const root = project(pack, paths);
  const run = root.then((r) => runBench(r, wardenRoot, { ...opts, signal }));
  onTestFinished(async () => {
    await Promise.allSettled([run]);
    spy.mockRestore();
    await rm(await root, { recursive: true, force: true });
  });
  return { code: await run, out };
}
