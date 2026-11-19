import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { graphAdapter, importGraph } from "../../src/adapters/tree.js";
import { conformance } from "./conformance.js";
import { shippedPack, treeGuardrail, treeSet } from "./tree-pack.js";

const fixture = resolve(import.meta.dirname, "../fixtures/adapters/tree");

const check = [
  "export default {",
  "  edges: ({ files, imports }) => files.flatMap((file) => imports.get(file).map(({ target, line }) => ({ file, line, message: `${file} imports ${target}` }))),",
  "};",
  "",
].join("\n");

describe("graph adapter", () => {
  it("places each import on its own line in a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warden-graph-lines-"));
    try {
      await mkdir(join(dir, "src"));
      await writeFile(join(dir, "src/b.ts"), "export const b = 1;\n");
      await writeFile(join(dir, "src/c.ts"), "export const c = 1;\n");
      const text = `import { b } from "./b";\n${"\n".repeat(40)}export const x = 1;\nimport { c } from "./c";\n`;
      await writeFile(join(dir, "src/a.ts"), text);
      const graph = await importGraph(dir, ["src/a.ts"], (f) => (f === "src/a.ts" ? text : ""));
      expect(graph.get("src/a.ts")).toEqual([{ target: "src/b.ts", specifier: "./b", line: 1 }, { target: "src/c.ts", specifier: "./c", line: 43 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads compiler options from tsconfig.json without listing the project's files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warden-graph-config-"));
    const listed = vi.spyOn(ts.sys, "readDirectory");
    try {
      await mkdir(join(dir, "src/lib"), { recursive: true });
      await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } }, include: ["src/**/*"] }));
      await writeFile(join(dir, "src/lib/b.ts"), "export const b = 1;\n");
      const text = 'import { b } from "@lib/b";\n';
      const graph = await importGraph(dir, ["src/a.ts"], () => text);
      expect(graph.get("src/a.ts")).toEqual([{ target: "src/lib/b.ts", specifier: "@lib/b", line: 1 }]);
      expect(listed).not.toHaveBeenCalled();
    } finally {
      listed.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph conformance: a pack check sees each resolved project import at its line, and no package import", async () => {
    const pack = await shippedPack("graph", check);
    try {
      const g = treeGuardrail("graph:local/edges", pack.dir);
      await conformance(graphAdapter, fixture, [g], treeSet(g), ["src/a.ts", "src/b.ts"], [{ guardrail: "g", file: "src/a.ts", line: 1, message: "src/a.ts imports src/b.ts" }]);
    } finally {
      await pack.remove();
    }
  });

  it("refuses a pack that ships no graph.js, with the file to add", async () => {
    const pack = await shippedPack("fs", check);
    try {
      const g = treeGuardrail("graph:local/edges", pack.dir);
      await expect(conformance(graphAdapter, fixture, [g], treeSet(g), ["src/a.ts"], [])).rejects.toThrow(`pack local ships no graph.js. Next action: add ${resolve(pack.dir, "graph.js")}`);
    } finally {
      await pack.remove();
    }
  });
});
