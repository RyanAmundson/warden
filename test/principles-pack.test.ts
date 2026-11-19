import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExamples } from "../src/compiler/examples.js";
import { eslintAdapter } from "../src/adapters/eslint.js";
import { fsAdapter, graphAdapter } from "../src/adapters/tree.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { applyBaseline, measureBaseline, projectFiles, writeBaseline } from "../src/runner/baseline.js";
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
  "principles-unused-parameters",
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
let written: Set<string>;

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
  if (!file.startsWith(".")) written.add(file);
};

const check = async (id: string, source: string) => {
  const gs = guardrails.filter((g) => g.id === id);
  await write("src/a.ts", source);
  for (const [file, content] of Object.entries(eslintAdapter.emit(gs, set))) await write(file, content);
  const results = await runGuardrails(set, gs, ["src/a.ts"], { root, generatedDir: join(root, ".warden/generated") });
  return results.find((r) => r.guardrail === id)?.status;
};

beforeEach(async () => {
  written = new Set();
  root = await mkdtemp(join(tmpdir(), "warden-principles-"));
  await write(".warden/config.yaml", config);
  set = await loadRecords(root, wardenRoot);
  guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
});

afterEach(() => rm(root, { recursive: true, force: true }));

const block = (name: string, gap = ""): string =>
  `export const ${name} = (n: number): number => {\n${lines(7, (i) => `  const x${i + 1} = ${i === 0 ? "n" : `x${i}`} + ${i + 1};${gap}`)}\n  return x7;\n};\n`;

const emitTree = async (gs: Guardrail[]): Promise<void> => {
  for (const adapter of [fsAdapter, graphAdapter]) {
    const own = gs.filter((g) => g.implementation.startsWith(`${adapter.id}:`));
    for (const [file, content] of Object.entries(adapter.emit(own, set))) await write(file, content);
  }
};

const scan = async (id: string, tree: Record<string, string>) => {
  for (const [file, content] of Object.entries(tree)) await write(file, content);
  const g = guardrails.find((x) => x.id === id) as Guardrail;
  await emitTree([g]);
  const [result] = await runGuardrails(set, [g], [...written], { root, generatedDir: join(root, ".warden/generated") });
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
      "src/b.ts:3-10: Lines 3-10 repeat the block that starts at src/a.ts:2.",
    ]);
  });

  it("duplicate blocks: one copy longer than 8 lines is one violation, and comments and blank lines are not significant", async () => {
    const long = (name: string): string => `export const ${name} = (n: number): number => {\n${lines(12, (i) => `  const x${i + 1} = ${i === 0 ? "n" : `x${i}`} + ${i + 1};`)}\n  return x12;\n};\n`;
    const spaced = long("b").replace("const x3", "// spacer\n\n  const x3");
    expect(await found("principles-duplicate-blocks", { "src/a.ts": long("a"), "src/b.ts": spaced })).toEqual(["src/b.ts:2-16: Lines 2-16 repeat the block that starts at src/a.ts:2."]);
  });

  it("duplicate blocks: a run of identical lines inside one block is not a copy of itself, and test files are not read", async () => {
    expect((await scan("principles-duplicate-blocks", { "src/a.ts": `${lines(9, () => "Math.abs(1);")}\n`, "src/a.test.ts": block("a"), "src/b.test.ts": block("b") }))?.status).toBe("pass");
  });

  it("unused exports: an import, a namespace member, and a re-export each count as a use from another file", async () => {
    const tree = {
      "src/a.ts": "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const own = 4;\nexport default 5;\nconsole.log(own);\n",
      "src/use.ts": 'import { a as alias } from "./a";\nimport * as $all from "./a";\nexport { c } from "./a";\nconsole.log(alias, $all.b);\n',
    };
    expect(await found("principles-unused-exports", tree)).toEqual(["src/a.ts:4: own is exported, but no other file imports it."]);
  });

  it("single implementation: names the interface and its class, and exempts a port", async () => {
    const shape = "export interface Shape {\n  area(): number;\n}\n";
    const square = 'import type * as port from "./shape";\nexport class Square implements port.Shape {\n  area(): number {\n    return 1;\n  }\n}\n';
    expect(await found("principles-single-implementation", { "src/shape.ts": shape, "src/square.ts": square })).toEqual([
      "src/shape.ts:1: Interface Shape has one implementation, the class at src/square.ts:2.",
    ]);
    await rm(join(root, "src"), { recursive: true });
    written.clear();
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
    expect(await found("principles-duplicate-exports", tree)).toEqual(["src/b.ts:2: step is also exported from src/a.ts:1."]);
  });

  it("unused exports: a file no other file imports is an entry point, and its exports are not checked", async () => {
    expect((await scan("principles-unused-exports", { "src/main.ts": "export const run = 1;\n", "src/lib.ts": "export const used = 1;\nexport const spare = 2;\n", "src/use.ts": 'import { used } from "./lib";\nconsole.log(used);\n' }))?.violations.map((v) => `${v.file}:${v.line}`)).toEqual(["src/lib.ts:2"]);
  });

  it("unused exports: a name behind an export-star barrel is used", async () => {
    const tree = {
      "src/parse.ts": "export const parse = 1;\n",
      "src/lex.ts": "export const lex = 1;\n",
      "src/index.ts": 'export * from "./parse.js";\nexport * as lexing from "./lex";\n',
    };
    expect((await scan("principles-unused-exports", tree))?.status).toBe("pass");
  });

  it("test files count as users and as implementations, and are never reported", async () => {
    const tree = {
      "src/parse.ts": "export const parse = 1;\n",
      "src/clock.ts": "export interface Clock {\n  now(): number;\n}\nexport class SystemClock implements Clock {\n  now(): number {\n    return 1;\n  }\n}\n",
      "src/parse.test.ts": 'import { parse } from "./parse";\nimport type { Clock } from "./clock";\nexport class FakeClock implements Clock {\n  now(): number {\n    return parse;\n  }\n}\nexport const helper = 1;\n',
    };
    expect((await scan("principles-unused-exports", { ...tree, "src/use.ts": 'import { SystemClock } from "./clock";\nconsole.log(SystemClock);\n' }))?.status).toBe("pass");
    expect((await scan("principles-single-implementation", tree))?.status).toBe("pass");
  });

  const reconfigure = async (principles: string): Promise<void> => {
    await write(".warden/config.yaml", config.replace(`  - id: principles\n    paths: ${paths}\n`, principles));
    set = await loadRecords(root, wardenRoot);
    guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
  };

  it("single implementation: a test double is never the implementation it names, and a factory that returns an object counts", async () => {
    const client = "export interface Client {\n  get(): number;\n}\n";
    const fake = 'import type { Client } from "./client";\nexport class FakeClient implements Client {\n  get(): number {\n    return 2;\n  }\n}\n';
    const factory = `${client}export const createClient = (): Client => ({ get: () => 1 });\n`;
    expect((await scan("principles-single-implementation", { "src/client.ts": factory, "src/client.test.ts": fake }))?.status).toBe("pass");
    await rm(join(root, "src"), { recursive: true });
    written.clear();
    expect((await scan("principles-single-implementation", { "src/client.ts": client, "src/client.test.ts": fake }))?.status).toBe("pass");
    await rm(join(root, "src"), { recursive: true });
    written.clear();
    const real = 'import type { Client } from "./client";\nexport class RealClient implements Client {\n  get(): number {\n    return 1;\n  }\n}\n';
    const literal = `${client}export const fixed: Client = { get: () => 3 };\nexport const other = { get: () => 4 } satisfies Client;\n`;
    expect((await scan("principles-single-implementation", { "src/client.ts": literal, "src/real.ts": real }))?.status).toBe("pass");
  });

  it("single implementation: forwarding methods and nested returns do not duplicate an implementation", async () => {
    const client = "export interface Client { get(): number }\n";
    const real = 'import type { Client } from "./client";\nexport class RealClient implements Client { get(): number { return 1; } }\n';
    const forwarding = `import type { Client } from "./client";
import { RealClient } from "./real";
export interface ClientProvider { get(): Client }
export class Factory {
  forward(existing: Client): Client { return existing; }
  make(): Client {
    const callback = () => { return { get: () => 2 }; };
    console.log(callback);
    return new RealClient();
  }
}
`;
    const tree = { "src/client.ts": client, "src/real.ts": real, "src/factory.ts": forwarding };
    expect(await found("principles-single-implementation", tree)).toEqual([
      "src/client.ts:1: Interface Client has one implementation, the class at src/real.ts:2.",
    ]);
    const declarations = [
      "export function make(fast: boolean): Client { return fast ? { get: () => 2 } : { get: () => 3 }; }",
      "export function make(n: number): Client; export function make(n: number) { return { get: () => n }; }",
      "export const make = (): Client => ({ get: () => 2 });",
      "export class Factory { make(fast: boolean): Client { return fast ? <Client>{ get: () => 2 } : { get: () => 3 }; } }",
      "export class Factory { make(n: number): Client; make(n: number) { return { get: () => n }; } }",
      "export class Factory { 'make'(n: number): Client; make(n: number) { return { get: () => n }; } }",
      "export class Factory { ['make'](n: number): Client; make(n: number) { return { get: () => n }; } }",
      "export class Factory { make(): Client { return ({ get: () => 2 })!; } }",
    ];
    for (const declaration of declarations) {
      const factory = `import type { Client } from "./client";\n${declaration}\n`;
      expect(await found("principles-single-implementation", { ...tree, "src/factory.ts": factory }), declaration).toEqual([]);
    }
  });

  it("duplicate exports: a name the project declares as a contract export may repeat, and the Do this names that declaration", async () => {
    const plugin = "export const start = (): number => 1;\n";
    const tree = { "src/a/main.ts": plugin, "src/b/main.ts": plugin };
    const failed = await scan("principles-duplicate-exports", tree);
    expect(failed?.violations.map((v) => v.doThis)).toEqual([
      "Import start from src/a/main.ts instead of declaring it here, or rename it here if it means something different. If a contract requires each of these files to export start, ask the project owner to add start to contractExports in the settings of pack principles in .warden/config.yaml, then run warden compile.",
    ]);
    await reconfigure(`  - id: principles\n    paths: ${paths}\n    settings:\n      contractExports: [start]\n`);
    expect((await scan("principles-duplicate-exports", {}))?.status).toBe("pass");
    expect((await scan("principles-unused-exports", { "src/host.ts": 'import { stop } from "./a/main";\nconsole.log(stop);\n', "src/a/main.ts": `${plugin}export const stop = 1;\n` }))?.status).toBe("pass");
  });

  it("unused exports: names used through import(), and import types, count as uses", async () => {
    const tree = {
      "src/dialog.ts": "export const useA = 1;\nexport const B = 2;\nexport const C = 3;\nexport interface D {\n  n: number;\n}\nexport const E = 5;\nexport const spare = 6;\n",
      "src/lazy.ts": "export const F = 7;\n",
      "src/use.ts": [
        'import { spare } from "./dialog";',
        'export const a = import("./dialog").then(({ useA }) => useA);',
        'const { B } = await import("./dialog");',
        'export const c = (await import("./dialog")).C;',
        'export let d: import("./dialog").D | undefined;',
        'export const e = import("./dialog").then((m) => m.E);',
        'export const load = (): Promise<unknown> => import("./lazy");',
        "console.log(spare, B);",
        "",
      ].join("\n"),
      "src/main.ts": 'import { a, c, d, e, load } from "./use";\nconsole.log(a, c, d, e, load);\n',
    };
    expect((await scan("principles-unused-exports", tree))?.status).toBe("pass");
  });

  it.each(["./dialog", "@app/dialog"])("unused exports: rest bindings keep the remaining exports of %s available", async (specifier) => {
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@app/*": ["./src/*"] } } }));
    const tree = {
      "src/dialog.ts": "export const open = 1;\nexport const close = 2;\n",
      "src/dialog/index.ts": "export const show = 3;\nexport const unused = 4;\n",
      "src/use.ts": `const { open, ...dialog } = await import("${specifier}");\nimport { show } from "./dialog/index";\nconsole.log(open, dialog.close, show);\n`,
    };
    expect(await found("principles-unused-exports", tree)).toEqual(["src/dialog/index.ts:2: unused is exported, but no other file imports it."]);
  });

  it.each([
    ['const dialog = await import("./dialog"); console.log(dialog.open, dialog["close"]);', ["src/dialog.ts:3"]],
    ['const dialog = await import("./dialog"); console.log(dialog);', []],
    ['const dialog = await import("./dialog"); console.log(dialog[process.argv[2]!]);', []],
    ['export const dialog = await import("./dialog");', []],
    ['const dialog = await import("./dialog"); { const dialog = { spare: 4 }; console.log(dialog.spare); } console.log(dialog.open);', []],
  ])("unused exports: uses of an awaited namespace in %s", async (use, expected) => {
    const result = await scan("principles-unused-exports", {
      "src/dialog.ts": "export const open = 1;\nexport const close = 2;\nexport const spare = 3;\n",
      "src/use.ts": use,
    });
    expect(result?.violations.map((v) => `${v.file}:${v.line}`)).toEqual(expected);
  });

  it("unused exports: an awaited namespace counts members only in its resolved module", async () => {
    await write("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@app/*": ["./src/*"] } } }));
    const result = await scan("principles-unused-exports", {
      "src/dialog.ts": "export const open = 1;\nexport const spare = 2;\n",
      "src/panel.ts": "export const close = 1;\nexport const open = 2;\n",
      "src/use.ts": 'import { close } from "./panel";\nconst dialog = await import("@app/dialog");\nconsole.log(close, dialog.open);\n',
    });
    expect(result?.violations.map((v) => `${v.file}:${v.line}`)).toEqual(["src/dialog.ts:2", "src/panel.ts:2"]);
  });

  it.each(["dialog.open()", "(dialog.open)?.()", 'dialog["open"]`name`'])("unused exports: %s receives the full module namespace", async (access) => {
    const result = await scan("principles-unused-exports", {
      "src/dialog.mjs": "export const close = 7;\nexport function open() { return this.close; }\n",
      "src/use.mjs": `const dialog = await import("./dialog.mjs");\nconsole.log(${access});\n`,
    });
    expect(result?.status).toBe("pass");
  });

  it("unused exports: a file outside the Practice's paths still counts as a user", async () => {
    await reconfigure(`  - id: principles\n    paths: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"]\n`);
    const tree = { "src/util.ts": "export const a = 1;\nexport const b = 2;\n", "src/use.ts": 'import { a } from "./util";\nconsole.log(a);\n', "src/App.jsx": 'import { b } from "./util";\nconsole.log(b);\n' };
    expect((await scan("principles-unused-exports", tree))?.status).toBe("pass");
  });

  it("duplicate blocks: import and export lists are not significant", async () => {
    const list = (name: string): string =>
      `import {\n${lines(8, (i) => `  hook${i},`)}\n} from "react";\nimport type { A } from "./a";\nexport {\n${lines(8, (i) => `  hook${i},`)}\n};\nexport const ${name} = 1;\n`;
    expect((await scan("principles-duplicate-blocks", { "src/a.ts": list("a"), "src/b.ts": list("b") }))?.status).toBe("pass");
  });

  it("framework-required export names pass both name checks", async () => {
    const page = "export const metadata = { title: 1 };\nexport const GET = (): number => 1;\nexport default 1;\n";
    const tree = { "app/a/page.tsx": page, "app/b/page.tsx": page };
    expect((await scan("principles-duplicate-exports", tree))?.status).toBe("pass");
    expect((await scan("principles-unused-exports", tree))?.status).toBe("pass");
  });

  it("each finding names one file and line with its own Do this, and the findings can be baselined per file", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await write(".gitignore", "dist/\n");
    await write("dist/a.ts", "export const step = 1;\n");
    await write("src/a.ts", "export const step = 2;\n");
    await write("src/b.ts", "export const step = 3;\n");
    await write("src/c.ts", "export const step = 4;\n");
    const g = guardrails.find((x) => x.id === "principles-duplicate-exports") as Guardrail;
    await emitTree([g]);
    const files = projectFiles(root, set.config.packs.flatMap((p) => p.paths));
    const results = await runGuardrails(set, [g], files, { root, generatedDir: join(root, ".warden/generated") });
    expect(results[0]?.violations.map((v) => [v.file, v.line, v.doThis])).toEqual([
      ["src/b.ts", 1, "Import step from src/a.ts instead of declaring it here, or rename it here if it means something different. If a contract requires each of these files to export step, ask the project owner to add step to contractExports in the settings of pack principles in .warden/config.yaml, then run warden compile."],
      ["src/c.ts", 1, "Import step from src/a.ts instead of declaring it here, or rename it here if it means something different. If a contract requires each of these files to export step, ask the project owner to add step to contractExports in the settings of pack principles in .warden/config.yaml, then run warden compile."],
    ]);
    const { baseline } = await measureBaseline(set, [g]);
    expect(baseline).toEqual({ "principles-duplicate-exports": { "src/b.ts": 1, "src/c.ts": 1 } });
    expect(() => writeBaseline(root, baseline)).not.toThrow();
    expect(applyBaseline(results, baseline, ["src/b.ts", "src/c.ts"], () => true).failures).toEqual([]);
  });

  it("every cross-file check finishes within its budget on 3000 files", async () => {
    const ids = ["principles-duplicate-blocks", "principles-unused-exports", "principles-single-implementation", "principles-duplicate-exports"];
    await Promise.all(
      Array.from({ length: 3000 }, (_, i) =>
        write(`src/m${i % 30}/f${i}.ts`, `import { v${(i + 1) % 3000} } from "../m${((i + 1) % 3000) % 30}/f${(i + 1) % 3000}";\nexport interface I${i} {\n  n: number;\n}\nexport const v${i} = (a: I${i}): number => a.n + v${(i + 1) % 3000}.length;\n${lines(20, (j) => `export const k${i}x${j} = ${i * 100 + j};`)}\n`),
      ),
    );
    const gs = guardrails.filter((g) => ids.includes(g.id));
    await emitTree(gs);
    const results = await runGuardrails(set, gs, [...written], { root, generatedDir: join(root, ".warden/generated") });
    expect(results.map((r) => [r.guardrail, r.status === "killed" || r.overBudget === true]).sort()).toEqual(ids.map((id) => [id, false]).sort());
  });
});
