import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commandSources } from "../../src/compiler/command-sources.js";

it.each([
  ["python3 -c 'print(1)'", "python3", "check.py", "print(1)\n"],
  ["perl -e 'print 1'", "perl", "check.pl", "print 1;\n"],
  ["perl -E 'say 1'", "perl", "check.pl", "print 1;\n"],
  ["ruby -e 'puts 1'", "ruby", "check.rb", "puts 1\n"],
])("requires a traceable file in place of %s", (inline, interpreter, path, code) => {
  const root = mkdtempSync(join(tmpdir(), "warden-interpreter-"));
  const owner = { file: ".warden/packs/example/pack.yaml", id: "interpreter-check" };
  try {
    writeFileSync(join(root, path), code);
    const compileSources = (command: string) => commandSources(root, command, [], {}, owner);
    expect(() => compileSources(inline)).toThrow("cannot resolve to the files it runs");
    expect(compileSources(`${interpreter} ${path}`)).toEqual({ [`./${path}`]: code });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
