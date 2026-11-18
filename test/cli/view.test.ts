import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LEAVE, type ViewModel, liveView, plainLayers, plainView, render, renderLayers } from "../../src/cli/view.js";
import type { Evidence } from "../../src/runner/evidence.js";

const at = (time: string): string => `2026-11-18T${time}.000Z`;

const steps = (run: string, time: string, last: "done" | "fail" = "done"): Evidence[] => [
  { at: at(time), kind: "step", run, step: "rules-intact", state: "start", ms: 0, tier: "edit", trigger: "agent-edit" },
  { at: at(time), kind: "step", run, step: "rules-intact", state: "done", ms: 2 },
  { at: at(time), kind: "step", run, step: "tools-ready", state: "start", ms: 0 },
  { at: at(time), kind: "step", run, step: "tools-ready", state: "done", ms: 0, status: "cached" },
  { at: at(time), kind: "step", run, step: "rules", state: "start", ms: 0, tier: "edit", trigger: "agent-edit", files: 1, file: "src/hooks/useRx.ts", detail: "eslint", members: ["warden-no-comments", "warden-no-suppressions"] },
  { at: at(time), kind: "step", run, step: "rules", state: "done", ms: 8 },
  { at: at(time), kind: "step", run, step: "verdict", state: "start", ms: 0 },
  { at: at(time), kind: "step", run, step: "verdict", state: last, ms: 1 },
];

const passRun: Evidence = { at: at("14:01:40"), kind: "cost", guardrail: "run", run: "r1", tier: "commit", trigger: "git-commit", outcome: "ran", result: "pass", exit: 0, ms: 13, files: 3, bytes: 90, guardrails: 2, cached: 0, ratchet: [44175, 44174], rules: { "warden-no-comments": 3, "warden-no-suppressions": 3 }, passes: { eslint: 2 }, cachedRules: [], steps: { "rules-intact": 2, "tools-ready": 0, rules: 8, verdict: 1 } };
const blockRun: Evidence = {
  at: at("14:02:11"), kind: "cost", guardrail: "run", run: "r2", tier: "edit", trigger: "agent-edit", outcome: "ran", result: "fail", exit: 0, ms: 12, files: 1, file: "src/hooks/useRx.ts", bytes: 30, guardrails: 2, cached: 0, ratchet: [44174, 44174], rules: { "warden-no-comments": 3, "warden-no-suppressions": 3 }, passes: { eslint: 2 }, cachedRules: [], steps: { "rules-intact": 2, "tools-ready": 0, rules: 8, verdict: 1 },
  failures: [{ file: "src/hooks/useRx.ts", line: 2, guardrail: "warden-no-comments", practice: "no-comments" }],
  next: 'change the code at the lines above to match "Do this"',
};

const model = (evidence: Evidence[]): ViewModel => ({
  project: "context-manager",
  base: "origin/main",
  version: "9.8.7",
  packs: ["core"],
  tools: { eslint: "9.39.5", "typescript-eslint": "8.73.0", typescript: "5.9.3" },
  rules: [
    { guardrail: "warden-no-comments", strength: "proven", fired: 12, median: "4 ms", budgetMs: 2000 },
    { guardrail: "warden-no-suppressions", strength: "proven", fired: 1, median: "4 ms", budgetMs: 2000 },
  ],
  evidence,
  now: Date.parse(at("14:03:00")) + 500,
  budgets: { edit: 2000, commit: 10000, boundary: 120000 },
  layers: [],
  practices: [],
  packList: [{ id: "core", source: "bundled", on: true, rules: 2 }],
});

const size = { cols: 80, rows: 30 };

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const fits = (lines: string[]): void => {
  for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(80);
};

it("renders a passing run at 80 columns", () => {
  const lines = render(model([...steps("r1", "14:01:40"), passRun]), size, 0);
  fits(lines);
  expect(lines[0]).toMatch(/^ WARDEN {2}context-manager · base origin\/main · v9\.8\.7 +q quit {2}r rerun {2}l layers$/);
  expect(lines[1]).toBe("─".repeat(80));
  expect(lines[2]).toBe(" NOW  commit check · 3 files · triggered by git commit · 13 ms");
  expect(lines[3]).toMatch(/^ {3}✓ 1 rules intact {6}lock matches, 0 tampered files +2 ms$/);
  expect(lines[4]).toMatch(/^ {3}✓ 2 tools ready {7}eslint 9\.39\.5 · typescript 5\.9\.3 +cached$/);
  expect(lines[5]).toMatch(/^ {3}✓ 3 rules {13}warden-no-comments 3 ms +8 ms$/);
  expect(lines[6]).toBe(`${" ".repeat(25)}warden-no-suppressions 3 ms · eslint pass 2 ms`);
  expect(lines[7]).toMatch(/^ {3}✓ 4 verdict {11}pass +1 ms$/);
  expect(lines[8]).toMatch(/^ {5}setup and records +2 ms$/);
  expect(lines).toContainEqual(expect.stringMatching(/^ RULES \(core pack\) +strength +fired +median +budget$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ {3}warden-no-comments +proven +12 +4 ms +2000 ms$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ > 14:01:40 {2}commit {2}3 files +✓ pass +13 ms {2}2 rules$/));
  expect(lines.at(-2)).toBe("─".repeat(80));
  expect(lines.at(-1)).toBe(" The last run passed; nothing to do.");
});

it("renders a blocked run at 80 columns with its failure and one next action", () => {
  const lines = render(model([...steps("r1", "14:01:40"), passRun, ...steps("r2", "14:02:11", "fail"), blockRun]), size, 0);
  fits(lines);
  expect(lines[2]).toBe(" NOW  edit check · src/hooks/useRx.ts · triggered by agent edit · 12 ms");
  expect(lines[7]).toMatch(/^ {3}✗ 4 verdict {11}BLOCK {2}src\/hooks\/useRx\.ts:2 warden-no-comments +1 ms$/);
  expect(lines).toContainEqual(expect.stringMatching(/^ > 14:02:11 {2}edit {4}useRx\.ts +✗ BLOCK no-comments L2 +12 ms {2}2 rules$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ {3}14:01:40 {2}commit/));
  expect(lines.filter((l) => l.includes("Next action:"))).toEqual([' Next action: change the code at the lines above to match "Do this"']);
});

it("a selected run lists each step's time and each rule's time, and the parts add up to the run total", () => {
  const run: Evidence = { ...passRun, run: "r9", ms: 70, rules: { "warden-no-comments": 4, "warden-no-suppressions": 4 }, passes: { eslint: 57 }, steps: { "rules-intact": 2, "tools-ready": 0, rules: 65, verdict: 1 } };
  const events = steps("r9", "14:01:40").map((e) => (e.state === "start" ? e : { ...e, ms: run.steps?.[e.step as keyof typeof run.steps] ?? 0 }));
  const lines = render(model([...events, run]), size, 0);
  fits(lines);
  const ms = (line: string): number[] => [...line.matchAll(/(\d+) ms/g)].map((m) => Number(m[1]));
  const rulesAt = lines.findIndex((l) => l.startsWith("   ✓ 3 rules"));
  expect(lines[rulesAt]).toMatch(/warden-no-comments 4 ms +65 ms$/);
  expect(lines[rulesAt + 1]).toBe(`${" ".repeat(25)}warden-no-suppressions 4 ms · eslint pass 57 ms`);
  const parts = [...ms(lines[rulesAt] as string).slice(0, -1), ...ms(lines[rulesAt + 1] as string)];
  expect(parts.reduce((a, b) => a + b, 0)).toBe(65);
  const stepTotals = lines.filter((l) => /^ {3}✓ \d /.test(l)).map((l) => (l.endsWith("cached") ? 0 : (ms(l).at(-1) as number)));
  const setup = ms(lines.find((l) => l.startsWith("     setup and records")) as string)[0] as number;
  expect(stepTotals.reduce((a, b) => a + b, 0) + setup).toBe(70);
  expect(lines[2]).toMatch(/· 70 ms$/);
});

it("time in the rules step that no rule or pass accounts for is shown as loading and cache", () => {
  const run: Evidence = { ...passRun, run: "r8", rules: { "warden-no-comments": 1 }, passes: { eslint: 2 } };
  const lines = render(model([...steps("r8", "14:01:40"), run]), size, 0);
  expect(lines.join("\n").replace(/ +8 ms\n {25}/, " · ")).toContain("warden-no-comments 1 ms · eslint pass 2 ms · loading and cache 5 ms");
});

it("an old record says what it did not record, never a blank or a bare ran", () => {
  const old: Evidence = { at: at("14:15:13"), kind: "cost", guardrail: "run", run: "old", tier: "commit", outcome: "ran", ms: 650, files: 3, bytes: 9 };
  const lines = render(model([old]), size, 0);
  fits(lines);
  expect(lines[3]).toBe("   steps not recorded (older Warden) · total 650 ms");
  const row = lines.find((l) => l.startsWith(" > 14:15:13")) as string;
  expect(row).toBe(" > 14:15:13  -       3 files        ? result and rules not recorded · 650 ms");
  expect(row).not.toMatch(/\bran\b/);
});

it("wraps a long next action instead of cutting it", () => {
  const next = 'change the code at the lines above to match "Do this". Do not edit .warden/ or generated config; that is recorded as tampering';
  const lines = render(model([...steps("r2", "14:02:11", "fail"), { ...blockRun, next }]), size, 0);
  fits(lines);
  const footer = lines.slice(lines.lastIndexOf("─".repeat(80)) + 1);
  expect(footer.join("").replace(/\s+/g, " ")).toBe(` Next action: ${next}`);
});

it("renders the idle state when nothing has run", () => {
  const lines = render(model([]), size, 0);
  fits(lines);
  expect(lines[2]).toBe(" NOW  idle · no check has run in this project yet");
  expect(lines.slice(3, 7).every((l) => l.startsWith("   ○ "))).toBe(true);
  expect(lines.at(-1)).toBe(" Next action: press r to run warden check");
});

it("lights up the steps of a run still in progress", () => {
  const live = steps("r3", "14:03:00").slice(0, 5);
  const lines = render(model([...steps("r1", "14:01:40"), passRun, ...live]), size, 0);
  expect(lines[2]).toBe(" NOW  edit check · src/hooks/useRx.ts · triggered by agent edit");
  expect(lines[3]).toMatch(/^ {3}✓ 1 rules intact/);
  expect(lines[5]).toMatch(/^ {3}● 3 running rules {5}█+░+ {2}warden-no-comments/);
  expect(lines[6]).toBe("   ○ 4 verdict");
  expect(lines.at(-1)).toBe(" Running warden check…");
});

it("shows the selected run in NOW and marks it in RECENT RUNS", () => {
  const lines = render(model([...steps("r1", "14:01:40"), passRun, ...steps("r2", "14:02:11", "fail"), blockRun]), size, 1);
  expect(lines[2]).toBe(" NOW  commit check · 3 files · triggered by git commit · 13 ms");
  expect(lines).toContainEqual(expect.stringMatching(/^ > 14:01:40/));
  expect(lines).toContainEqual(expect.stringMatching(/^ {3}14:02:11/));
});

it("fits a narrow terminal and a short one", () => {
  const lines = render(model([...steps("r1", "14:01:40"), passRun]), { cols: 50, rows: 12 }, 0);
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(50);
  expect(lines.length).toBeLessThanOrEqual(12);
});

it("a run recorded without a result claims neither pass nor fail", () => {
  const { result: _result, ...old } = passRun;
  expect(render(model([old]), size, 0).at(-1)).toBe(" This run was recorded without a result.");
});

const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

it("shows control characters in a file name as visible escapes, and keeps other text raw", () => {
  const file = "q\x1b]0;PWNED\x07<b>\r.ts";
  const lines = render(model([{ ...blockRun, file, failures: [{ file, line: 2, guardrail: "warden-no-comments", practice: "no-comments" }] }]), size, 0);
  const text = lines.join("\n");
  expect(text).not.toMatch(CONTROL);
  expect(text).toContain("q\\u001b]0;PWNED\\u0007<b>\\u000d.ts");
  expect(text).not.toContain("&lt;");
});

it("the selected-run marker reads > in a plain render", () => {
  expect(plainView(model([...steps("r1", "14:01:40"), passRun]))).toContain("\n > 14:01:40  commit");
});

it("a run whose steps stopped without a record is interrupted, with one next action", () => {
  const stopped = steps("r3", "14:03:00").slice(0, 5);
  const lines = render({ ...model([...steps("r1", "14:01:40"), passRun, ...stopped]), now: Date.parse(at("14:03:00")) + 60_000 }, size, 0);
  expect(lines[2]).toBe(" NOW  edit check · src/hooks/useRx.ts · triggered by agent edit · interrupted");
  expect(lines[5]).toMatch(/^ {3}✗ 3 rules {13}warden-no-comments · warden-no-suppressions +interrupted$/);
  expect(lines[6]).toBe("   ○ 4 verdict");
  expect(lines.at(-1)).toBe(" Next action: press r to run warden check");
});

it("plain text carries no escape codes", () => {
  const text = plainView(model([...steps("r1", "14:01:40"), passRun]));
  expect(text).not.toContain("\x1b");
  expect(text).toContain(" NOW  commit check");
});

class FakeInput extends EventEmitter {
  raw: boolean[] = [];
  setRawMode(on: boolean): this {
    this.raw.push(on);
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

class FakeOutput extends EventEmitter {
  text = "";
  columns = 80;
  rows = 30;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "warden-view-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("q quits and restores the terminal; arrows select and r reruns", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const rerun = vi.fn();
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", rerun, load: () => Promise.resolve(model([...steps("r1", "14:01:40"), passRun, blockRun])) });
  await vi.waitFor(() => expect(output.text).toContain("NOW  edit check"));
  input.emit("data", Buffer.from("\x1b[B"));
  await vi.waitFor(() => expect(output.text.slice(output.text.lastIndexOf("NOW"))).toMatch(/^NOW {2}commit check/));
  input.emit("data", Buffer.from("r"));
  expect(rerun).toHaveBeenCalledTimes(1);
  input.emit("data", Buffer.from("q"));
  expect(await done).toBe(0);
  expect(output.text.endsWith(LEAVE)).toBe(true);
  expect(input.raw).toEqual([true, false]);
  expect(input.listenerCount("data")).toBe(0);
  expect(output.listenerCount("resize")).toBe(0);
});

it("Ctrl-C quits and restores the terminal", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", rerun: vi.fn(), load: () => Promise.resolve(model([])) });
  await vi.waitFor(() => expect(output.text).toContain("NOW  idle"));
  input.emit("data", Buffer.from("\x03"));
  expect(await done).toBe(0);
  expect(output.text.endsWith(LEAVE)).toBe(true);
});

it("an error restores the terminal and rejects", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", rerun: vi.fn(), load: () => Promise.reject(new Error("records broke")) });
  await expect(done).rejects.toThrow("records broke");
  expect(output.text.endsWith(LEAVE)).toBe(true);
  expect(input.raw).toEqual([true, false]);
});

it("drops a stale load and refreshes only for the project's Evidence file", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let release: (m: ViewModel) => void = () => undefined;
  const stale = new Promise<ViewModel>((r) => {
    release = r;
  });
  const load = vi.fn<() => Promise<ViewModel>>().mockReturnValueOnce(stale).mockResolvedValue(model([blockRun]));
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", rerun: vi.fn(), load });
  await writeFile(join(dir, "other.jsonl"), "x\n");
  await new Promise((r) => setTimeout(r, 50));
  expect(load).toHaveBeenCalledTimes(1);
  await writeFile(join(dir, "p.jsonl"), "x\n");
  await new Promise((r) => setTimeout(r, 50));
  expect(load).toHaveBeenCalledTimes(1);
  release(model([passRun]));
  await vi.waitFor(() => expect(output.text).toContain("NOW  edit check"));
  expect(output.text).not.toContain("NOW  commit check");
  expect(load).toHaveBeenCalledTimes(2);
  input.emit("data", Buffer.from("q"));
  await done;
});

it("redraws when the terminal is resized", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", rerun: vi.fn(), load: () => Promise.resolve(model([])) });
  await vi.waitFor(() => expect(output.text).toContain("NOW  idle"));
  output.columns = 60;
  output.emit("resize");
  expect(output.text).toContain(`${"─".repeat(60)}\n`);
  input.emit("data", Buffer.from("q"));
  await done;
});

const layered = (extra: Partial<ViewModel> = {}): ViewModel => ({
  ...model([]),
  version: "0.1.5",
  project: "warden",
  base: "main",
  layers: [
    { pack: "core", guardrail: "warden-no-comments", practice: "no-comments", kind: "lint", adapter: "eslint", runs: ["edit", "commit"], median: "4 ms" },
    { pack: "core", guardrail: "warden-no-suppressions", practice: "no-suppressions", kind: "lint", adapter: "eslint", runs: ["edit", "commit"], median: "4 ms" },
  ],
  practices: [
    { practice: "no-comments", strongestKind: "lint", promote: false },
    { practice: "no-suppressions", strongestKind: "lint", promote: false },
  ],
  packList: [
    { id: "core", source: "bundled", on: true, rules: 2 },
    { id: "architecture", source: "bundled", on: false, rules: 3 },
  ],
  ...extra,
});

it("renders the layers screen at 80 columns, strongest first, with every layer and the packs", () => {
  const lines = renderLayers(layered(), size);
  fits(lines);
  expect(lines[0]).toMatch(/^ WARDEN {2}warden · base main · v0\.1\.5 +q quit {2}l layers {2}↑↓ runs$/);
  expect(lines[2]).toMatch(/^ LAYERS {2}strongest first · a rule can only move up +rules {2}proven$/);
  expect(lines[3]).toMatch(/^ ┌ DETERMINISTIC ─+┐$/);
  expect(lines[4]).toMatch(/^ │ 0 type +compiler proves it +\(none yet\) +0 +│$/);
  expect(lines[5]).toMatch(/^ │ 0 lint +static analysis on every edit +2 +2\/2 │$/);
  expect(lines[6]).toMatch(/^ │ +core +warden-no-comments +eslint +edit,commit +4 ms +│$/);
  expect(lines[7]).toMatch(/^ │ +core +warden-no-suppressions +eslint +edit,commit +4 ms +│$/);
  expect(lines[8]).toMatch(/^ │ 1 runtime +a command or test must pass +\(none yet\) +0 +│$/);
  expect(lines[9]).toMatch(/^ └─+┘$/);
  expect(lines[10]).toMatch(/^ ┌ JUDGMENT ─+┐$/);
  expect(lines[11]).toMatch(/^ │ 2 model +a model decides +\(none yet\) +0 +│$/);
  expect(lines[12]).toMatch(/^ │ 3 review +a reviewer decides +\(none yet\) +0 +│$/);
  expect(lines[14]).toMatch(/^ ┌ PROSE ─+┐$/);
  expect(lines[15]).toMatch(/^ │ 4 instruction +told, not checked +\(none yet\) +0 +prose │$/);
  expect(lines[16]).toMatch(/^ │ 5 legacy +wrapped old check +\(none yet\) +0 +│$/);
  expect(lines[18]).toBe(" PACKS   ● core (bundled, 2 rules)   ○ architecture (bundled, off)   + local");
  expect(lines.at(-2)).toBe("─".repeat(80));
  expect(lines.at(-1)).toBe(" Weakest practice: none. Every practice is held by a deterministic rule.");
  expect(lines.every((l) => l.length === 0 || l.length <= 80)).toBe(true);
  expect(lines.filter((l) => l.startsWith(" │") || l.startsWith(" ┌") || l.startsWith(" └")).every((l) => l.length === 80)).toBe(true);
});

it("a practice held only by review shows promote, and the footer names it with one next action", () => {
  const lines = renderLayers(
    layered({
      layers: [{ pack: "local", guardrail: "local-review", practice: "small-files", kind: "review", adapter: "eslint", runs: ["commit"], median: "shared" }],
      practices: [{ practice: "small-files", strongestKind: "review", promote: true }],
      packList: [{ id: "local", source: "local", on: true, rules: 1 }],
    }),
    size,
  );
  fits(lines);
  expect(lines).toContainEqual(expect.stringMatching(/^ │ 3 review +a reviewer decides +1 +1\/1 │$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ │ +local +local-review +eslint +commit +shared +▲ promote +│$/));
  expect(lines).toContainEqual(" PACKS   ● local (local, 1 rule)   + local");
  expect(lines.slice(lines.lastIndexOf("─".repeat(80)) + 1).join("")).toBe(" Weakest practice: small-files, held only by review. Next action: add a type, lint, or runtime Guardrail to small-files");
});

it("plain layers carry no escape codes", () => {
  const text = plainLayers(layered());
  expect(text).not.toContain("\x1b");
  expect(text).toContain(" LAYERS  ");
});

it("l toggles between the runs screen and the layers screen", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", rerun: vi.fn(), load: () => Promise.resolve(layered()) });
  await vi.waitFor(() => expect(output.text).toContain("NOW  idle"));
  input.emit("data", Buffer.from("l"));
  expect(output.text.slice(output.text.lastIndexOf("\x1b[H"))).toContain(" LAYERS  ");
  input.emit("data", Buffer.from("l"));
  expect(output.text.slice(output.text.lastIndexOf("\x1b[H"))).toContain(" NOW  idle");
  input.emit("data", Buffer.from("q"));
  expect(await done).toBe(0);
});
