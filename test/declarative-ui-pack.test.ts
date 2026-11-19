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
const config = [
  "warden: 0.1.0",
  "project: sample",
  "base: main",
  "packs:",
  "  - id: core",
  `    paths: ${code}`,
  "  - id: declarative-ui",
  `    paths: ${code}`,
  "tierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }",
  "loopBreakerRepeats: 3",
  "",
].join("\n");

const subscribing = [
  "import { useEffect, useState } from \"react\";",
  "import type { Observable } from \"rxjs\";",
  "export const useN = (n$: Observable<number>): number => {",
  "  const [n, setN] = useState(0);",
  "  useEffect(() => {",
  "    const s = n$.subscribe(setN);",
  "    return () => s.unsubscribe();",
  "  }, [n$]);",
  "  return n;",
  "};",
  "",
].join("\n");

const hook = (body: string): string =>
  ["import { useEffect, useState } from \"react\";", "export const useD = (n: number): number => {", "  const [d, setD] = useState(0);", body, "  return d;", "};", ""].join("\n");

let root: string;
let home: string;
let set: RecordSet;
let guardrails: Guardrail[];

const write = async (file: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), content);
};

const check = async (id: string, source: string, file = "src/ui/view.tsx") => {
  const gs = guardrails.filter((g) => g.id === id);
  expect(gs).toHaveLength(1);
  await write(file, source);
  const adapter = adapters.get(prefixOf(gs[0] as Guardrail)) as Adapter;
  for (const [path, content] of Object.entries(adapter.emit(gs, set))) await write(path, content);
  const [result] = await runGuardrails(set, gs, [file], { root, generatedDir: join(root, ".warden/generated") });
  return result;
};

const status = async (id: string, source: string, file?: string) => (await check(id, source, file))?.status;

const subscribeMessage = "A react-effect never subscribes. Read the observable with a bridge-hook such as useObservableState.";
const setMessage = "A react-effect never sets view-state directly. Compute the value while rendering, or with useMemo.";
const domMessage = "A view changes the DOM only by rendering. Render the markup or className from state.";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-declarative-ui-"));
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

describe("declarative-ui pack", () => {
  it("is consistent and its examples hold", async () => {
    expect(checkConsistency(set, await practicesElsewhere(set, wardenRoot))).toEqual([]);
    expect(await runExamples(set)).toEqual([]);
  });

  it.each([
    ["declarative-ui-subscribe-in-effect", "src/ui/bridges/useN.ts", subscribing],
    ["declarative-ui-set-in-effect", "src/ui/useD.ts", hook("  useEffect(() => {\n    const id = setInterval(() => setD(1), 10);\n    return () => clearInterval(id);\n  }, []);")],
    ["declarative-ui-set-in-effect", "src/ui/useD.ts", hook("  useEffect(() => {\n    setTimeout(() => undefined, 10);\n  }, []);")],
    ["declarative-ui-set-in-effect", "src/ui/useD.ts", hook("  useEffect(() => setInterval(() => undefined, 10), []);")],
    ["declarative-ui-set-in-effect", "src/ui/useD.ts", hook("  useEffect(() => {\n    setImmediate(() => undefined);\n  }, []);")],
    ["declarative-ui-dom-writes", "src/ui/useFocus.ts", "import { useEffect, useRef } from \"react\";\nexport const useFocus = () => {\n  const ref = useRef<HTMLInputElement>(null);\n  useEffect(() => {\n    ref.current?.focus();\n  }, []);\n  return ref;\n};\n"],
  ])("%s passes %s, case %#", async (id, file, source) => {
    expect(await status(id, source, file)).toBe("pass");
  });

  it.each([
    ["declarative-ui-subscribe-in-effect", "src/ui/useN.tsx", subscribing, subscribeMessage],
    ["declarative-ui-set-in-effect", "src/ui/useD.ts", hook("  useEffect(() => setD(1), []);"), setMessage],
    ["declarative-ui-set-in-effect", "src/ui/useD.ts", hook("  useEffect(() => {\n    setD(n * 2);\n  }, [n]);"), setMessage],
    ["declarative-ui-dom-writes", "src/ui/show.ts", "export const show = (el: HTMLElement, html: string): void => {\n  el.innerHTML = html;\n};\n", domMessage],
    ["declarative-ui-dom-writes", "src/ui/find.ts", "export const find = (): HTMLElement | null => document.getElementById(\"a\");\n", domMessage],
    ["declarative-ui-dom-writes", "src/ui/mark.ts", "export const mark = (el: HTMLElement): void => {\n  el.classList.add(\"on\");\n};\n", domMessage],
  ])("%s fails %s with its one next action, case %#", async (id, file, source, message) => {
    const result = await check(id, source, file);
    expect(result?.status).toBe("fail");
    expect(result?.violations.map((v) => v.message)).toEqual([message]);
  });

  it.each([
    ["declarative-ui-subscribe-in-effect", "import { useEffect } from \"react\";\nimport type { Observable } from \"rxjs\";\nconst start = (n$: Observable<number>) => {\n  const s = n$.subscribe();\n  return () => s.unsubscribe();\n};\nexport const useStart = (n$: Observable<number>): void => {\n  useEffect(() => start(n$), [n$]);\n};\n", "pass"],
    ["declarative-ui-subscribe-in-effect", "import type { Observable } from \"rxjs\";\nexport const useClick = (n$: Observable<number>) => () => {\n  const s = n$.subscribe();\n  s.unsubscribe();\n};\n", "pass"],
    ["declarative-ui-set-in-effect", hook("  useEffect(() => {\n    queueMicrotask(() => setD(n * 2));\n  }, [n]);"), "pass"],
    ["declarative-ui-dom-writes", "import { useEffect, useRef } from \"react\";\nexport const useMark = () => {\n  const ref = useRef<HTMLDivElement>(null);\n  useEffect(() => {\n    ref.current?.setAttribute(\"a\", \"b\");\n  }, []);\n  return ref;\n};\n", "pass"],
    ["declarative-ui-dom-writes", "export const mount = (node: Node): void => {\n  document.body.append(node);\n};\n", "pass"],
  ])("telemetry pins the escapes: %s on case %#", async (id, source, want) => {
    expect(await status(id, source)).toBe(want);
  });

  it.each([
    ["declarative-ui-subscribe-in-effect", "import React from \"react\";\nimport type { Observable } from \"rxjs\";\nexport const useN = (n$: Observable<number>, f: (n: number) => void): void => {\n  React.useEffect(() => {\n    const s = n$.subscribe(f);\n    return () => s.unsubscribe();\n  }, [n$, f]);\n};\n"],
    ["declarative-ui-subscribe-in-effect", "import { useEffect } from \"react\";\nimport type { Observable } from \"rxjs\";\nexport const useN = (n$: Observable<number>, f: (n: number) => void): void => {\n  useEffect(() => {\n    const s = n$[\"subscribe\"](f);\n    return () => s.unsubscribe();\n  }, [n$, f]);\n};\n"],
    ["declarative-ui-set-in-effect", hook("  useEffect(() => {\n    if (n > 0) setD(1);\n  }, [n]);")],
    ["declarative-ui-dom-writes", "export const find = (): Element | null => window.document.querySelector(\"a\");\n"],
    ["declarative-ui-dom-writes", "export const mark = (el: HTMLElement): void => {\n  el.className = \"x\";\n};\n"],
  ])("telemetry pins the known misses: %s on case %#", async (id, source) => {
    expect(await status(id, source)).toBe("pass");
  });
});
