import { resolve } from "node:path";
import { expect, it } from "vitest";

it("reads each linked Unit document once, even when its own links refer to anchors", async () => {
  const packPath = resolve(import.meta.dirname, "../../packs/unit-layout/fs.js");
  const { default: pack } = await import(packPath);
  const documents = new Map([
    ["one/UNIT.md", "# One"],
    ["two/UNIT.md", "# Two"],
  ]);
  const reads: string[] = [];
  const findings: unknown = pack["document-links"]({
    files: [...documents.keys()],
    read: (file: string) => {
      reads.push(file);
      return documents.get(file);
    },
    markdownLinks: (body: string) => body === "# One" ? ["#one", "../two/UNIT.md#two", "#missing"] : ["#two"],
    markdownAnchors: (body: string) => [body.slice(2).toLowerCase()],
    terms: [],
    unitStructure: { units: [...documents.keys()].map((document) => ({ document })), ignoreCase: false },
  });
  expect(findings).toEqual([expect.objectContaining({ file: "one/UNIT.md", message: expect.stringContaining("#missing") })]);
  expect(reads).toEqual(["one/UNIT.md", "two/UNIT.md"]);
});
