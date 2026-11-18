import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eslintAdapter } from "../src/adapters/eslint.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { runGuardrails } from "../src/runner/run.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const config = [
  "warden: 0.1.0",
  "project: sample",
  "base: main",
  "packs:",
  "  - id: core",
  "    paths: [\"**/*.ts\"]",
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

let root: string;
let set: RecordSet;
let guardrails: Guardrail[];

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const check = async (gs: Guardrail[], source: string) => {
  await write("src/a.ts", source);
  for (const [file, content] of Object.entries(eslintAdapter.emit(gs, set))) await write(file, content);
  return runGuardrails(gs, ["src/a.ts"], { root, generatedDir: join(root, ".warden/generated") });
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-core-"));
  await write(".warden/config.yaml", config);
  set = await loadRecords(root, wardenRoot);
  guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe("core pack", () => {
  it("core pack examples hold", async () => {
    expect(guardrails.map((g) => g.id)).toEqual(["warden-no-comments", "warden-no-suppressions"]);
    for (const g of guardrails) {
      const [failed] = await check([g], g.mustFail as string);
      expect(failed?.status, `${g.id} mustFail`).toBe("fail");
      for (const other of guardrails) {
        const [passed] = await check([other], g.mustPass as string);
        expect(passed?.status, `${other.id} on ${g.id} mustPass`).toBe("pass");
      }
    }
  });

  it("reports an inline suppression comment as a no-suppressions violation", async () => {
    const [result] = await check(guardrails.slice(1), "// eslint-disable-line\nconst a = 1;\n");
    expect(result?.status).toBe("fail");
    expect(result?.violations.map((v) => v.message)).toEqual([
      "no-suppressions: Source files carry no inline suppressions and no skipped tests.",
    ]);
  });
});
