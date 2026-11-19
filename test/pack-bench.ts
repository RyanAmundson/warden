import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { runBench } from "../src/cli/bench.js";

const wardenRoot = resolve(import.meta.dirname, "..");

export const CODE_PATHS = '["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]';

export async function bench(pack: string, paths: string, opts: { pack?: string; rule?: string }): Promise<{ code: number; out: string }> {
  const root = await mkdtemp(join(tmpdir(), `warden-${pack}-scaling-`));
  let out = "";
  try {
    await mkdir(join(root, ".warden"), { recursive: true });
    await writeFile(
      join(root, ".warden/config.yaml"),
      ["warden: 0.1.0", "project: sample", "base: main", "packs:", `  - id: ${pack}`, `    paths: ${paths}`, "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }", "loopBreakerRepeats: 3", ""].join("\n"),
    );
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    return { code: await runBench(root, wardenRoot, opts), out };
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
}
