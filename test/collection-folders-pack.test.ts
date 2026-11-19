import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExamples } from "../src/compiler/examples.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { fsAdapter } from "../src/adapters/tree.js";
import { measureBaseline, projectFiles, writeBaseline } from "../src/runner/baseline.js";
import { runGuardrails } from "../src/runner/run.js";

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

let written: string[];

const write = async (file: string, content = "export const a = 1;\n"): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
  if (!file.startsWith(".")) written.push(file);
};

const run = async (id: string, files: string[] = written) => {
  const g = guardrails.find((x) => x.id === id) as Guardrail;
  for (const [path, content] of Object.entries(fsAdapter.emit([g], set))) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const [result] = await runGuardrails(set, [g], files, { root, generatedDir: join(root, ".warden/generated") });
  return result;
};

const messages = async (id: string): Promise<string[] | undefined> => (await run(id))?.violations.map((v) => v.message);

beforeEach(async () => {
  written = [];
  root = await mkdtemp(join(tmpdir(), "warden-collection-folders-"));
  await write(".warden/config.yaml", config);
  set = await loadRecords(root, wardenRoot);
  guardrails = set.packs.find((p) => p.id === "collection-folders")?.practices.flatMap((x) => x.guardrails) ?? [];
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("collection-folders pack", () => {
  it("collection-folders pack examples hold", async () => {
    expect(guardrails.map((g) => g.id)).toEqual([
      "warden-collection-holds-only-folders",
      "warden-collections-do-not-nest",
      "warden-collection-names-are-plural-kebab-case",
      "warden-collection-items-share-one-shape",
    ]);
    expect(await runExamples(set)).toEqual([]);
  });

  it("reports each loose file as its own violation, with one next action, so it can be baselined", async () => {
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/stray.ts");
    await write("src/[widgets]/other.ts");
    const failed = await run("warden-collection-holds-only-folders");
    expect(failed?.violations.map((v) => [v.file, v.message, v.doThis])).toEqual([
      ["src/[widgets]/stray.ts", "src/[widgets]/stray.ts is a file directly inside a collection.", "Move this file into an item folder of its collection."],
      ["src/[widgets]/other.ts", "src/[widgets]/other.ts is a file directly inside a collection.", "Move this file into an item folder of its collection."],
    ]);
  });

  it("baselines existing deviations file by file, as warden init does", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/stray.ts");
    await write("src/[Widget]/knob/index.ts");
    for (const [path, content] of Object.entries(fsAdapter.emit(guardrails, set))) await write(path, content);
    const { baseline } = await measureBaseline(set, guardrails);
    expect(baseline).toEqual({
      "warden-collection-holds-only-folders": { "src/[widgets]/stray.ts": 1 },
      "warden-collection-names-are-plural-kebab-case": { "src/[Widget]/knob/index.ts": 1 },
    });
    expect(() => writeBaseline(root, baseline)).not.toThrow();
  });

  it("checks the files warden check lists, which in a git repository skip ignored ones", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await write(".gitignore", "dist/\n");
    await write("dist/[widgets]/bundle.js");
    await write("src/[widgets]/button/index.ts");
    expect((await run("warden-collection-holds-only-folders", projectFiles(root, ["**/*"])))?.status).toBe("pass");
  });

  it("reports a nested and a misnamed collection on the first file inside it", async () => {
    await write("src/[widgets]/[parts]/knob/index.ts");
    await write("src/[Widget]/button/index.ts");
    expect((await run("warden-collections-do-not-nest"))?.violations.map((v) => [v.file, v.message])).toEqual([["src/[widgets]/[parts]/knob/index.ts", "src/[widgets]/[parts] is a collection directly inside a collection."]]);
    expect((await run("warden-collection-names-are-plural-kebab-case"))?.violations.map((v) => [v.file, v.doThis])).toEqual([
      ["src/[Widget]/button/index.ts", "Rename src/[Widget] to lowercase kebab-case ending in s, such as [quality-gates]."],
    ]);
  });

  it("names what an item lacks and what it has extra", async () => {
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/card/index.ts");
    await write("src/[widgets]/knob/knob.ts");
    const failed = await run("warden-collection-items-share-one-shape");
    expect(failed?.violations.map((v) => [v.file, v.message])).toEqual([["src/[widgets]/knob/knob.ts", "src/[widgets]/knob differs from the shape most items in src/[widgets] share: lacks [index.ts], has extra [knob.ts]."]]);
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
    expect(await messages("warden-collection-items-share-one-shape")).toContainEqual(expect.stringContaining("src/[widgets]/c differs from the shape most items in src/[widgets] share: lacks [data.ts], has extra [index.ts]"));
  });

  it("names a missing item-named file after the item it belongs to", async () => {
    await write("src/[widgets]/Button/Button.tsx");
    await write("src/[widgets]/Card/Card.tsx");
    await write("src/[widgets]/Knob/index.ts");
    expect(await messages("warden-collection-items-share-one-shape")).toContainEqual(expect.stringContaining("src/[widgets]/Knob differs from the shape most items in src/[widgets] share: lacks [Knob.tsx], has extra [index.ts]"));
  });

  it("leaves out an empty lacks list", async () => {
    await write("src/[widgets]/button/index.ts");
    await write("src/[widgets]/card/index.ts");
    await write("src/[widgets]/knob/index.ts");
    await write("src/[widgets]/knob/notes.md");
    expect(await messages("warden-collection-items-share-one-shape")).toEqual(["src/[widgets]/knob differs from the shape most items in src/[widgets] share: has extra [notes.md]."]);
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
