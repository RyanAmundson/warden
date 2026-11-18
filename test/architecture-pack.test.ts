import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkConsistency } from "../src/compiler/consistency.js";
import { runExamples } from "../src/compiler/examples.js";
import { eslintAdapter } from "../src/adapters/eslint.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { runGuardrails } from "../src/runner/run.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const code = "[\"**/*.{ts,tsx,mts,cts,js,mjs,cjs}\"]";
const config = [
  "warden: 0.1.0",
  "project: sample",
  "base: main",
  "packs:",
  "  - id: core",
  `    paths: ${code}`,
  "  - id: architecture",
  `    paths: ${code}`,
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

let root: string;
let home: string;
let set: RecordSet;
let guardrails: Guardrail[];

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const check = async (id: string, source: string, file: string) => {
  const gs = guardrails.filter((g) => g.id === id);
  await write(file, source);
  for (const [path, content] of Object.entries(eslintAdapter.emit(gs, set))) await write(path, content);
  const [result] = await runGuardrails(set, gs, [file], { root, generatedDir: join(root, ".warden/generated") });
  return result?.status;
};

const importing = (name: string): string => `import * as m from "${name}";\nexport const used = m;\n`;
const modules = "architecture-world-modules";
const timers = "architecture-world-timers";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-architecture-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  process.env.WARDEN_HOME = home;
  await write(".warden/config.yaml", config);
  set = await loadRecords(root, wardenRoot);
  guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
});

afterEach(async () => {
  delete process.env.WARDEN_HOME;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("architecture pack world boundary", () => {
  it("is consistent and its examples hold", async () => {
    expect(checkConsistency(set)).toEqual([]);
    expect(await runExamples(set)).toEqual([]);
  });

  it.each(["fs", "node:fs", "fs/promises", "node:child_process", "net", "http", "https", "worker_threads"])("fails a %s import outside sources", async (name) => {
    expect(await check(modules, importing(name), "src/g/a.ts")).toBe("fail");
  });

  it.each(["src/g/sources/a.ts", "src/g/a.test.ts", "src/g/sources/deep/a.ts"])("allows a node:fs import in %s", async (file) => {
    expect(await check(modules, importing("node:fs"), file)).toBe("pass");
  });

  it.each(["../fs", "./net", "fs-extra"])("allows the import %s", async (name) => {
    expect(await check(modules, importing(name), "src/g/a.ts")).toBe("pass");
  });

  it.each([
    ["setTimeout", "export const later = (run: () => void): void => {\n  setTimeout(run, 1);\n};\n"],
    ["setInterval", "export const again = (run: () => void): void => {\n  setInterval(run, 1);\n};\n"],
    ["fetch", "export const load = (): void => {\n  fetch(\"x\");\n};\n"],
  ])("fails %s outside sources and passes it in sources", async (_name, source) => {
    expect(await check(timers, source, "src/g/a.ts")).toBe("fail");
    expect(await check(timers, source, "src/g/sources/a.ts")).toBe("pass");
  });

  it("allows a parameter named fetch", async () => {
    expect(await check(timers, "export const call = (fetch: () => void): void => fetch();\n", "src/g/a.ts")).toBe("pass");
  });
});
