import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkConsistency } from "../src/compiler/consistency.js";
import { runExamples } from "../src/compiler/examples.js";
import type { Adapter } from "../src/adapters/types.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { adapters, prefixOf, runGuardrails } from "../src/runner/run.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const code = "[\"**/*.{ts,tsx,mts,cts,js,mjs,cjs}\"]";
const configWith = (settings: string[]): string =>
  [
    "warden: 0.1.0",
    "project: sample",
    "base: main",
    "packs:",
    "  - id: core",
    `    paths: ${code}`,
    "  - id: architecture",
    `    paths: ${code}`,
    "    settings:",
    ...settings.map((line) => `      ${line}`),
    "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
    "loopBreakerRepeats: 3",
    "",
  ].join("\n");
const layout = ["groupCollections: [{ collection: \"[services]\", suffix: \"-service\" }]", "technicalCollections: [\"src/[utils]\"]", "compositionRoots: [\"src/main.ts\"]", "sinkModules: [rxdb]"];
const config = configWith(layout);

let root: string;
let home: string;
let set: RecordSet;
let guardrails: Guardrail[];

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const runOn = async (id: string, tree: Record<string, string>) => {
  const gs = guardrails.filter((g) => g.id === id);
  for (const [file, content] of Object.entries(tree)) await write(file, content);
  const adapter = adapters.get(prefixOf(gs[0] as Guardrail)) as Adapter;
  for (const [path, content] of Object.entries(adapter.emit(gs, set))) await write(path, content);
  const [result] = await runGuardrails(set, gs, Object.keys(tree), { root, generatedDir: join(root, ".warden/generated") });
  return result;
};

const lint = (id: string, source: string, file: string) => runOn(id, { [file]: source });

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

  it("lets a declared composition root reach the world, and no other file of the same name", async () => {
    expect(await check(modules, importing("node:http"), "src/main.ts")).toBe("pass");
    expect(await check(globals, "export const t = (): void => {\n  setTimeout(() => undefined, 1);\n};\n", "src/main.ts")).toBe("pass");
    expect(await check(modules, importing("node:http"), "src/g/main.ts")).toBe("fail");
  });

  it.each([
    ["a require", "const fs = require(\"fs\");\nexport const used = fs;\n"],
    ["a template-literal require", "const fs = require(`node:fs`);\nexport const used = fs;\n"],
    ["a dynamic import", "export const load = (): unknown => import(\"node:fs/promises\");\n"],
    ["an import-equals require", "import fs = require(\"fs\");\nexport const used = fs;\n"],
    ["a re-export", "export { readFile } from \"node:fs\";\n"],
  ])("fails %s of a world module outside sources", async (_name, source) => {
    expect(await check(modules, source, "src/g/a.ts")).toBe("fail");
  });

  it("allows a type-only import from a world module", async () => {
    expect(await check(modules, "import type { Stats } from \"node:fs\";\nexport type S = Stats;\n", "src/g/a.ts")).toBe("pass");
  });

  it("fails a third-party world package once the project declares it", async () => {
    await write(".warden/config.yaml", configWith([...layout, "world: [fs, fs-extra]"]));
    set = await loadRecords(root, wardenRoot);
    guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
    expect(await check(modules, importing("fs-extra"), "src/g/a.ts")).toBe("fail");
    expect(await check(modules, importing("node:net"), "src/g/a.ts")).toBe("pass");
  });

  it.each([
    ["Date.now()", "export const at = (): number => Date.now();\n"],
    ["new Date()", "export const at = (): Date => new Date();\n"],
    ["Date()", "export const at = (): string => Date();\n"],
    ["performance.now()", "export const at = (): number => performance.now();\n"],
    ["globalThis.setTimeout", "export const later = (run: () => void): void => {\n  globalThis.setTimeout(run, 1);\n};\n"],
    ["window.fetch", "export const load = (): unknown => window.fetch(\"x\");\n"],
    ["self[\"fetch\"]", "export const load = (): unknown => self[\"fetch\"](\"x\");\n"],
  ])("fails %s outside sources", async (_name, source) => {
    expect(await check(globals, source, "src/g/a.ts")).toBe("fail");
  });

  it("allows a date built from a value and a Date parameter", async () => {
    expect(await check(globals, "export const at = (ms: number): Date => new Date(ms);\nexport const id = (Date: number): number => Date;\n", "src/g/a.ts")).toBe("pass");
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
  const reexportMessage = "A source imports no sink.";
  const returnMessage = "Every function a source exports declares an Observable return type.";
  const worldMessage = "A source re-exports no world module.";
  const aliasMessage = "A source exports no alias of another value.";
  const listMessage = "A source exports no local value that is not a function returning an Observable.";
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

describe("architecture pack source shape gaps", () => {
  const shape = "architecture-source-shape";
  const bad = "src/g/sources/bad.ts";

  it.each([
    ["a member-access alias", "import * as fs from \"node:fs\";\nexport const read = fs.readFile;\n"],
    ["an object of world values", "import { readFile } from \"node:fs\";\nexport const api = { readFile };\n"],
    ["a default object of world values", "import { readFile } from \"node:fs\";\nexport default { readFile };\n"],
    ["a template-literal require of a sink", "import { Observable } from \"rxjs\";\nexport const load = (): Observable<number> => { require(`../sinks/y`); return new Observable<number>(); };\n"],
    ["a local export list naming a function with no Observable return", "function read(): number {\n  return 1;\n}\nexport { read };\n"],
  ])("fails %s", async (_name, source) => {
    expect(await check(shape, source, bad)).toBe("fail");
  });

  it.each([
    ["an inline type export specifier", "type X = number;\nexport { type X };\n"],
    ["an export list naming an Observable function", "import { Observable } from \"rxjs\";\nfunction watch(): Observable<number> {\n  return new Observable<number>();\n}\nconst again = (): Observable<number> => watch();\nexport { watch, again };\n"],
    ["an object of constants", "export const limits = { max: 3, names: [\"a\", \"b\"], neg: -1 };\n"],
  ])("passes %s", async (_name, source) => {
    expect(await check(shape, source, "src/g/sources/good.ts")).toBe("pass");
  });
});

describe("architecture pack flow and stores", () => {
  it("fails a sink that imports a source, and passes a type-only import", async () => {
    const rule = "architecture-sink-imports-no-source";
    expect(await check(rule, "import { watch } from \"../sources/status\";\nexport const store = watch;\n", "src/g/sinks/a.ts")).toBe("fail");
    expect(await check(rule, "export const load = (): unknown => import(\"../sources/status\");\n", "src/g/sinks/a.ts")).toBe("fail");
    expect(await check(rule, "import type { S } from \"../sources/status\";\nexport type T = S;\n", "src/g/sinks/a.ts")).toBe("pass");
  });

  it("fails a store write outside sinks, and passes it in a sink and a composition root", async () => {
    const rule = "architecture-store-writes";
    expect(await check(rule, importing("rxdb/plugins/core"), "src/g/a.ts")).toBe("fail");
    expect(await check(rule, importing("rxdb"), "src/g/sinks/a.ts")).toBe("pass");
    expect(await check(rule, importing("rxdb"), "src/main.ts")).toBe("pass");
    expect(await check(rule, importing("rxdbx"), "src/g/a.ts")).toBe("pass");
  });
});

describe("architecture pack groups", () => {
  const port = "src/[services]/git-service/git-service.ts";
  const portText = "export type GitService = { status: () => number };\nexport type CreateGitService = () => GitService;\n";

  it.each([
    ["an internal file from another group", "src/[services]/process-service/run.ts", "../git-service/sources/status-watcher"],
    ["a group's folder from outside", "src/app.ts", "./[services]/git-service"],
    ["a group's create from a file that is not a composition root", "src/app.ts", "./[services]/git-service/create"],
    ["an adapter's create from a file that is not a composition root", "src/app.ts", "./[services]/git-service/adapters/cli/create"],
  ])("ARCH-1 fails %s", async (_name, file, specifier) => {
    expect(await check("architecture-group-boundaries", `import { x } from "${specifier}";\nexport const y = x;\n`, file)).toBe("fail");
  });

  it.each([
    ["the port", "src/[services]/process-service/run.ts", "../git-service/git-service"],
    ["the port with a .js extension", "src/[services]/process-service/run.ts", "../git-service/git-service.js"],
    ["a file inside the importer's own group", "src/[services]/git-service/run.ts", "./sources/status-watcher"],
    ["create from a composition root", "src/main.ts", "./[services]/git-service/create"],
    ["an adapter's create from a composition root", "src/main.ts", "./[services]/git-service/adapters/cli/create"],
    ["a file outside every group", "src/app.ts", "./format"],
  ])("ARCH-1 passes %s", async (_name, file, specifier) => {
    expect(await check("architecture-group-boundaries", `import { x } from "${specifier}";\nexport const y = x;\n`, file)).toBe("pass");
  });

  it.each([
    ["a re-export of create", "export { create } from \"./create\";\n"],
    ["a runtime constant", "export const NAME = \"git\";\n"],
    ["a value import", "import { parse } from \"./parse\";\nexport type P = typeof parse;\n"],
  ])("ARCH-2 fails a port with %s", async (_name, source) => {
    expect(await check("architecture-port-shape", source, port)).toBe("fail");
  });

  it("ARCH-2 passes a types-only port and ignores files that are not ports", async () => {
    expect(await check("architecture-port-shape", `import type { Clock } from "../clock-service/clock-service";\n${portText}export interface Extra {\n  at: Clock;\n}\nexport type { Clock };\n`, port)).toBe("pass");
    expect(await check("architecture-port-shape", "export const NAME = \"git\";\n", "src/[services]/git-service/format.ts")).toBe("pass");
  });

  it("ARCH-3 fails an untyped create and a create typed by something other than its port", async () => {
    const rule = "architecture-implements-port";
    expect((await runOn(rule, { [port]: portText, "src/[services]/git-service/create.ts": "export const create = () => ({ status: (): number => 1 });\n" }))?.status).toBe("fail");
    expect((await runOn(rule, { [port]: portText, "src/[services]/git-service/create.ts": "import type { CreateGitService } from \"./other\";\nexport const create: CreateGitService = () => ({ status: (): number => 1 });\n" }))?.status).toBe("fail");
    expect((await runOn(rule, { [port]: portText, "src/[services]/git-service/create.ts": "import type { CreateGitService } from \"./git-service\";\nexport const create: CreateGitService = () => ({ status: (): number => 1 });\n" }))?.status).toBe("pass");
    expect((await runOn(rule, { [port]: portText, "src/[services]/git-service/format.ts": "export const format = (): number => 1;\n" }))?.status).toBe("pass");
  });

  it("ARCH-4 fails an import of a sibling adapter, and passes the group's shared code", async () => {
    const file = "src/[services]/git-service/adapters/libgit2/parse.ts";
    expect(await check("architecture-adapter-isolation", importing("../cli/parse"), file)).toBe("fail");
    expect(await check("architecture-adapter-isolation", importing("../../parse"), file)).toBe("pass");
    expect(await check("architecture-adapter-isolation", importing("./scan"), file)).toBe("pass");
  });
});

describe("architecture pack tree checks", () => {
  const port = "src/[services]/git-service/git-service.ts";
  const types = "export type GitStatus = number;\n";

  it("ARCH-5 reports a group with no conformance suite on its port file, with the file to add", async () => {
    const result = await runOn("architecture-conformance-present", { [port]: types, "src/[services]/git-service/format.ts": types });
    expect(result?.violations).toEqual([
      expect.objectContaining({ file: port, line: 1, message: "Group git-service has no conformance suite.", doThis: expect.stringContaining("Add src/[services]/git-service/git-service.conformance.ts") }),
    ]);
  });

  it("ARCH-5 reports an adapter whose test does not run the conformance suite", async () => {
    const suite = "src/[services]/git-service/git-service.conformance.ts";
    const tree = {
      [suite]: "export const run = (create: () => number): boolean => create() === 1;\n",
      "src/[services]/git-service/adapters/cli/create.ts": "export const create = (): number => 1;\n",
      "src/[services]/git-service/adapters/cli/create.test.ts": "import { run } from \"../../git-service.conformance\";\nimport { create } from \"./create\";\nexport const ok = run(create);\n",
      "src/[services]/git-service/adapters/libgit2/create.ts": "export const create = (): number => 1;\n",
    };
    const result = await runOn("architecture-runs-conformance", tree);
    expect(result?.violations.map((v) => v.file)).toEqual(["src/[services]/git-service/adapters/libgit2/create.ts"]);
  });

  it("ARCH-10 fails a group named for no Term, a banned synonym, or without the suffix", async () => {
    const rule = "architecture-group-named-by-term";
    expect((await runOn(rule, { "src/[services]/helpers-service/x.ts": types }))?.violations.map((v) => v.message)).toEqual(["Group helpers-service is named helpers, which is no defined Term."]);
    expect((await runOn(rule, { "src/[services]/git/x.ts": types }))?.violations.map((v) => v.message)).toEqual(["Group git does not end with -service."]);
    expect((await runOn(rule, { "src/[services]/adapter-service/x.ts": types }))?.violations.map((v) => v.message)).toEqual([]);
    await write(".warden/packs/local/pack.yaml", "id: local\nlayer: 5\nterms:\n  - { id: git, definition: Version control., bans: [vcs] }\npractices: []\n");
    await write(".warden/config.yaml", config.replace("tierBudgetMs", "  - id: local\n    paths: []\ntierBudgetMs"));
    set = await loadRecords(root, wardenRoot);
    guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
    expect((await runOn(rule, { "src/[services]/vcs-service/x.ts": types }))?.violations.map((v) => v.message)).toEqual(["Group vcs-service is named vcs, which Term git bans."]);
  });

  it("ARCH-11 fails a shared item used by one group and passes one used by two", async () => {
    const util = "src/[utils]/canonical-json.ts";
    const user = (group: string): Record<string, string> => ({ [`src/[services]/${group}/format.ts`]: "import { c } from \"../../[utils]/canonical-json\";\nexport const f = c;\n" });
    const one = await runOn("architecture-shared-by-two-groups", { [util]: "export const c = 1;\n", ...user("git-service"), "src/main.ts": "import { c } from \"./[utils]/canonical-json\";\nexport const m = c;\n" });
    expect(one?.violations).toEqual([expect.objectContaining({ file: util, doThis: "Move src/[utils]/canonical-json.ts into src/[services]/git-service." })]);
    await rm(join(root, "src"), { recursive: true, force: true });
    expect((await runOn("architecture-shared-by-two-groups", { [util]: "export const c = 1;\n", ...user("git-service"), ...user("process-service") }))?.status).toBe("pass");
  });

  it("ARCH-12 reports each import on a group cycle at its line, and ignores tests and composition roots", async () => {
    const tree = {
      "src/[services]/a-service/a-service.ts": "export type A = number;\nimport type { B } from \"../b-service/b-service\";\nexport type AB = B;\n",
      "src/[services]/b-service/b-service.ts": "import type { A } from \"../a-service/a-service\";\nexport type B = A;\n",
      "src/[services]/c-service/c-service.ts": "import type { A } from \"../a-service/a-service\";\nexport type C = A;\n",
      "src/[services]/a-service/a.test.ts": "import type { C } from \"../c-service/c-service\";\nexport type T = C;\n",
    };
    const result = await runOn("architecture-acyclic-groups", tree);
    expect(result?.violations.map((v) => `${v.file}:${v.line}`).sort()).toEqual(["src/[services]/a-service/a-service.ts:2", "src/[services]/b-service/b-service.ts:1"]);
  });
});
