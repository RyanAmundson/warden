import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExamples } from "../src/compiler/examples.js";
import { eslintAdapter } from "../src/adapters/eslint.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { applyBaseline, measureBaseline, writeBaseline } from "../src/runner/baseline.js";
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
  "principles-duplicate-blocks",
  "principles-unused-exports",
  "principles-single-implementation",
  "principles-duplicate-exports",
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

const block = (name: string, gap = ""): string =>
  `export const ${name} = (n: number): number => {\n${lines(7, (i) => `  const x${i + 1} = ${i === 0 ? "n" : `x${i}`} + ${i + 1};${gap}`)}\n  return x7;\n};\n`;

const scan = async (id: string, tree: Record<string, string>) => {
  for (const [file, content] of Object.entries(tree)) await write(file, content);
  const g = guardrails.find((x) => x.id === id) as Guardrail;
  const [result] = await runGuardrails(set, [g], [], { root, generatedDir: join(root, ".warden/generated") });
  return result;
};

const found = async (id: string, tree: Record<string, string>): Promise<string[]> =>
  ((await scan(id, tree))?.violations ?? []).map((v) => `${v.file}:${v.line}${v.endLine === undefined ? "" : `-${v.endLine}`}: ${v.message}`);

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
    ["principles-function-length", `export const f = (): void => {\n${lines(48, () => "  Math.abs(1);\n")}};\n`, "pass"],
    ["principles-parameter-count", "export const f = (a: number, b: number, c: number, d: number): number => a + b + c + d;\n", "pass"],
    ["principles-parameter-count", "export const f = (a: number, b: number, c: number, d: number, e: number): number => a + b + c + d + e;\n", "fail"],
    ["principles-file-length", `${lines(300, (i) => `export const x${i} = ${i};`)}\n`, "pass"],
    ["principles-file-length", `${lines(301, (i) => `export const x${i} = ${i};`)}\n`, "fail"],
    ["principles-file-length", `${lines(300, (i) => `export const x${i} = ${i};\n`)}\n`, "pass"],
    ["principles-one-class-per-file", "export class A {}\n", "pass"],
    ["principles-one-class-per-file", "export class A {}\nexport class B {}\n", "fail"],
    ["principles-unused-locals", "const x = { a: 1, b: 2 };\nconst { a, ...rest } = x;\nexport { rest };\n", "pass"],
    ["principles-unused-locals", "const x = { a: 1, b: 2 };\nconst { a, ...rest } = x;\nexport { a };\n", "fail"],
    ["principles-unused-locals", "export type F = (unused: number) => void;\n", "pass"],
    ["principles-unused-locals", "const unused = 1;\n", "fail"],
  ])("%s: %#", async (id, source, status) => {
    expect(await check(id, source)).toBe(status);
  });

  it("duplicate blocks: names the later copy and the block it repeats, as one range per copy", async () => {
    expect(await found("principles-duplicate-blocks", { "src/a.ts": block("a"), "src/b.ts": `const pad = 1;\n${block("b")}` })).toEqual([
      "src/b.ts:3-10: lines 3-10 repeat the block that starts at src/a.ts:2",
    ]);
  });

  it("duplicate blocks: one copy longer than 8 lines is one violation, and comments and blank lines are not significant", async () => {
    const long = (name: string): string => `export const ${name} = (n: number): number => {\n${lines(12, (i) => `  const x${i + 1} = ${i === 0 ? "n" : `x${i}`} + ${i + 1};`)}\n  return x12;\n};\n`;
    const spaced = long("b").replace("const x3", "// spacer\n\n  const x3");
    expect(await found("principles-duplicate-blocks", { "src/a.ts": long("a"), "src/b.ts": spaced })).toEqual(["src/b.ts:2-16: lines 2-16 repeat the block that starts at src/a.ts:2"]);
  });

  it("duplicate blocks: a run of identical lines inside one block is not a copy of itself, and test files are not read", async () => {
    expect((await scan("principles-duplicate-blocks", { "src/a.ts": `${lines(9, () => "Math.abs(1);")}\n`, "src/a.test.ts": block("a"), "src/b.test.ts": block("b") }))?.status).toBe("pass");
  });

  it("unused exports: an import, a namespace member, and a re-export each count as a use from another file", async () => {
    const tree = {
      "src/a.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const own = 4;\nexport default 5;\nconsole.log(own);\n",
      "src/use.ts": 'import { a as alias } from "./a";\nimport * as $all from "./a";\nexport { c } from "./a";\nconsole.log(alias, $all.b);\n',
    };
    expect(await found("principles-unused-exports", tree)).toEqual(["src/a.ts:4: own is exported, but no other file imports it"]);
  });

  it("single implementation: names the interface and its class, and exempts a port", async () => {
    const shape = "export interface Shape {\n  area(): number;\n}\n";
    const square = 'import type * as port from "./shape";\nexport class Square implements port.Shape {\n  area(): number {\n    return 1;\n  }\n}\n';
    expect(await found("principles-single-implementation", { "src/shape.ts": shape, "src/square.ts": square })).toEqual([
      "src/shape.ts:1: interface Shape has one implementation, the class at src/square.ts:2",
    ]);
    await rm(join(root, "src"), { recursive: true });
    expect((await scan("principles-single-implementation", { "src/[services]/shape/shape.ts": shape, "src/[services]/shape/square.ts": square }))?.status).toBe("pass");
  });

  it("duplicate exports: names each later file, and skips re-exports, default exports, and create files", async () => {
    const tree = {
      "src/a.ts": "export const step = 1;\nexport default 1;\n",
      "src/b.ts": "const step = 2;\nexport { step };\nexport default 2;\n",
      "src/c.ts": 'export { step } from "./a";\n',
      "src/[services]/x/create.ts": "export const create = 1;\n",
      "src/[services]/y/create.ts": "export const create = 2;\n",
    };
    expect(await found("principles-duplicate-exports", tree)).toEqual(["src/b.ts:2: step is also exported from src/a.ts:1"]);
  });

  it("a script given an argument exits 2 with one next action", async () => {
    const script = join(wardenRoot, "packs/principles/bin/duplicate-blocks.mjs");
    let out = "";
    try {
      execFileSync("node", [script, "extra"], { cwd: root, encoding: "utf8" });
    } catch (cause) {
      expect((cause as { status: number }).status).toBe(2);
      out = (cause as { stdout: string }).stdout;
    }
    expect(out.trimEnd().split("\n")).toEqual([`${script} takes no arguments and got extra. Next action: run node "${script}" with no arguments from the project root.`]);
  });

  it("in a git repository a script reads tracked and untracked files and skips ignored ones, and its violations can be baselined", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await write(".gitignore", "dist/\n");
    await write("dist/a.ts", "export const step = 1;\n");
    await write("src/a.ts", "export const step = 2;\n");
    expect((await scan("principles-duplicate-exports", {}))?.status).toBe("pass");
    await write("src/b.ts", "export const step = 3;\n");
    const g = guardrails.find((x) => x.id === "principles-duplicate-exports") as Guardrail;
    const { baseline } = await measureBaseline(set, [g]);
    expect(baseline).toEqual({ "principles-duplicate-exports": { "src/b.ts": 1 } });
    expect(() => writeBaseline(root, baseline)).not.toThrow();
    const results = await runGuardrails(set, [g], [], { root, generatedDir: join(root, ".warden/generated") });
    expect(applyBaseline(results, baseline, ["src/b.ts"], () => true).failures).toEqual([]);
  });

  it("every cross-file script finishes within its budget on 3000 files", async () => {
    const ids = ["principles-duplicate-blocks", "principles-unused-exports", "principles-single-implementation", "principles-duplicate-exports"];
    await Promise.all(
      Array.from({ length: 3000 }, (_, i) =>
        write(`src/m${i % 30}/f${i}.ts`, `import { v${(i + 1) % 3000} } from "../m${((i + 1) % 3000) % 30}/f${(i + 1) % 3000}";\nexport interface I${i} {\n  n: number;\n}\nexport const v${i} = (a: I${i}): number => a.n + v${(i + 1) % 3000}.length;\n${lines(20, (j) => `export const k${i}x${j} = ${i * 100 + j};`)}\n`),
      ),
    );
    const gs = guardrails.filter((g) => ids.includes(g.id));
    const results = await runGuardrails(set, gs, [], { root, generatedDir: join(root, ".warden/generated") });
    expect(results.map((r) => [r.guardrail, r.status === "killed" || r.overBudget === true])).toEqual(ids.map((id) => [id, false]));
  });
});
