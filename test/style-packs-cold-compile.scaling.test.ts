import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { compile } from "../src/compiler/compile.js";
import { LOCK_PATH } from "../src/compiler/lock.js";
import { adapters } from "../src/runner/run.js";

const wardenRoot = resolve(import.meta.dirname, "..");

it("compiles all five style packs with cold admission with serial measurements", async () => {
  const root = await mkdtemp(join(tmpdir(), "warden-cold-style-packs-"));
  const measured = new Set<string>();
  let active = false;
  for (const id of ["eslint", "tsc"]) {
    const adapter = adapters.get(id);
    if (adapter === undefined) throw new Error(`Missing adapter ${id}`);
    const run = adapter.run;
    vi.spyOn(adapter, "run").mockImplementation(async (rules, files, context) => {
      if (context.unbudgeted !== true) return run(rules, files, context);
      expect(active).toBe(false);
      active = true;
      measured.add(id);
      try {
        return await run(rules, files, context);
      } finally {
        active = false;
      }
    });
  }

  try {
    await mkdir(join(root, ".warden"), { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true },
      include: ["**/*.ts"],
    }));
    await writeFile(join(root, ".warden/config.yaml"), `project: cold-style-packs
base: main
packs:
  - id: core
    paths: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]
  - id: typescript
    paths: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"]
  - id: rxjs-declarative
    paths: ["src/rx/**"]
  - id: signals
    paths: ["src/sig/**"]
  - id: declarative-ui
    paths: ["src/ui/**"]
tierBudgetMs: { edit: 2000, commit: 10000, boundary: 120000 }
loopBreakerRepeats: 3
`);
    const result = await compile(root, wardenRoot);
    expect(result.findings).toEqual([]);
    expect(result.written).toContain(LOCK_PATH);
    expect(measured).toEqual(new Set(["eslint", "tsc"]));
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
