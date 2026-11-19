import { mkdir, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  it.each([
    ["a relative import that leaves the pack folder", "export { default } from \"../../../tools/impl.js\";\n", "../../../tools/impl.js"],
    ["a package import", "import x from \"left-pad\";\nexport default { mentions: () => x };\n", "left-pad"],
    ["a nested file that leaves the folder", "export { default } from \"./inner.js\";\n", "../outside.js"],
  ])("refuses pack code with %s, because the lock hashes only the pack folder", async (_name, code, escape) => {
    const pack = await shippedPack("fs", code);
    try {
      await writeFile(join(pack.dir, "inner.js"), "export { default } from \"../outside.js\";\n");
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      await expect(conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], [])).rejects.toThrow(`imports ${escape}, which is outside the pack folder ${await realpath(pack.dir)}, so the lock cannot see it. Next action: move what ${escape} provides into`);
    } finally {
      await pack.remove();
    }
  });

  it("refuses pack code that is a link to a file outside the pack folder", async () => {
    const pack = await shippedPack("fs", check);
    try {
      await rename(join(pack.dir, "fs.js"), join(pack.dir, "../real.js"));
      await symlink("../real.js", join(pack.dir, "fs.js"));
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      await expect(conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], [])).rejects.toThrow(`is a symbolic link in a pack folder, so the lock cannot hash what it points to. Next action: replace ${join(await realpath(pack.dir), "fs.js")} with a copy of what it points to, then run warden compile.`);
    } finally {
      await pack.remove();
    }
  });

  it("refuses a link to a lax check inside the pack folder, because retargeting it would swap the code unhashed", async () => {
    const pack = await shippedPack("fs", check);
    try {
      await rename(join(pack.dir, "fs.js"), join(pack.dir, "strict.js"));
      await writeFile(join(pack.dir, "lax.js"), "export default { mentions: () => [] };\n");
      await symlink("lax.js", join(pack.dir, "fs.js"));
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      await expect(conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], [])).rejects.toThrow("is a symbolic link in a pack folder, so the lock cannot hash what it points to. Next action: replace");
    } finally {
      await pack.remove();
    }
  });

  it.each([
    ["an extensionless require of an in-folder file that leaves the folder", { "fs.js": "module.exports = require(\"./lib\");\n", "lib.js": "module.exports = require(\"../impl.cjs\");\n" }, "imports ../impl.cjs, which is outside the pack folder"],
    ["a require of a folder whose index leaves the folder", { "fs.js": "module.exports = require(\"./lib\");\n", "lib/index.js": "module.exports = require(\"../../impl.cjs\");\n" }, "imports ../../impl.cjs, which is outside the pack folder"],
    ["an ES import of a folder", { "fs.js": "export { default } from \"./lib\";\n", "lib/index.js": "export default {};\n" }, "imports the folder ./lib, which Node's ES module loader refuses. Next action: import the file inside it by its full name, such as ./lib/index.js"],
    ["an extensionless ES import", { "fs.js": "export { default } from \"./lib\";\n", "lib.js": "export default {};\n" }, "imports ./lib, which names no file. Next action: make ./lib"],
    ["a require of a missing file", { "fs.js": "module.exports = require(\"./gone\");\n" }, "requires ./gone, which names no file that Node can load. Next action: make ./gone"],
    ["createRequire from node:module", { "fs.js": "import { createRequire } from \"node:module\";\nexport default createRequire(import.meta.url)(\"../impl.cjs\");\n" }, "imports node:module, which is not one of the data-only built-ins pack code may use (node:path, node:url, node:util), so it could run code the lock does not hash"],
    ["createRequire from a built-in fetched at run time", { "fs.js": "export default process.getBuiltinModule(\"node:module\").createRequire(import.meta.url)(\"../impl.cjs\");\n" }, "uses getBuiltinModule, which can run code the lock does not hash"],
    ["module.register", { "fs.js": "import { register } from \"module\";\nregister(\"../hook.mjs\", import.meta.url);\nexport default {};\n" }, "imports module, which is not one of the data-only built-ins pack code may use (node:path, node:url, node:util), so it could run code the lock does not hash"],
    ["module.require in CommonJS", { "fs.js": "module.exports = module.require(\"../impl.cjs\");\n" }, "uses module other than as module.exports"],
    ["an aliased require", { "fs.js": "const load = require;\nmodule.exports = load(\"../impl.cjs\");\n" }, "uses require other than to call it with a fixed path"],
    ["import() of a URL", { "fs.js": "export default (await import(new URL(\"../impl.js\", import.meta.url))).default;\n" }, "calls import() with a computed path, which Warden cannot follow"],
    ["import() of a template with a substitution", { "fs.js": "export default (await import(`${\"../impl.js\"}`)).default;\n" }, "calls import() with a computed path, which Warden cannot follow"],
    ["new Function over a read file", { "fs.js": "export default { mentions: new Function(\"input\", \"return []\") };\n" }, "uses Function, which can run code the lock does not hash"],
    ["a Function reached through constructor", { "fs.js": "export default { mentions: (() => {}).constructor(\"return []\") };\n" }, "uses constructor, which can run code the lock does not hash"],
    ["process.dlopen", { "fs.js": "process.dlopen({ exports: {} }, \"../addon.node\");\nexport default {};\n" }, "uses dlopen, which can run code the lock does not hash"],
    ["eval", { "fs.js": "export default globalThis.eval(\"({})\");\n" }, "uses eval, which can run code the lock does not hash"],
    ["node:vm", { "fs.js": "import vm from \"node:vm\";\nexport default vm.runInThisContext(\"({})\");\n" }, "imports node:vm, which is not one of the data-only built-ins pack code may use (node:path, node:url, node:util), so it could run code the lock does not hash"],
    ["node:child_process", { "fs.js": "import { execFileSync } from \"node:child_process\";\nexport default { mentions: () => JSON.parse(execFileSync(\"node\", [\"../run.mjs\"])) };\n" }, "imports node:child_process, which is not one of the data-only built-ins pack code may use (node:path, node:url, node:util), so it could run code the lock does not hash"],
    ["node:worker_threads", { "fs.js": "import { Worker } from \"node:worker_threads\";\nnew Worker(\"../run.mjs\");\nexport default {};\n" }, "imports node:worker_threads, which is not one of the data-only built-ins pack code may use (node:path, node:url, node:util), so it could run code the lock does not hash"],
    ["node:inspector", { "fs.js": "import { Session } from \"node:inspector\";\nconst s = new Session();\ns.connect();\ns.post(\"Runtime.evaluate\", { expression: \"1\" });\nexport default {};\n" }, "imports node:inspector, which is not one of the data-only built-ins"],
    ["node:cluster", { "fs.js": "import cluster from \"node:cluster\";\ncluster.setupPrimary({ exec: \"../run.cjs\" });\ncluster.fork();\nexport default {};\n" }, "imports node:cluster, which is not one of the data-only built-ins"],
    ["node:fs", { "fs.js": "import { writeFileSync } from \"node:fs\";\nwriteFileSync(\"../out.txt\", \"x\");\nexport default {};\n" }, "imports node:fs, which is not one of the data-only built-ins"],
    ["a string-literal index of a dynamic loader", { "fs.js": "export default process[\"getBuiltinModule\"](\"node:fs\");\n" }, "uses getBuiltinModule, which can run code the lock does not hash"],
    ["a built-in without the node: prefix", { "fs.js": "import { posix } from \"path\";\nexport default { mentions: () => [posix.sep] };\n" }, "imports the built-in path without the node: prefix. Next action: import it as node:path"],
  ])("refuses pack code with %s, with one next action", async (_name, files, message) => {
    const pack = await shippedPack("fs", "");
    try {
      await writeFile(join(pack.dir, "../impl.cjs"), "module.exports = { mentions: () => [] };\n");
      for (const [file, code] of Object.entries(files)) {
        await mkdir(dirname(join(pack.dir, file)), { recursive: true });
        await writeFile(join(pack.dir, file), code);
      }
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      const refusal = conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], []);
      await expect(refusal).rejects.toThrow(message);
      await expect(refusal).rejects.toThrow(/Next action: [^]*, then run warden compile\.$/);
    } finally {
      await pack.remove();
    }
  });

  it("follows an extensionless require and a folder index inside the pack folder, as Node does", async () => {
    const pack = await shippedPack("fs", "module.exports = require(\"./lib\");\n");
    try {
      await writeFile(join(pack.dir, "lib.js"), "module.exports = require(\"./parts\");\n");
      await mkdir(join(pack.dir, "parts"));
      await writeFile(join(pack.dir, "parts/index.js"), "module.exports = { mentions: ({ files }) => files.map((file) => ({ file, message: \"found\" })) };\n");
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      await conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], [{ guardrail: "g", file: "src/a.ts", line: 1, message: "found" }]);
    } finally {
      await pack.remove();
    }
  });

  it("names a check that only the object prototype has as missing", async () => {
    const pack = await shippedPack("fs", check);
    try {
      const g = treeGuardrail("fs:local/toString", pack.dir);
      await expect(conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], [])).rejects.toThrow("exports no toString. Next action: add toString to the default export");
    } finally {
      await pack.remove();
    }
  });

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
