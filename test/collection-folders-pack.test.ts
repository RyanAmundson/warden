import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExamples } from "../src/compiler/examples.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { runGuardrails } from "../src/runner/run.js";
import { bench } from "./pack-bench.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const config = [
  "warden: 0.1.0",
  "project: sample",
  "base: main",
  "packs:",
  "  - id: core",
  "    paths: [\"**/*.{ts,tsx,mts,cts,js,mjs,cjs}\"]",
  "  - id: collection-folders",
  "    paths: [\"**/*\"]",
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

let root: string;
let set: RecordSet;
let guardrails: Guardrail[];

const write = async (file: string, content = "export const a = 1;\n"): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const run = async (id: string) => {
  const g = guardrails.find((x) => x.id === id) as Guardrail;
  const [result] = await runGuardrails(set, [g], [], { root, generatedDir: join(root, ".warden/generated") });
  return result;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-collection-folders-"));
  await write(".warden/config.yaml", config);
  set = await loadRecords(root, wardenRoot);
  guardrails = set.packs.find((p) => p.id === "collection-folders")?.practices.flatMap((x) => x.guardrails) ?? [];
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("collection-folders pack", () => {
  it.each([
    "warden-collection-holds-only-folders",
    "warden-collections-do-not-nest",
    "warden-collection-names-are-plural-kebab-case",
    "warden-collection-items-share-one-shape",
  ])("%s scales at most linearly", async (rule) => {
    const { code, out } = await bench(root, { rule });
    expect(code, out).toBe(0);
  });

  it("collection-folders pack examples hold", async () => {
    expect(guardrails.map((g) => g.id)).toEqual([
      "warden-collection-holds-only-folders",
      "warden-collections-do-not-nest",
      "warden-collection-names-are-plural-kebab-case",
      "warden-collection-items-share-one-shape",
    ]);
    expect(await runExamples(set)).toEqual([]);
  });

  it("in a git repository reads tracked and untracked files, ignores ignored ones, and ends with a next action", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await write(".gitignore", "dist/\n");
    await write("dist/[widgets]/bundle.js");
    await write("src/[widgets]/button/index.ts");
    expect((await run("warden-collection-holds-only-folders"))?.status).toBe("pass");
    await write("src/[widgets]/stray.ts");
    const failed = await run("warden-collection-holds-only-folders");
    expect(failed?.status).toBe("fail");
    const lines = failed?.violations[0]?.message.split("\n") ?? [];
    expect(lines).toContain("src/[widgets]/stray.ts is a file directly inside a collection");
    expect(lines.at(-1)).toMatch(/Next action: move each listed file into an item folder of its collection\.$/);
  });

  it("names what an item lacks and what it has extra", async () => {
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/card/index.ts");
    await write("src/[widgets]/knob/knob.ts");
    const failed = await run("warden-collection-items-share-one-shape");
    expect(failed?.violations[0]?.message).toContain("src/[widgets]/knob differs from the shape most items in src/[widgets] share: lacks [index.ts], has extra [knob.ts]");
  });

  it("compares entries named after their item as one shape", async () => {
    await write("src/[widgets]/Button/Button.tsx");
    await write("src/[widgets]/Button/index.ts");
    await write("src/[widgets]/Card/Card.tsx");
    await write("src/[widgets]/Card/index.ts");
    expect((await run("warden-collection-items-share-one-shape"))?.status).toBe("pass");
  });

  it("replaces only a leading item name, so an item named a keeps data.ts as is", async () => {
    await write("src/[widgets]/a/data.ts");
    await write("src/[widgets]/b/data.ts");
    await write("src/[widgets]/c/index.ts");
    const failed = await run("warden-collection-items-share-one-shape");
    expect(failed?.violations[0]?.message).toContain("src/[widgets]/c differs from the shape most items in src/[widgets] share: lacks [data.ts], has extra [index.ts]");
  });

  it("names a missing item-named file after the item it belongs to", async () => {
    await write("src/[widgets]/Button/Button.tsx");
    await write("src/[widgets]/Card/Card.tsx");
    await write("src/[widgets]/Knob/index.ts");
    const failed = await run("warden-collection-items-share-one-shape");
    expect(failed?.violations[0]?.message).toContain("src/[widgets]/Knob differs from the shape most items in src/[widgets] share: lacks [Knob.tsx], has extra [index.ts]");
  });

  it("leaves out an empty lacks list", async () => {
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/card/index.ts");
    await write("src/[widgets]/knob/index.ts");
    await write("src/[widgets]/knob/notes.md");
    const failed = await run("warden-collection-items-share-one-shape");
    expect(failed?.violations[0]?.message).toContain("src/[widgets]/knob differs from the shape most items in src/[widgets] share: has extra [notes.md]\n");
  });

  it("passes an item named like a file the other items share", async () => {
    await write("src/[routes]/about/index.ts");
    await write("src/[routes]/home/index.ts");
    await write("src/[routes]/index/index.ts");
    expect((await run("warden-collection-items-share-one-shape"))?.status).toBe("pass");
  });

  it("skips a collection whose most common shapes tie", async () => {
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/card/card.ts");
    expect((await run("warden-collection-items-share-one-shape"))?.status).toBe("pass");
  });
});
