import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { graphAdapter } from "../../src/adapters/tree.js";
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
