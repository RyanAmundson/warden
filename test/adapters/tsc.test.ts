import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tscAdapter } from "../../src/adapters/tsc.js";
import { PARSE_ERROR } from "../../src/adapters/types.js";
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

  it("a compiler still running at the budget is stopped and reported as killed", async () => {
    await withStubTsc("for (;;);", async (root) => {
      const results = await fresh.run([{ ...g, budgetMs: 100 }], [], ctxFor(root));
      expect(results.map((r) => r.status)).toEqual(["killed", "killed"]);
      expect(results[0]?.command).toBe("npx tsc -p .warden/generated/tsconfig.json --pretty false");
    });
  });
});
