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

let root: string;
let home: string;
let set: RecordSet;

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const configFile = (): string => join(root, ".warden", "config.yaml");

const load = async (packs: [string, string][]): Promise<RecordSet> => {
  await write(
    ".warden/config.yaml",
    [
      "warden: 0.1.0",
      "project: sample",
      "base: main",
      "packs:",
      ...packs.flatMap(([id, paths]) => [`  - id: ${id}`, `    paths: ${paths}`]),
      "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
      "loopBreakerRepeats: 3",
      "",
    ].join("\n"),
  );
  set = await loadRecords(root, wardenRoot);
  return set;
};

const consistency = async (s: RecordSet) => checkConsistency(s, await practicesElsewhere(s, wardenRoot));

const guardrail = (id: string): Guardrail => {
  const gs = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails)).filter((g) => g.id === id);
  expect(gs).toHaveLength(1);
  return gs[0] as Guardrail;
};

const check = async (id: string, source: string, file = "src/a.ts") => {
  const g = guardrail(id);
  await write(file, source);
  const adapter = adapters.get(prefixOf(g)) as Adapter;
  for (const [path, content] of Object.entries(adapter.emit([g], set))) await write(path, content);
  const [result] = await runGuardrails(set, [g], [file], { root, generatedDir: join(root, ".warden/generated") });
  return result?.status;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-signals-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  process.env.WARDEN_HOME = home;
});

afterEach(async () => {
  delete process.env.WARDEN_HOME;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("signals pack", () => {
  it("signals alone is consistent and its examples hold", async () => {
    const s = await load([["core", '["**/*.ts"]'], ["signals", '["src/**"]']]);
    expect(await consistency(s)).toEqual([]);
    expect(await runExamples(s)).toEqual([]);
  });

  it("rxjs-declarative alone is consistent", async () => {
    const s = await load([["core", '["**/*.ts"]'], ["rxjs-declarative", '["src/**"]']]);
    const elsewhere = await practicesElsewhere(s, wardenRoot);
    expect(elsewhere.get("signals-state-is-signal")).toBe("signals");
    expect(checkConsistency(s, elsewhere)).toEqual([]);
  });

  it("both packs on disjoint folders are consistent and their examples hold", async () => {
    const s = await load([["rxjs-declarative", '["src/rx/**"]'], ["signals", '["src/sig/**"]']]);
    expect(await consistency(s)).toEqual([]);
    expect(await runExamples(s)).toEqual([]);
  });

  it("both packs on nested folders are refused once, and the next action clears it", async () => {
    const s = await load([["rxjs-declarative", '["src/**"]'], ["signals", '["src/sig/**"]']]);
    expect(await consistency(s)).toEqual([
      {
        code: "conflict-overlap",
        record: "rxjs-state-is-observable",
        message: `Practices rxjs-state-is-observable and signals-state-is-signal conflict and both apply under src and src/sig. Next action: change the paths of pack signals in ${configFile()} so that no folder contains or is inside src, then run warden compile.`,
      },
    ]);
    expect(await consistency(await load([["rxjs-declarative", '["src/**"]'], ["signals", '["lib/sig/**"]']]))).toEqual([]);
  });

  it("a conflicting pack on a file glob is refused, and the next action clears it", async () => {
    const s = await load([["signals", '["**/*.ts"]']]);
    expect(await consistency(s)).toEqual([
      {
        code: "conflict-scope",
        record: "signals",
        message: `Pack signals has path **/*.ts in ${configFile()}, and Practice signals-state-is-signal conflicts with rxjs-state-is-observable, so its paths must be folder scopes. Next action: replace **/*.ts in the paths of pack signals in ${configFile()} with folder scopes such as src/ui/**, then run warden compile.`,
      },
    ]);
    expect(await consistency(await load([["signals", '["src/**"]']]))).toEqual([]);
  });

  it("each form's violation is the other form's compliant code", async () => {
    await load([["rxjs-declarative", '["src/**"]'], ["signals", '["src/**"]']]);
    const rx = guardrail("rxjs-no-signal-imports");
    const sig = guardrail("signals-no-subjects");
    expect([await check(rx.id, rx.mustFail as string), await check(sig.id, rx.mustFail as string)]).toEqual(["fail", "pass"]);
    expect([await check(sig.id, sig.mustFail as string), await check(rx.id, sig.mustFail as string)]).toEqual(["fail", "pass"]);
    for (const source of [rx.mustPass, sig.mustPass] as string[]) {
      expect([await check(rx.id, source), await check(sig.id, source)]).toEqual(["pass", "pass"]);
    }
  });

  it("telemetry pins the escape", async () => {
    await load([["signals", '["src/**"]']]);
    const source = "import { Observable } from \"rxjs\";\nexport const make = () => { const ls: (() => void)[] = []; return new Observable<number>(() => { ls.push(() => undefined); }); };\n";
    expect(await check("signals-no-subjects", source)).toBe("pass");
  });
});
