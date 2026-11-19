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
import { bench } from "./pack-bench.js";

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

const lint = async (id: string, source: string, file: string) => {
  const gs = guardrails.filter((g) => g.id === id);
  await write(file, source);
  for (const [path, content] of Object.entries(eslintAdapter.emit(gs, set))) await write(path, content);
  const [result] = await runGuardrails(set, gs, [file], { root, generatedDir: join(root, ".warden/generated") });
  return result;
};

const check = async (id: string, source: string, file: string) => (await lint(id, source, file))?.status;

const importing = (name: string): string => `import * as m from "${name}";\nexport const used = m;\n`;
const modules = "architecture-world-modules";
const globals = "architecture-world-globals";

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
  it("architecture pack Guardrails scale at most linearly", async () => {
    const { code, out } = await bench(root, { pack: "architecture" });
    expect(code, out).toBe(0);
  });

  it("is consistent and its examples hold", async () => {
    expect(checkConsistency(set)).toEqual([]);
    expect(await runExamples(set)).toEqual([]);
  });

  it.each(["fs", "node:fs", "fs/promises", "node:child_process", "net", "http", "https", "worker_threads"])("fails a %s import outside sources", async (name) => {
    expect(await check(modules, importing(name), "src/g/a.ts")).toBe("fail");
  });

  it.each(["node:timers", "timers/promises", "node:timers/promises"])("fails a %s import outside sources", async (name) => {
    expect(await check(modules, importing(name), "src/g/a.ts")).toBe("fail");
  });

  it("fails a setTimeout import from node:timers/promises outside sources", async () => {
    expect(await check(modules, "import { setTimeout } from \"node:timers/promises\";\nexport const wait = setTimeout;\n", "src/g/a.ts")).toBe("fail");
  });

  it("fails a composition root that reaches the world", async () => {
    expect(await check(modules, importing("node:http"), "src/main.ts")).toBe("fail");
  });

  it.each([
    "src/g/sources/a.ts",
    "src/g/a.test.ts",
    "src/g/a.spec.ts",
    "src/g/sources/deep/a.ts",
    "test/helpers/fixture.ts",
    "packages/x/tests/setup.ts",
    "src/g/__tests__/a.ts",
    "vitest.config.ts",
  ])("allows a node:fs import in %s", async (file) => {
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
    expect(await check(globals, source, "src/g/a.ts")).toBe("fail");
    expect(await check(globals, source, "src/g/sources/a.ts")).toBe("pass");
  });

  it.each([modules, globals])("lints a compliant file inside the paths of %s in its mustPass example", async (id) => {
    const guardrail = guardrails.find((g) => g.id === id);
    const [violating] = Object.values(guardrail?.mustFail ?? {});
    const linted = [];
    for (const file of Object.keys(guardrail?.mustPass ?? {})) linted.push(await check(id, violating as string, file));
    expect(linted).toContain("fail");
  });

  it("allows a parameter named fetch", async () => {
    expect(await check(globals, "export const call = (fetch: () => void): void => fetch();\n", "src/g/a.ts")).toBe("pass");
  });
});

describe("architecture pack sources only emit", () => {
  const shape = "architecture-source-shape";
  const sinkMessage = "A source imports no sink.";
  const reexportMessage = "A source re-exports or loads no sink.";
  const returnMessage = "Every function a source exports declares an Observable return type.";
  const worldMessage = "A source re-exports no world module.";
  const aliasMessage = "A source exports no alias of another value.";
  const listMessage = "A source exports no list of local values.";
  const classMessage = "A source exports no class.";
  const bad = "src/g/sources/bad.ts";


  it.each([
    ["an import from a sink", "import { write } from \"../sinks/status\";\nexport const used = write;\n", sinkMessage],
    ["export * from a sink", "export * from \"../sinks/x\";\n", reexportMessage],
    ["a re-export from a sink", "export { x } from \"../sinks/x\";\n", reexportMessage],
    ["a dynamic import of a sink", "import { Observable } from \"rxjs\";\nexport const load = (): Observable<number> => { import(\"../sinks/y\"); return new Observable<number>(); };\n", reexportMessage],
    ["an async function returning a Promise", "export async function load(): Promise<number> {\n  return 1;\n}\n", returnMessage],
    ["an arrow function returning a number", "export const read = (): number => 1;\n", returnMessage],
    ["an exported function with no return type", "export function read() {\n  return 1;\n}\n", returnMessage],
    ["a default function returning a number", "export default function read(): number {\n  return 1;\n}\n", returnMessage],
    ["export * from a world module", "export * from \"node:fs\";\n", worldMessage],
    ["a re-export from a world module", "export { readFile } from \"fs/promises\";\n", worldMessage],
    ["a re-export from node:timers/promises", "export { setTimeout } from \"node:timers/promises\";\n", worldMessage],
    ["an exported identifier alias", "import { readFile } from \"node:fs\";\nexport const read = readFile;\n", aliasMessage],
    ["a default-exported identifier", "import { readFile } from \"node:fs\";\nexport default readFile;\n", aliasMessage],
    ["a local export list", "import { readFile } from \"node:fs\";\nexport { readFile };\n", listMessage],
    ["an exported class", "export class Reader {\n  read(): number {\n    return 1;\n  }\n}\n", classMessage],
    ["a default-exported class", "export default class Reader {\n  read(): number {\n    return 1;\n  }\n}\n", classMessage],
    ["a default-exported arrow function", "export default (): number => 1;\n", returnMessage],
    ["a default-exported function expression", "export default (function read(): number {\n  return 1;\n});\n", returnMessage],
    ["a require of a sink", "import { Observable } from \"rxjs\";\nexport const load = (): Observable<number> => { require(\"../sinks/y\"); return new Observable<number>(); };\n", reexportMessage],
  ])("fails %s", async (_name, source, message) => {
    const result = await lint(shape, source, bad);
    expect(result?.status).toBe("fail");
    expect(result?.violations.map((v) => v.message)).toContainEqual(expect.stringContaining(message));
  });

  it("passes observables, types, constants, and a plain import", async () => {
    const source = [
      "import { Observable } from \"rxjs\";",
      "import { parse } from \"../parse\";",
      "export type Reading = number;",
      "export const label = \"status\";",
      "export function watch(): Observable<number> {",
      "  return new Observable<number>((subscriber) => subscriber.next(parse(label)));",
      "}",
      "export const watchAgain = (): Observable<number> => watch();",
      "export default (): Observable<number> => watch();",
      "",
    ].join("\n");
    expect(await check(shape, source, "src/g/sources/good.ts")).toBe("pass");
  });

  it.each([
    ["a type-only export list", "type X = number;\nexport type { X };\n"],
    ["a constant", "export const KEY = \"k\";\n"],
    ["a function returning Observable", "import { Observable } from \"rxjs\";\nexport function watch(): Observable<number> {\n  return new Observable<number>();\n}\n"],
    ["a type import from a sink", "import type { Row } from \"../sinks/x\";\nexport type Rows = Row[];\n"],
    ["a type re-export from a sink", "export type { Row } from \"../sinks/x\";\n"],
    ["a qualified Observable arrow", "import * as rx from \"rxjs\";\nexport const watch = (): rx.Observable<number> => new rx.Observable<number>();\n"],
    ["a qualified Observable function", "import * as rx from \"rxjs\";\nexport function watch(): rx.Observable<number> {\n  return new rx.Observable<number>();\n}\n"],
    ["a qualified Observable default", "import * as rx from \"rxjs\";\nexport default (): rx.Observable<number> => new rx.Observable<number>();\n"],
  ])("passes %s in a source", async (_name, source) => {
    expect(await check(shape, source, "src/g/sources/good.ts")).toBe("pass");
  });

  it("allows a sink import outside sources", async () => {
    expect(await check(shape, "import { write } from \"../sinks/status\";\nexport const used = write;\n", "src/g/format.ts")).toBe("pass");
  });

  it("allows an import from sinkhole in a source", async () => {
    expect(await check(shape, "import { x } from \"../sinkhole/x\";\nexport type Used = typeof x;\n", "src/g/sources/a.ts")).toBe("pass");
  });
});
