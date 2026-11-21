import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import type { Adapter, Violation } from "../../src/adapters/types.js";
import type { Guardrail, RecordSet } from "../../src/records/types.js";

export async function conformance(
  adapter: Adapter,
  fixtureDir: string,
  gs: Guardrail[],
  set: RecordSet,
  files: string[],
  expected: Violation[],
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "warden-conformance-"));
  try {
    await cp(fixtureDir, root, { recursive: true });
    const emitted = adapter.emit(gs, { ...set, root });
    for (const [path, content] of Object.entries(emitted)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const results = await adapter.run(gs, files, { root, generatedDir: join(root, ".warden/generated") });
    expect(results.flatMap((r) => r.violations)).toEqual(expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
