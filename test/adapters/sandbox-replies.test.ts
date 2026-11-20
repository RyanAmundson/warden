import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { PackEntry } from "../../src/adapters/pack-code.js";
import { inSandbox } from "../../src/adapters/sandbox.js";

it("keeps diagnostics separate from reads and results for queued pack jobs", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "warden-sandbox-replies-")));
  const file = join(dir, "fs.js");
  try {
    await writeFile(file, [
      'import { writeSync } from "node:fs";',
      "export default {",
      "  inspect: ({ file, read }) => {",
      '    writeSync(1, "Checking project input\\n");',
      "    const message = read(file);",
      '    console.log("Finished check");',
      "    return [{ file, message }];",
      "  },",
      "};",
    ].join("\n"));
    const entry: PackEntry = {
      file, real: file, name: "inspect", namespace: "local", guardrail: "inspect",
      implementation: "fs:local/inspect", packDir: dir, packFile: join(dir, "pack.yaml"), pointer: "/guardrails/inspect",
    };
    const reads: string[] = [];
    const check = (source: string): Promise<unknown> => inSandbox(entry, { kind: "tree", entry, input: { file: source } }, (name) => {
      reads.push(name);
      return `Found ${name}`;
    });
    const jobs = ["src/one.ts", "src/two.ts"];
    await expect(Promise.all(jobs.map(check))).resolves.toEqual(
      jobs.map((name) => ({ found: [{ file: name, message: `Found ${name}` }], ms: expect.any(Number) })),
    );
    expect(reads).toEqual(jobs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
