import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fsAdapter } from "../../src/adapters/tree.js";
import { conformance } from "./conformance.js";
import { shippedPack, treeGuardrail, treeSet } from "./tree-pack.js";

const fixture = resolve(import.meta.dirname, "../fixtures/adapters/tree");

const check = [
  "export default {",
  "  mentions: ({ files, read, settings, terms }) => files.filter((f) => read(f).includes(settings.word)).map((file) => ({ file, message: `${file} names ${settings.word} with ${terms.length} term`, doThis: \"Rename it.\" })),",
  "  stray: () => [{ file: \"src/none.ts\", message: \"m\" }],",
  "};",
  "",
].join("\n");

describe("fs adapter", () => {
  it("fs conformance: a pack check reports each file it finds, with the pack's settings, the Terms, and its next action", async () => {
    const pack = await shippedPack("fs", check);
    try {
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      await conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts", "src/b.ts"], [
        { guardrail: "g", file: "src/a.ts", line: 1, message: "src/a.ts names b with 1 term", doThis: "Rename it." },
        { guardrail: "g", file: "src/b.ts", line: 1, message: "src/b.ts names b with 1 term", doThis: "Rename it." },
      ]);
    } finally {
      await pack.remove();
    }
  });

  it("checks only the files inside the Practice and config paths", async () => {
    const pack = await shippedPack("fs", check);
    try {
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      await conformance(fsAdapter, fixture, [g], treeSet(g), ["src/b.ts", "other.ts"], [
        { guardrail: "g", file: "src/b.ts", line: 1, message: "src/b.ts names b with 1 term", doThis: "Rename it." },
      ]);
    } finally {
      await pack.remove();
    }
  });

  it("refuses a check that reports a file it was not given", async () => {
    const pack = await shippedPack("fs", check);
    try {
      const g = treeGuardrail("fs:local/stray", pack.dir);
      await expect(conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], [])).rejects.toThrow(`fs:local/stray reported src/none.ts, which is not one of the files it was given. Next action: make fs:local/stray in ${pack.dir}/fs.js report only files from its input, then run warden compile.`);
    } finally {
      await pack.remove();
    }
  });
});
