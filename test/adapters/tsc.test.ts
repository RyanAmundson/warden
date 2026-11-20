import { cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { GENERATED_TSCONFIG, tscConfigSources } from "../../src/adapters/tsc-config.js";
import { sha256 } from "../../src/compiler/lock.js";
import { tscAdapter } from "../../src/adapters/tsc.js";
import { parseKey } from "../../src/adapters/tsc-worker.js";
import { PARSE_ERROR } from "../../src/adapters/types.js";
import { RecordError } from "../../src/records/load.js";
import type { Guardrail, RecordSet } from "../../src/records/types.js";
import { conformance } from "./conformance.js";

const stub = vi.hoisted((): { path: string | undefined; started: number } => ({ path: undefined, started: 0 }));

vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(url: URL, options?: import("node:worker_threads").WorkerOptions) {
        super(stub.path ?? url, options);
        stub.started += 1;
      }
    },
  };
});

const guardrail = (id: string, implementation: string): Guardrail => ({
  id,
  kind: "type",
  runs: ["commit"],
  budgetMs: 60000,
  version: 1,
  implementation,
  mustFail: "bad",
  mustPass: "good",
});

const set: RecordSet = {
  root: "",
  config: {
    project: "p",
    base: "main",
    packs: [],
    tierBudgetMs: { edit: 1000, commit: 1000, boundary: 1000 },
    loopBreakerRepeats: 3,
  },
  packs: [],
};

const source = resolve(import.meta.dirname, "../fixtures/tsc-project");
const wardenModules = resolve(import.meta.dirname, "../../node_modules");

const withProject = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "warden-tsc-"));
  try {
    await cp(source, root, { recursive: true });
    await symlink(wardenModules, join(root, "node_modules"));
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const emitInto = async (root: string, gs: Guardrail[]): Promise<void> => {
  for (const [path, content] of Object.entries(tscAdapter.emit(gs, { ...set, root }))) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

const ctxFor = (root: string) => ({ root, generatedDir: join(root, ".warden/generated") });

describe("tsc adapter", () => {
  it("tsc conformance: flags a possibly undefined access", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "warden-tsc-fixture-"));
    try {
      await cp(source, fixture, { recursive: true });
      await symlink(wardenModules, join(fixture, "node_modules"));
      const g = guardrail("strict-null", "tsc:strictNullChecks");
      await conformance(tscAdapter, fixture, [g], set, ["src/a.ts"], [
        {
          guardrail: "strict-null",
          file: "src/a.ts",
          line: 3,
          message: "TS18048: 'name' is possibly 'undefined'.",
        },
      ]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("keeps the project's own paths mapping", async () => {
    await withProject(async (root) => {
      const g = guardrail("strict-null", "tsc:strictNullChecks");
      await emitInto(root, [g]);
      const results = await tscAdapter.run([g], [], ctxFor(root));
      expect(results.flatMap((r) => r.violations.map((v) => v.message)).filter((m) => m.startsWith("TS2307"))).toEqual([]);
      expect(results.find((r) => r.guardrail === "tsc:baseline-errors")?.violations).toEqual([]);
    });
  });

  it("checks the config bytes TypeScript reads against the approved lock", async () => {
    await withProject(async (root) => {
      const project = join(root, "tsconfig.json");
      const original = await readFile(project, "utf8");
      const inherited = JSON.stringify({ compilerOptions: { strict: true } });
      await writeFile(join(root, "shared.json"), inherited);
      const install = async (directory: string) => {
        const dependency = join(root, directory);
        await mkdir(join(dependency, "config"), { recursive: true });
        await writeFile(join(dependency, "package.json"), JSON.stringify({ tsconfig: "./config/base.json" }));
        await writeFile(join(dependency, "config/base.json"), JSON.stringify({ extends: "../common.json" }));
        await writeFile(join(dependency, "common.json"), JSON.stringify({ compilerOptions: { skipLibCheck: true } }));
        await symlink(dependency, join(root, "node_modules/fixture-config"), "dir");
      };
      await unlink(join(root, "node_modules"));
      await mkdir(join(root, "node_modules"));
      await install("workspace/packages/config");
      await writeFile(project, JSON.stringify({ ...JSON.parse(original), extends: ["./shared.json", "fixture-config"] }));
      const g = guardrail("strict-null", "tsc:strictNullChecks");
      await emitInto(root, [g]);
      const sources = Object.fromEntries(Object.entries(await tscConfigSources(root)).map(([key, text]) => [key, sha256(text)]));
      expect(Object.keys(sources)).toContain("tsconfig:node_modules/fixture-config/common.json");
      await unlink(join(root, "node_modules/fixture-config"));
      await install("another/workspace/config");
      const lockedTscConfig = { sources, generated: sha256(await readFile(join(root, GENERATED_TSCONFIG))) };
      const check = () => tscAdapter.run([g], [], { ...ctxFor(root), lockedTscConfig });
      expect((await check()).find((r) => r.guardrail === "strict-null")?.status).toBe("fail");
      await writeFile(join(root, "shared.json"), inherited + "\n");
      await expect(check()).rejects.toMatchObject({
        file: join(root, "shared.json"),
        message: expect.stringContaining("differs from the signed Warden lock"),
      });
      await writeFile(join(root, "shared.json"), inherited);
      expect((await check()).find((r) => r.guardrail === "strict-null")?.status).toBe("fail");
    });
  });

  it("reports how to lock a package config whose entry is linked as a file", async () => {
    await withProject(async (root) => {
      const modules = join(root, "node_modules");
      const dependency = join(modules, "fixture-config");
      await unlink(modules);
      await mkdir(dependency, { recursive: true });
      await writeFile(join(root, "tsconfig.json"), JSON.stringify({ extends: "fixture-config" }));
      await writeFile(join(dependency, "package.json"), JSON.stringify({ tsconfig: "./base.json" }));
      await writeFile(join(root, "linked-config.json"), "{}");
      await symlink(join(root, "linked-config.json"), join(dependency, "base.json"), "file");

      await expect(tscConfigSources(root)).rejects.toMatchObject({
        file: join(dependency, "base.json"),
        message: expect.stringContaining("link the package directory or use the actual config path"),
      });
    });
  });

  it("reports the files and bytes of every file in the program it checked", async () => {
    await withProject(async (root) => {
      const g = guardrail("strict-null", "tsc:strictNullChecks");
      await emitInto(root, [g]);
      const own = (await readFile(join(root, "src/a.ts"))).length;
      const results = await tscAdapter.run([g], [], ctxFor(root));
      for (const r of results) {
        expect(r.files).toBeGreaterThan(1);
        expect(r.bytes).toBeGreaterThan(own);
      }
    });
  });

  it("emits a relative extends and identical output from different roots", () => {
    const g = guardrail("strict-null", "tsc:strictNullChecks");
    const a = tscAdapter.emit([g], { ...set, root: "/tmp/one" });
    const b = tscAdapter.emit([g], { ...set, root: "/tmp/two" });
    expect(a).toEqual(b);
    const config = JSON.parse(a[".warden/generated/tsconfig.json"] as string);
    expect(config.extends).toBe("../../tsconfig.json");
    expect(config.compilerOptions).toEqual({ noEmit: true, strictNullChecks: true });
  });

  it("sends unmatched codes to tsc:baseline-errors", async () => {
    await withProject(async (root) => {
      await writeFile(join(root, "src/b.ts"), "export const n: number = 'x';\n");
      const g = guardrail("strict-null", "tsc:strictNullChecks");
      await emitInto(root, [g]);
      const results = await tscAdapter.run([g], [], ctxFor(root));
      const baseline = results.find((r) => r.guardrail === "tsc:baseline-errors");
      expect(baseline?.status).toBe("fail");
      expect(baseline?.violations.map((v) => `${v.file}:${v.line}`)).toEqual(["src/b.ts:1"]);
    });
  });

  it("gives an unused local to a noUnusedLocals Guardrail", async () => {
    await withProject(async (root) => {
      await writeFile(join(root, "src/b.ts"), "export function f(): number {\n  const unused = 1;\n  return 2;\n}\n");
      const g = guardrail("unused", "tsc:noUnusedLocals");
      await emitInto(root, [g]);
      const results = await tscAdapter.run([g], [], ctxFor(root));
      expect(results.find((r) => r.guardrail === "unused")?.violations.map((v) => `${v.file}:${v.line} ${v.message.slice(0, 7)}`)).toEqual(["src/b.ts:2 TS6133:"]);
      expect(results.find((r) => r.guardrail === "tsc:baseline-errors")?.violations).toEqual([]);
    });
  });

  it("tells an unused parameter from an unused local when both flags are on", async () => {
    await withProject(async (root) => {
      const code = [
        "export function f(p: number, { a, b }: { a: number; b: number }, [e]: number[]): number {",
        "  const local = 1;",
        "  const { x, y } = { x: 1, y: 2 };",
        "  return b + e;",
        "}",
        "export const g = <T, U>(t: T): T => t;",
        "export const k = <V>(): number => 1;",
        "export function m<W, X>(): void {}",
        "export function h({ c, d }: { c: number; d: number }): void {}",
        "export class C {",
        "  constructor(private readonly hidden: number, q: number) {}",
        "}",
        "export const z = (n = (() => { const inner = 1; return 2; })()): number => n;",
        "export type Infer<Q> = Q extends Array<infer R> ? 1 : 2;",
        "",
      ].join("\n");
      await writeFile(join(root, "src/b.ts"), code);
      const gs = [guardrail("params", "tsc:noUnusedParameters"), guardrail("locals", "tsc:noUnusedLocals")];
      await emitInto(root, gs);
      const results = await tscAdapter.run(gs, [], ctxFor(root));
      const of = (id: string): string[] => (results.find((r) => r.guardrail === id)?.violations ?? []).map((v) => `${v.line} ${v.message.slice(0, 7)}`);
      expect(of("params")).toEqual(["1 TS6133:", "1 TS6133:", "6 TS6133:", "7 TS6133:", "8 TS6205:", "9 TS6198:", "11 TS6133:", "14 TS6133:"]);
      expect(of("locals")).toEqual(["2 TS6133:", "3 TS6198:", "11 TS6138:", "13 TS6133:"]);
      expect(results.find((r) => r.guardrail === "tsc:baseline-errors")?.violations).toEqual([]);
    });
  });

  it("sends syntax errors to the parse-error guardrail", async () => {
    await withProject(async (root) => {
      await writeFile(join(root, "src/b.ts"), "export const n = 1;\nconst = ;\n");
      const g = guardrail("strict-null", "tsc:strictNullChecks");
      await emitInto(root, [g]);
      const results = await tscAdapter.run([g], [], ctxFor(root));
      const parse = results.find((r) => r.guardrail === PARSE_ERROR);
      expect(parse?.status).toBe("fail");
      expect(parse?.violations.map((v) => `${v.file}:${v.line}`)).toEqual(["src/b.ts:2"]);
      expect(results.find((r) => r.guardrail === "tsc:baseline-errors")?.violations).toEqual([]);
    });
  });

  it("accepts a top-level @generated key in the generated tsconfig", async () => {
    await withProject(async (root) => {
      const g = guardrail("strict-null", "tsc:strictNullChecks");
      await emitInto(root, [g]);
      const path = join(root, ".warden/generated/tsconfig.json");
      const config = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ "@generated": "by warden 0.1.0", ...config }, null, 2));
      const results = await tscAdapter.run([g], [], ctxFor(root));
      expect(results.flatMap((r) => r.violations.map((v) => v.line))).toEqual([3]);
    });
  });

  it("exactOptionalPropertyTypes runs on a program without strictNullChecks", async () => {
    await withProject(async (root) => {
      await writeFile(join(root, "src/b.ts"), "export const o: { a?: number } = { a: undefined };\n");
      const g = guardrail("exact", "tsc:exactOptionalPropertyTypes");
      await emitInto(root, [g]);
      const results = await tscAdapter.run([g], [], ctxFor(root));
      const exact = results.find((r) => r.guardrail === "exact");
      expect(exact?.status).toBe("fail");
      expect(exact?.violations.map((v) => v.message.slice(0, 6))).toEqual(["TS2375"]);
    });
  });

  it("names the syntax error location in the project config and passes after repair", async () => {
    await withProject(async (root) => {
      const path = join(root, "tsconfig.json");
      const original = await readFile(path, "utf8");
      const g = guardrail("tsc", "tsc:baseline-errors");
      await emitInto(root, [g]);
      await writeFile(path, '{\n  "compilerOptions": {}\n  "include": ["src/**/*.ts"]\n}\n');
      const error = await tscAdapter.run([g], [], ctxFor(root)).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(RecordError);
      expect((error as Error).message).toMatch(/TS1005:/);
      expect((error as Error).message).toContain(`Next action: fix the syntax in ${path}:3, then run warden check again.`);
      await writeFile(path, original);
      expect((await tscAdapter.run([g], [], ctxFor(root))).map((result) => result.status)).toEqual(["pass"]);
    });
  });

  it("an options error exits as a usage failure with one next action", async () => {
    await withProject(async (root) => {
      const path = join(root, "tsconfig.json");
      const config = JSON.parse(await readFile(path, "utf8"));
      const write = (strictNullChecks: boolean) =>
        writeFile(path, JSON.stringify({ ...config, compilerOptions: { ...config.compilerOptions, exactOptionalPropertyTypes: true, strictNullChecks } }));
      await write(false);
      await writeFile(join(root, "src/a.ts"), "export const n = 1;\n");
      const g = guardrail("returns", "tsc:noImplicitReturns");
      await emitInto(root, [g]);
      const error = await tscAdapter.run([g], [], ctxFor(root)).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(RecordError);
      expect((error as RecordError).file).toBe(path);
      expect((error as RecordError).pointer).toBe("/compilerOptions");
      expect((error as RecordError).message.split("Next action:")).toHaveLength(2);
      await write(true);
      const results = await tscAdapter.run([g], [], ctxFor(root));
      expect(results.find((r) => r.guardrail === "returns")?.status).toBe("pass");
    });
  });

  it("a compiler-option code in a source file stays a violation with its file and line", async () => {
    await withProject(async (root) => {
      await writeFile(join(root, "src/b.ts"), 'export * from "./a.ts";\n');
      const g = guardrail("returns", "tsc:noImplicitReturns");
      await emitInto(root, [g]);
      const results = await tscAdapter.run([g], [], ctxFor(root));
      expect(results.find((r) => r.guardrail === "tsc:baseline-errors")?.violations.map((v) => `${v.file}:${v.line} ${v.message.slice(0, 6)}`)).toEqual(["src/b.ts:1 TS5097"]);
    });
  });

  for (const options of [false, "yes"]) {
    it(`Guardrail options ${JSON.stringify(options)} that tsc refuses name the Guardrail, and its next action clears it`, async () => {
      await withProject(async (root) => {
        await writeFile(join(root, "src/a.ts"), "export const n = 1;\n");
        const exact = guardrail("exact", "tsc:exactOptionalPropertyTypes");
        const nulls = { ...guardrail("nulls", "tsc:strictNullChecks"), options };
        await emitInto(root, [exact, nulls]);
        const error = await tscAdapter.run([exact, nulls], [], ctxFor(root)).then(() => undefined, (e: unknown) => e);
        expect(error).toBeInstanceOf(RecordError);
        expect((error as RecordError).file).toBe(join(root, ".warden/generated/tsconfig.json"));
        expect((error as RecordError).message).toContain(".warden/generated/tsconfig.json(");
        const [, next] = (error as RecordError).message.split("Next action:");
        expect((error as RecordError).message.split("Next action:")).toHaveLength(2);
        expect(next).toContain("nulls");
        expect(next).not.toContain("exact");
        const fixed = guardrail("nulls", "tsc:strictNullChecks");
        await emitInto(root, [exact, fixed]);
        const results = await tscAdapter.run([exact, fixed], [], ctxFor(root));
        expect(results.map((r) => r.status)).toEqual(["pass", "pass", "pass"]);
      });
    });
  }

  it("a project with no typescript of its own runs tsc Guardrails with Warden's bundled typescript", async () => {
    const root = await mkdtemp(join(tmpdir(), "warden-tsc-none-"));
    try {
      await cp(source, root, { recursive: true });
      const g = guardrail("strict-null", "tsc:strictNullChecks");
      await emitInto(root, [g]);
      const results = await tscAdapter.run([g], [], ctxFor(root));
      expect(results.flatMap((r) => r.violations.map((v) => `${v.file}:${v.line}`))).toEqual(["src/a.ts:3"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  let fresh = tscAdapter;

  const withStubTsc = async (script: string, fn: (root: string) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "warden-tsc-stub-"));
    try {
      await writeFile(join(root, "stub-tsc.mjs"), `import { parentPort } from "node:worker_threads";\nparentPort.on("message", () => { ${script} });\n`);
      stub.path = join(root, "stub-tsc.mjs");
      vi.resetModules();
      fresh = (await import("../../src/adapters/tsc.js")).tscAdapter;
      await fn(root);
    } finally {
      stub.path = undefined;
      await rm(root, { recursive: true, force: true });
    }
  };

  const g = guardrail("strict-null", "tsc:strictNullChecks");

  it("throws with the reason when the compiler throws, and the next run starts a fresh compiler", async () => {
    await withStubTsc('throw new Error("boom reason");', async (root) => {
      await expect(fresh.run([g], [], ctxFor(root))).rejects.toThrow(/^tsc ended with boom reason$/);
    });
    await withProject(async (root) => {
      await emitInto(root, [g]);
      const results = await fresh.run([g], [], ctxFor(root));
      expect(results.flatMap((r) => r.violations.map((v) => `${v.file}:${v.line}`))).toEqual(["src/a.ts:3"]);
    });
  });

  it("one compiler serves every run in a process", async () => {
    vi.resetModules();
    const { tscAdapter: adapter } = await import("../../src/adapters/tsc.js");
    stub.started = 0;
    await withProject(async (root) => {
      await emitInto(root, [g]);
      for (let i = 0; i < 3; i++) expect((await adapter.run([g], [], ctxFor(root))).flatMap((r) => r.violations.map((v) => v.line))).toEqual([3]);
    });
    expect(stub.started).toBe(1);
  });

  it("throws when the compiler stops without a reply", async () => {
    await withStubTsc("process.exit(3);", async (root) => {
      await expect(fresh.run([g], [], ctxFor(root))).rejects.toThrow(/^tsc ended with exit code 3$/);
    });
  });

  it("throws when the compiler reports errors but no diagnostic", async () => {
    await withStubTsc('parentPort.postMessage({ stdout: "", code: 1 });', async (root) => {
      await expect(fresh.run([g], [], ctxFor(root))).rejects.toThrow(/exited with 1/);
    });
  });

  it("an options error with no file position is a usage failure", async () => {
    await withStubTsc('parentPort.postMessage({ stdout: "error TS5052: refused.\\n", code: 1, parameters: [] });', async (root) => {
      const error = await fresh.run([g], [], ctxFor(root)).then(() => undefined, (e: unknown) => e);
      expect((error as Error).name).toBe("RecordError");
      expect((error as RecordError).pointer).toBe("/compilerOptions");
      expect((error as RecordError).message.split("Next action:")).toHaveLength(2);
    });
  });

  it("a compiler still running at the budget is stopped and reported as killed", async () => {
    await withStubTsc("for (;;);", async (root) => {
      const results = await fresh.run([{ ...g, budgetMs: 100 }], [], ctxFor(root));
      expect(results.map((r) => r.status)).toEqual(["killed", "killed"]);
      expect(results[0]?.command).toBe("npx tsc -p .warden/generated/tsconfig.json --pretty false");
    });
  });
});

describe("tsc worker parse cache", () => {
  it("keeps one key across programs that differ only in check flags", () => {
    const base = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const checks: ts.CompilerOptions[] = [{ strictNullChecks: true }, { noImplicitAny: true }, { exactOptionalPropertyTypes: true, strictNullChecks: true }, { noImplicitOverride: true, noEmit: true }];
    expect(checks.map((flags) => parseKey({ ...base, ...flags }))).toEqual(checks.map(() => parseKey(base)));
  });

  it.each([
    ["allowUnreachableCode", "export const f = (): number => {\n  return 1;\n  f();\n};\n", "TS7027"],
    ["allowUnusedLabels", "export const f = (): number => {\n  loop: for (;;) return 1;\n};\n", "TS7028"],
  ])("a node_modules file reused after a program without %s reports its bind error", async (flag, text, code) => {
    await withProject(async (root) => {
      const vendored = "vendor/node_modules/pkg/index.ts";
      await mkdir(join(root, dirname(vendored)), { recursive: true });
      await writeFile(join(root, vendored), text);
      await writeFile(join(root, "src/c.ts"), "import \"../vendor/node_modules/pkg/index\";\n");
      const first = guardrail("returns", "tsc:noImplicitReturns");
      await emitInto(root, [first]);
      await tscAdapter.run([first], [], ctxFor(root));
      const bind = { ...guardrail("bind", `tsc:${flag}`), options: false };
      await emitInto(root, [bind]);
      const results = await tscAdapter.run([bind], [], ctxFor(root));
      expect(results.find((r) => r.guardrail === "bind")?.violations.map((v) => `${v.file} ${v.message.slice(0, 6)}`)).toEqual([`${vendored} ${code}`]);
    });
  });
});
