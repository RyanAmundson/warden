import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moduleAdapter } from "../../src/adapters/tree.js";
import { conformance } from "./conformance.js";
import { shippedPack, treeGuardrail, treeSet } from "./tree-pack.js";

const fixture = resolve(import.meta.dirname, "../fixtures/adapters/tree");

const check = [
  "export default {",
  "  exports: ({ files, load }) => files.filter((f) => f.endsWith(\"entry.ts\")).map((file) => {",
  "    try { return { file, message: JSON.stringify(load(file)) }; } catch (cause) { return { file, message: `error: ${cause.message}` }; }",
  "  }),",
  "  stray: ({ load }) => { load(\"src/elsewhere.ts\"); return []; },",
  "};",
  "",
].join("\n");

let root: string;
let pack: { dir: string; remove: () => Promise<void> };

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const run = async (name: string, files: string[]) => {
  const g = treeGuardrail(`module:local/${name}`, pack.dir);
  const set = { ...treeSet(g), root };
  for (const [path, content] of Object.entries(moduleAdapter.emit([g], set))) await write(path, content);
  return moduleAdapter.run([g], files, { root, generatedDir: join(root, ".warden/generated") });
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-module-"));
  pack = await shippedPack("module", check);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await pack.remove();
});

describe("module adapter", () => {
  it("passes the shared conformance suite, loading the fixture's extensionless import", async () => {
    const g = treeGuardrail("module:local/exports", pack.dir);
    await writeFile(join(pack.dir, "module.js"), "export default { exports: ({ files, load }) => files.filter((f) => f.endsWith(\"a.ts\")).map((file) => ({ file, message: JSON.stringify(load(file)) })) };\n");
    await conformance(moduleAdapter, fixture, [g], treeSet(g), ["src/a.ts", "src/b.ts"], [{ guardrail: "g", file: "src/a.ts", line: 1, message: JSON.stringify({ a: [1, { $function: "readFile" }] }) }]);
  });

  it("hands pack code a TypeScript module's exports as data, resolving bundler-style and installed imports", async () => {
    await write("src/entry.ts", [
      "import { twice } from \"./math.js\";",
      "import { label } from \"./label\";",
      "import { sdk } from \"sdk\";",
      "const typed: number = twice(2);",
      "export const value = { typed, label, sdk, run: function run() { return 1; } };",
      "",
    ].join("\n"));
    await write("src/math.ts", "export const twice = (n: number): number => n * 2;\n");
    await write("src/label.tsx", "export const label: string = \"x\";\n");
    await write("node_modules/sdk/package.json", JSON.stringify({ name: "sdk", type: "module", exports: { ".": "./index.js" } }));
    await write("node_modules/sdk/index.js", "export const sdk = \"installed\";\n");
    const [result] = await run("exports", ["src/entry.ts", "src/math.ts", "src/label.tsx"]);
    expect(result?.violations.map((v) => v.message)).toEqual([JSON.stringify({ value: { typed: 4, label: "x", sdk: "installed", run: { $function: "run" } } })]);
  });

  it("writes an object that two fields share in both, and cuts only a true cycle", async () => {
    await write("src/entry.ts", "const shared = { a: 1 };\nconst loop: { self?: unknown } = {};\nloop.self = loop;\nexport const manifest = shared;\nexport const plugin = { manifest: shared, loop, list: [shared, undefined] };\n");
    const [result] = await run("exports", ["src/entry.ts"]);
    expect(result?.violations.map((v) => v.message)).toEqual([JSON.stringify({ manifest: { a: 1 }, plugin: { manifest: { a: 1 }, loop: { self: "[Circular]" }, list: [{ a: 1 }, null] } })]);
  });

  it("reports a module that does not load as an error the pack code can catch", async () => {
    await write("src/entry.ts", "import { missing } from \"./absent.js\";\nexport const value = missing;\n");
    const [result] = await run("exports", ["src/entry.ts"]);
    expect(result?.violations[0]?.message).toMatch(/^error: src\/entry\.ts did not load: Error \[ERR_MODULE_NOT_FOUND\]: Cannot find module/);
  });

  it("refuses to load a file the check was not given", async () => {
    await write("src/elsewhere.ts", "export const value = 1;\n");
    await expect(run("stray", ["src/a.ts"])).rejects.toThrow("src/elsewhere.ts is not one of the files the check was given");
  });
});
