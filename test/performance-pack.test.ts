import { Linter, type Rule } from "eslint";
import { describe, expect, it } from "vitest";

const { default: rules }: { default: Record<string, Rule.RuleModule> } =
  await import(new URL("../packs/performance/eslint.js", import.meta.url).href);

const lint = (code: string) => new Linter().verify(code, [{
  languageOptions: { globals: { require: "readonly" } },
  plugins: { performance: { rules } },
  rules: { "performance/blocking-node-calls": "error" },
}]);

describe("performance-blocking-node-calls", () => {
  it.each([
    ['import { execFileSync as git } from "child_process"; git("git");', "execFileSync"],
    ['import * as child from "node:child_process"; child.spawnSync("git");', "spawnSync"],
    ['import fs from "node:fs"; fs.fsyncSync(7);', "fsyncSync"],
    ['import * as fs from "fs"; fs["writeFileSync"]("file", "data");', "writeFileSync"],
    ['const fs = require("fs"); fs.fdatasyncSync(7);', "fdatasyncSync"],
    ['const { fsyncSync: flush } = require("node:fs"); flush(7);', "fsyncSync"],
    ['require("child_process").execSync("git status");', "execSync"],
  ])("reports the actual Node call in %s", (source, method) => {
    expect(lint(source)).toMatchObject([{ message: expect.stringContaining(`${method} blocks the calling thread`) }]);
  });

  it.each([
    'import { execFile } from "node:child_process"; execFile("git");',
    'import fs from "node:fs/promises"; await fs.writeFile("file", "data");',
    'import fs from "node:fs"; await fs.promises.writeFile("file", "data");',
    'import { execFileSync as git } from "node:child_process"; const cache = { git };',
    'import { execFileSync } from "./mock.js"; execFileSync("git");',
    'import fs from "node:fs"; function run(fs) { fs.fsyncSync(7); }',
    'function run(require) { require("node:fs").fsyncSync(7); }',
    'require(7).fsyncSync(8);',
  ])("leaves unrelated or asynchronous calls alone in %s", (source) => {
    expect(lint(source)).toEqual([]);
  });
});
