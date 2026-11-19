import { existsSync } from "node:fs";
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

  it.each([
    ["a require of Thumbs.db", { "fs.js": "module.exports = require(\"./Thumbs.db\");\n", "Thumbs.db": "module.exports = {};\n" }],
    ["a require of thumbs.db in other case", { "fs.js": "module.exports = require(\"./thumbs.db\");\n", "Thumbs.db": "module.exports = {};\n" }],
    ["a string literal naming desktop.ini", { "fs.js": "const f = \"desktop.ini\";\nexport default {};\n" }],
    ["a string literal naming a junk path in other case", { "fs.js": "const f = \"data/.DS_STORE\";\nexport default {};\n" }],
  ])("refuses pack code with %s, because the lock does not hash OS junk", async (_name, files) => {
    const pack = await shippedPack("fs", "");
    try {
      for (const [file, code] of Object.entries(files)) await writeFile(join(pack.dir, file), code);
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      await expect(conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], [])).rejects.toThrow("OS junk file that the lock does not hash. Next action: rename the file to a name that is not OS junk, and point the code at the new name, then run warden compile.");
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

  it.each([
    ["a computed getBuiltinModule name that runs child_process", { "fs.js": "export default { mentions: () => { process[\"getBuiltin\" + \"Module\"](\"node:child_process\").execFileSync(\"touch\", [MARK]); return []; } };\n" }],
    ["CommonJS arguments[1], the module wrapper's require", { "fs.js": "const r = arguments[1];\nr(\"node:fs\").writeFileSync(MARK, \"x\");\nmodule.exports = { mentions: () => [] };\n" }],
    ["Reflect.get of getBuiltinModule", { "fs.js": "export default { mentions: () => { Reflect.get(process, \"getBuiltinModule\")(\"node:fs\").writeFileSync(MARK, \"x\"); return []; } };\n" }],
    ["a computed destructuring key", { "fs.js": "const { [\"getBuiltinModule\"]: g } = process;\ng(\"node:fs\").writeFileSync(MARK, \"x\");\nexport default { mentions: () => [] };\n" }],
    ["a property descriptor of getBuiltinModule", { "fs.js": "Object.getOwnPropertyDescriptor(process, \"getBuiltinModule\").value(\"node:child_process\").execFileSync(\"touch\", [MARK]);\nexport default { mentions: () => [] };\n" }],
    ["node:fs", { "fs.js": "import { writeFileSync } from \"node:fs\";\nwriteFileSync(MARK, \"x\");\nexport default { mentions: () => [] };\n" }],
    ["createRequire of a file outside the pack", { "fs.js": "import { createRequire } from \"node:module\";\nexport default createRequire(import.meta.url)(\"../impl.cjs\");\n" }],
    ["node:vm", { "fs.js": "import vm from \"node:vm\";\nvm.runInThisContext(`process.getBuiltinModule(\"node:fs\").writeFileSync(${JSON.stringify(MARK)}, \"x\")`);\nexport default { mentions: () => [] };\n" }],
    ["node:inspector", { "fs.js": "import { Session } from \"node:inspector\";\nconst s = new Session();\ns.connect();\ns.post(\"Runtime.evaluate\", { expression: `process.getBuiltinModule(\"node:fs\").writeFileSync(${JSON.stringify(MARK)}, \"x\")` });\nexport default { mentions: () => [] };\n" }],
    ["node:cluster", { "fs.js": "import cluster from \"node:cluster\";\ncluster.setupPrimary({ exec: new URL(\"../impl.cjs\", import.meta.url).pathname });\ncluster.fork();\nexport default { mentions: () => [] };\n" }],
    ["node:worker_threads", { "fs.js": "import { Worker } from \"node:worker_threads\";\nnew Worker(`require(\"node:fs\").writeFileSync(${JSON.stringify(MARK)}, \"x\")`, { eval: true });\nexport default { mentions: () => [] };\n" }],
    ["node:net", { "fs.js": "import net from \"node:net\";\nawait new Promise((resolve, reject) => net.connect(9, \"127.0.0.1\").on(\"error\", reject).on(\"connect\", resolve));\nexport default { mentions: () => [] };\n" }],
  ])("runs pack code with %s in a sandbox that refuses it, with one next action", async (_name, files) => {
    const pack = await shippedPack("fs", "");
    const marker = join(pack.dir, "../marker");
    try {
      await writeFile(join(pack.dir, "../impl.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");\nmodule.exports = { mentions: () => [] };\n`);
      for (const [file, code] of Object.entries(files)) await writeFile(join(pack.dir, file), `const MARK = ${JSON.stringify(marker)};\n${code}`);
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      const refusal = conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], []);
      await expect(refusal).rejects.toThrow("Access to this API has been restricted");
      await expect(refusal).rejects.toThrow(/Next action: [^]*, then run warden compile\.$/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await pack.remove();
    }
  });

  it.each([
    ["does not parse", "export default { mentions: () => [ };\n", "does not load: "],
    ["throws", "export default { mentions: () => { throw new TypeError(\"boom\"); } };\n", "Guardrail g: fs:local/mentions in PACK/fs.js threw: boom. Next action: fix mentions in PACK/fs.js, then run warden compile."],
    ["returns no list", "export default { mentions: () => undefined };\n", "Guardrail g: fs:local/mentions in PACK/fs.js returned undefined that is not a finding of the form { file, message, line?, endLine?, doThis? }. Next action: fix mentions in PACK/fs.js, then run warden compile."],
    ["reads a file it was not given", "export default { mentions: ({ read }) => [{ file: \"src/a.ts\", message: read(\"../../etc/hosts\") }] };\n", "threw: ../../etc/hosts is not one of the files the check was given"],
    ["returns a malformed finding", "export default { mentions: () => [{ file: 1 }] };\n", "returned a list with an item that is not a finding"],
    ["returns an endLine before its line", "export default { mentions: () => [{ file: \"src/a.ts\", line: 5, endLine: 2, message: \"m\" }] };\n", "returned a list with an item that is not a finding"],
    ["returns an endLine without a line", "export default { mentions: () => [{ file: \"src/a.ts\", endLine: 2, message: \"m\" }] };\n", "returned a list with an item that is not a finding"],
    ["returns a fractional line", "export default { mentions: () => [{ file: \"src/a.ts\", line: 1.5, message: \"m\" }] };\n", "returned a list with an item that is not a finding"],
  ])("names the pack file and the Guardrail, with one next action, when a pack check %s", async (_name, code, message) => {
    const pack = await shippedPack("fs", code);
    try {
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      const refusal = conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], []);
      await expect(refusal).rejects.toMatchObject({ name: "RecordError", file: join(pack.dir, "pack.yaml"), pointer: "/guardrails/g/implementation" });
      await expect(refusal).rejects.toThrow(message.replaceAll("PACK", pack.dir));
      await expect(refusal).rejects.toThrow(/Next action: [^]*, then run warden compile\.$/);
    } finally {
      await pack.remove();
    }
  });

  it.each([
    ["writes a database through node:sqlite", "const { DatabaseSync } = process.getBuiltinModule(\"node:sqlite\");\nnew DatabaseSync(MARK).exec(\"create table t (v)\");\nexport default { mentions: () => [] };\n"],
    ["imports node:sqlite to write a database", "import { DatabaseSync } from \"node:sqlite\";\nnew DatabaseSync(MARK).exec(\"create table t (v)\");\nexport default { mentions: () => [] };\n"],
    ["reads another database through node:sqlite", "const { DatabaseSync } = process.getBuiltinModule(\"node:sqlite\");\nconst secret = new DatabaseSync(VICTIM).prepare(\"select v from t\").get().v;\nexport default { mentions: () => [{ file: \"src/a.ts\", message: secret }] };\n"],
  ])("runs pack code that %s in a sandbox without node:sqlite", async (_name, code) => {
    const pack = await shippedPack("fs", "");
    const marker = join(pack.dir, "../marker.db");
    const victim = join(pack.dir, "../victim.db");
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(victim);
      db.exec("create table t (v); insert into t values ('hunter2')");
      db.close();
      await writeFile(join(pack.dir, "fs.js"), `const MARK = ${JSON.stringify(marker)};\nconst VICTIM = ${JSON.stringify(victim)};\n${code}`);
      const g = treeGuardrail("fs:local/mentions", pack.dir);
      const refusal = conformance(fsAdapter, fixture, [g], treeSet(g), ["src/a.ts"], []);
      await expect(refusal).rejects.toThrow(/Next action: [^]*, then run warden compile\.$/);
      await expect(refusal).rejects.not.toThrow("hunter2");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await pack.remove();
    }
  });

  it("runs each pack in its own sandbox, so one pack's code cannot change another pack's results", async () => {
    const pack = await shippedPack("fs", check);
    const evilDir = join(dirname(pack.dir), "evil");
    try {
      await mkdir(evilDir);
      await writeFile(join(evilDir, "fs.js"), "const stringify = JSON.stringify;\nJSON.stringify = (value, ...rest) => stringify(value?.done?.found === undefined ? value : { done: { found: [], ms: 0 } }, ...rest);\nexport default { quiet: () => [] };\n");
      const local = treeGuardrail("fs:local/mentions", pack.dir);
      const evil = { ...treeGuardrail("fs:evil/quiet", evilDir), id: "e" };
      const set = treeSet(local);
      set.config.packs.push({ id: "evil", paths: ["src/**"] });
      set.packs.push({ id: "evil", file: "pack.yaml", layer: 0, terms: [], practices: [{ id: "y", pack: "evil", statement: "s", terms: [], paths: ["**/*.ts"], conflictsWith: [], guardrails: [evil] }] });
      const found = [
        { guardrail: "g", file: "src/a.ts", line: 1, message: "src/a.ts names b with 1 term", doThis: "Rename it." },
        { guardrail: "g", file: "src/b.ts", line: 1, message: "src/b.ts names b with 1 term", doThis: "Rename it." },
      ];
      await conformance(fsAdapter, fixture, [local, evil], set, ["src/a.ts", "src/b.ts"], found);
      await conformance(fsAdapter, fixture, [evil, local], set, ["src/a.ts", "src/b.ts"], found);
      await conformance(fsAdapter, fixture, [local], set, ["src/a.ts", "src/b.ts"], found);
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
