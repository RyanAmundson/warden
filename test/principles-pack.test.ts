import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExamples } from "../src/compiler/examples.js";
import { eslintAdapter } from "../src/adapters/eslint.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { runGuardrails } from "../src/runner/run.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const paths = "[\"**/*.{ts,tsx,mts,cts,js,mjs,cjs}\"]";
const config = [
  "warden: 0.1.0",
  "project: sample",
  "base: main",
  "packs:",
  "  - id: core",
  `    paths: ${paths}`,
  "  - id: principles",
  `    paths: ${paths}`,
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

const ids = [
  "principles-complexity",
  "principles-nesting-depth",
  "principles-function-length",
  "principles-parameter-count",
  "principles-file-length",
  "principles-one-class-per-file",
  "principles-unused-locals",
  "principles-useless-constructor",
  "principles-unused-private-members",
];

const lines = (n: number, line: (i: number) => string): string =>
  Array.from({ length: n }, (_, i) => line(i)).join("\n");

const branches = (n: number): string =>
  `export const f = (a: number): number => {\n${lines(n, (i) => `  if (a === ${i}) return ${i};`)}\n  return a;\n};\n`;

const nested = (n: number): string =>
  `export const f = (a: number): void => {\n${lines(n, (i) => `${"  ".repeat(i + 1)}if (a > ${i}) {`)}\n${lines(n, (i) => `${"  ".repeat(n - i)}}`)}\n};\n`;

const longFunction = (total: number): string =>
  `export const f = (): void => {\n${lines(total - 2, () => "  Math.abs(1);")}\n};\n`;

let root: string;
let set: RecordSet;
let guardrails: Guardrail[];

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const check = async (id: string, source: string) => {
  const gs = guardrails.filter((g) => g.id === id);
  await write("src/a.ts", source);
  for (const [file, content] of Object.entries(eslintAdapter.emit(gs, set))) await write(file, content);
  const results = await runGuardrails(set, gs, ["src/a.ts"], { root, generatedDir: join(root, ".warden/generated") });
  return results.find((r) => r.guardrail === id)?.status;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-principles-"));
  await write(".warden/config.yaml", config);
  set = await loadRecords(root, wardenRoot);
  guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("principles pack", () => {
  it("principles pack examples hold", async () => {
    const pack = set.packs.find((p) => p.id === "principles");
    expect(pack?.practices.flatMap((x) => x.guardrails).map((g) => g.id)).toEqual(ids);
    expect(await runExamples(set)).toEqual([]);
  });

  it.each([
    ["principles-complexity", branches(9), "pass"],
    ["principles-complexity", branches(10), "fail"],
    ["principles-nesting-depth", nested(3), "pass"],
    ["principles-nesting-depth", nested(4), "fail"],
    ["principles-function-length", longFunction(50), "pass"],
    ["principles-function-length", longFunction(51), "fail"],
    ["principles-parameter-count", "export const f = (a: number, b: number, c: number, d: number): number => a + b + c + d;\n", "pass"],
    ["principles-parameter-count", "export const f = (a: number, b: number, c: number, d: number, e: number): number => a + b + c + d + e;\n", "fail"],
    ["principles-file-length", `${lines(300, (i) => `export const x${i} = ${i};`)}\n`, "pass"],
    ["principles-file-length", `${lines(301, (i) => `export const x${i} = ${i};`)}\n`, "fail"],
    ["principles-one-class-per-file", "export class A {}\n", "pass"],
    ["principles-one-class-per-file", "export class A {}\nexport class B {}\n", "fail"],
    ["principles-unused-locals", "const x = { a: 1, b: 2 };\nconst { a, ...rest } = x;\nexport { rest };\n", "pass"],
    ["principles-unused-locals", "const x = { a: 1, b: 2 };\nconst { a, ...rest } = x;\nexport { a };\n", "fail"],
    ["principles-unused-locals", "export type F = (unused: number) => void;\nconst unused = 1;\n", "fail"],
    ["principles-unused-locals", "export type F = (unused: number) => void;\n", "pass"],
    ["principles-unused-locals", "const unused = 1;\n", "fail"],
  ])("%s: %#", async (id, source, status) => {
    expect(await check(id, source)).toBe(status);
  });
});
