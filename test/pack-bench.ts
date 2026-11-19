import { resolve } from "node:path";
import { vi } from "vitest";
import { runBench } from "../src/cli/bench.js";

const wardenRoot = resolve(import.meta.dirname, "..");

export async function benchPack(root: string, pack: string): Promise<{ code: number; out: string }> {
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    return { code: await runBench(root, wardenRoot, { pack }), out };
  } finally {
    vi.restoreAllMocks();
  }
}
