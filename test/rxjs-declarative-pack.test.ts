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
const config = [
  "warden: 0.1.0",
  "project: sample",
  "base: main",
  "packs:",
  "  - id: core",
  "    paths: [\"src/**\"]",
  "  - id: rxjs-declarative",
  "    paths: [\"src/**\"]",
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

let root: string;
let home: string;
let set: RecordSet;
let guardrails: Guardrail[];

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const check = async (id: string, source: string, file = "src/a.ts") => {
  const gs = guardrails.filter((g) => g.id === id);
  expect(gs).toHaveLength(1);
  await write(file, source);
  const adapter = adapters.get(prefixOf(gs[0] as Guardrail)) as Adapter;
  for (const [path, content] of Object.entries(adapter.emit(gs, set))) await write(path, content);
  const [result] = await runGuardrails(set, gs, [file], { root, generatedDir: join(root, ".warden/generated") });
  return result?.status;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-rxjs-"));
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

describe("rxjs-declarative pack", () => {
  it("is consistent and its examples hold", async () => {
    expect(checkConsistency(set, await practicesElsewhere(set, wardenRoot))).toEqual([]);
    expect(await runExamples(set)).toEqual([]);
  });

  it.each([
    ["rxjs-no-signal-imports", "import { toSignal } from \"@angular/core/rxjs-interop\";\nexport const bridge = toSignal;\n", "pass"],
    ["rxjs-no-signal-imports", "import { signal } from \"@preact/signals-core\";\nexport const count = signal(0);\n", "fail"],
    ["rxjs-no-exposed-subjects", "import { Subject } from \"rxjs\";\nexport class A {\n  private readonly s = new Subject<number>();\n}\n", "pass"],
    ["rxjs-no-exposed-subjects", "import { Subject } from \"rxjs\";\nexport class A {\n  protected readonly s = new Subject<number>();\n}\n", "pass"],
    ["rxjs-no-exposed-subjects", "import { Subject } from \"rxjs\";\nexport class A {\n  readonly s = new Subject<number>();\n}\n", "fail"],
    ["rxjs-kept-subscriptions", "import { of } from \"rxjs\";\nof(1).subscribe();\n", "fail"],
    ["rxjs-kept-subscriptions", "import { of } from \"rxjs\";\nexport const start = () => {\n  return of(1).subscribe();\n};\n", "pass"],
    ["rxjs-relay", "import { Observable, of } from \"rxjs\";\nexport const s = of(1).subscribe((v) => new Observable<number>((subscriber) => subscriber.next(v)));\n", "pass"],
    ["rxjs-relay", "import { of, Subject } from \"rxjs\";\nexport class A {\n  #out = new Subject<number>();\n  readonly s = of(1).subscribe((v) => this.#out.next(v));\n}\n", "fail"],
    ["rxjs-relay", "import { of } from \"rxjs\";\nconst cache = new Map<number, number>();\nexport const s = of(1).subscribe((v) => cache.set(v, v));\n", "pass"],
  ])("%s, case %#", async (id, source, status) => {
    expect(await check(id, source)).toBe(status);
  });

  it.each([
    ["rxjs-no-signal-imports", "import { ref } from \"@vue/reactivity\";\nexport const n = ref(0);\n", "pass"],
    ["rxjs-no-exposed-subjects", "import { BehaviorSubject } from \"rxjs\";\nconst open$ = new BehaviorSubject(0);\nexport function getOpen() {\n  return open$;\n}\n", "pass"],
    ["rxjs-kept-subscriptions", "import { of } from \"rxjs\";\nconst _ = of(1).subscribe();\n", "pass"],
    ["rxjs-nested-subscribe", "import { of } from \"rxjs\";\nfunction inner() {\n  return of(2).subscribe();\n}\nexport const s = of(1).subscribe(() => inner());\n", "pass"],
    ["rxjs-relay", "import { of, Subject, tap } from \"rxjs\";\nconst out = new Subject<number>();\nexport const s = of(1).pipe(tap((v) => out.next(v))).subscribe();\n", "pass"],
    ["rxjs-relay", "import { of, Subject } from \"rxjs\";\nconst out = new Subject<number>();\nconst o = out;\nexport const s = of(1).subscribe((v) => o.next(v));\n", "pass"],
    ["rxjs-no-signal-imports", "import * as ng from \"@angular/core\";\nexport const n = ng.signal(0);\n", "pass"],
    ["rxjs-no-exposed-subjects", "import { Subject } from \"rxjs\";\nconst s = new Subject<number>();\nexport { s };\n", "pass"],
  ])("telemetry pins the escapes and displacements: %s on case %#", async (id, source, status) => {
    expect(await check(id, source)).toBe(status);
  });

  it.each([
    ["rxjs-relay", "import { BehaviorSubject, of } from \"rxjs\";\nexport const openDialogs = new BehaviorSubject<number[]>([]);\nexport const s = of(1).subscribe({\n  next: (state) => {\n    openDialogs.next([state]);\n  },\n});\n", "fail"],
    ["rxjs-relay", "import { of, Subject } from \"rxjs\";\nconst out = new Subject<number>();\nexport const s = of(1).subscribe({\n  next(v) {\n    out.next(v);\n  },\n});\n", "fail"],
    ["rxjs-nested-subscribe", "import { Observable, of } from \"rxjs\";\nconst src = of(1);\nexport const s = new Observable<number>((sub) => src.subscribe(sub)).subscribe();\n", "pass"],
    ["rxjs-nested-subscribe", "import { of } from \"rxjs\";\nexport const s = of(1).subscribe({\n  next: () => {\n    const t = of(2).subscribe();\n    t.unsubscribe();\n  },\n});\n", "fail"],
    ["rxjs-no-signal-imports", "import * as ng from \"@angular/core\";\nexport const C = ng.Component;\n", "pass"],
    ["rxjs-no-signal-imports", "import { computed as c } from \"@angular/core\";\nexport const n = c(() => 0);\n", "fail"],
    ["rxjs-no-signal-imports", "export { signal } from \"@angular/core\";\n", "fail"],
    ["rxjs-no-signal-imports", "export * from \"@preact/signals\";\n", "fail"],
    ["rxjs-no-exposed-subjects", "import { Subject } from \"rxjs\";\nexport default new Subject<number>();\n", "fail"],
    ["rxjs-no-exposed-subjects", "import { Subject } from \"rxjs\";\nexport const s = new Subject() as Subject<number>;\n", "fail"],
    ["rxjs-no-exposed-subjects", "import { Subject } from \"rxjs\";\nexport class A {\n  constructor(readonly s = new Subject<number>()) {}\n}\n", "fail"],
    ["rxjs-no-exposed-subjects", "import { Subject } from \"rxjs\";\nexport class A {\n  constructor(private readonly s = new Subject<number>()) {}\n}\n", "pass"],
    ["rxjs-kept-subscriptions", "import { of } from \"rxjs\";\nvoid of(1).subscribe();\n", "fail"],
    ["rxjs-kept-subscriptions", "import { Observable } from \"rxjs\";\nexport const start = (x?: Observable<number>): void => {\n  x?.subscribe();\n};\n", "fail"],
  ])("holds the reviewed form: %s, case %#", async (id, source, status) => {
    expect(await check(id, source)).toBe(status);
  });
});
