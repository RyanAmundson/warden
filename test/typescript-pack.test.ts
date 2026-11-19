import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { practicesElsewhere } from "../src/compiler/compile.js";
import { checkConsistency } from "../src/compiler/consistency.js";
import { runExamples } from "../src/compiler/examples.js";
import type { Adapter } from "../src/adapters/types.js";
import { loadRecords } from "../src/records/load.js";
import type { Guardrail, RecordSet } from "../src/records/types.js";
import { adapters, prefixOf, runGuardrails } from "../src/runner/run.js";

const wardenRoot = resolve(import.meta.dirname, "..");
const code = "[\"**/*.{ts,tsx,mts,cts,js,mjs,cjs}\"]";
const config = ["warden: 0.1.0", "project: sample", "base: main", "packs:", "  - id: core", `    paths: ${code}`, "  - id: typescript", `    paths: ${code}`, "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }", "loopBreakerRepeats: 3", ""].join("\n");

let root: string;
let home: string;
let set: RecordSet;
let guardrails: Guardrail[];

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const lint = async (id: string, file: string, source: string) => {
  const gs = guardrails.filter((g) => g.id === id);
  await write(file, source);
  const adapter = adapters.get(prefixOf(gs[0] as Guardrail)) as Adapter;
  for (const [path, content] of Object.entries(adapter.emit(gs, set))) await write(path, content);
  const [result] = await runGuardrails(set, gs, [file], { root, generatedDir: join(root, ".warden/generated") });
  return result;
};

const messagesOf = (id: string): string[] => ((guardrails.find((g) => g.id === id)?.options ?? []) as { message: string }[]).map((o) => o.message);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-typescript-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  process.env.WARDEN_HOME = home;
  await write(".warden/config.yaml", config);
  set = await loadRecords(root, wardenRoot);
  guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
});

afterEach(async () => {
  delete process.env.WARDEN_HOME;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("typescript pack", () => {
  it("is consistent and its examples hold", async () => {
    expect(checkConsistency(set, await practicesElsewhere(set, wardenRoot))).toEqual([]);
    expect(await runExamples(set)).toEqual([]);
  });

  it.each([
    ["typescript-no-assertion", "src/a.ts", "export const x = [1, 2] as const;\n", "pass"],
    ["typescript-no-assertion", "src/a.ts", "type T = { a: number };\nexport const x = { a: 1 } satisfies T;\n", "pass"],
    ["typescript-no-assertion", "src/a.ts", "export const n = (v: unknown): number => <number>v;\n", "fail"],
    ["typescript-no-assertion", "src/a.ts", "export const n = (v: unknown): number => v as number;\n", "fail"],
    ["typescript-no-assertion", "src/a.test.ts", "export const n = (v: unknown): number => v as number;\n", "pass"],
    ["typescript-no-assertion", "test/a.ts", "export const n = (v: unknown): number => v as number;\n", "pass"],
  ])("%s on %s: %j is %s", async (id, file, source, status) => {
    const result = await lint(id, file, source);
    expect(result?.status).toBe(status);
    expect(result?.violations.map((v) => v.message)).toEqual(status === "fail" ? [messagesOf(id)[0]] : []);
  });

  it.each([
    ["typescript-no-any", "export const f = (g: Function): unknown => g;\n", "pass"],
    ["typescript-no-assertion", "export const f = (v: unknown): number => v as number;\n", "fail"],
    ["typescript-no-assertion", "export const f = (s: string | undefined): string => s as string;\n", "fail"],
    ["typescript-no-non-null", "export const f = (s: string | undefined): string => { if (!s) throw new Error(\"s\"); return s; };\n", "pass"],
    ["typescript-no-assertion", "declare const cast: <T>(v: unknown) => T;\nexport const n = cast<number>(1);\n", "pass"],
  ])("telemetry pins the escapes and displacements: %s on %j is %s", async (id, source, status) => {
    const result = await lint(id, "src/a.ts", source);
    expect(result?.status).toBe(status);
    expect(result?.violations.map((v) => v.message)).toEqual(status === "fail" ? [messagesOf(id)[0]] : []);
  });
});
