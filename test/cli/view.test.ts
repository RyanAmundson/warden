import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LEAVE, type ViewModel, liveView, plainDeterminism, plainLayers, plainView, plainViolations, render, renderDeterminism, renderLayers, renderViolations } from "../../src/cli/view.js";
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
    { guardrail: "warden-no-comments", strength: "proven", fired: 12, median: "4 ms", budgetMs: 2000, baselined: 0 },
    { guardrail: "warden-no-suppressions", strength: "proven", fired: 1, median: "4 ms", budgetMs: 2000, baselined: 0 },
  ],
  evidence,
  now: Date.parse(at("14:03:00")) + 500,
  layers: [],
  practices: [],
  packList: [{ id: "core", source: "bundled", on: true, rules: 2 }],
  projects: [],
});

const size = { cols: 80, rows: 30 };

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const rulesBlock = (lines: string[]): string => {
  const at = lines.findIndex((l) => /^ {3}. 3 rules/.test(l));
  const end = lines.findIndex((l, i) => i > at && !l.startsWith(" ".repeat(25)));
  return [(lines[at] as string).slice(25).replace(/ +\S+ ms$/, ""), ...lines.slice(at + 1, end).map((l) => l.trim())].join(" · ");
};

const fits = (lines: string[]): void => {
  for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(80);
};

it("renders a passing run at 80 columns", () => {
  const lines = render(model([...steps("r1", "14:01:40"), passRun]), size, 0);
  fits(lines);
  expect(lines[0]).toBe(" WARDEN  context-manager… q quit  r rerun  l layers  v violations  d determinism");
  expect(lines[1]).toBe("─".repeat(80));
  expect(lines[2]).toBe(" NOW  commit check · 3 files · triggered by git commit · 13 ms");
  expect(lines[3]).toMatch(/^ {3}✓ 1 rules intact {6}lock matches, 0 tampered files +2\.0 ms$/);
  expect(lines[4]).toMatch(/^ {3}✓ 2 tools ready {7}eslint 9\.39\.5 · typescript 5\.9\.3 +cached$/);
  expect(lines[5]).toMatch(/^ {3}✓ 3 rules {13}warden-no-comments 3\.0 ms +8\.0 ms$/);
  expect(lines[6]).toBe(`${" ".repeat(25)}warden-no-suppressions 3.0 ms`);
  expect(lines[7]).toBe(`${" ".repeat(25)}eslint pass 2.0 ms`);
  expect(lines[8]).toMatch(/^ {3}✓ 4 verdict {11}pass +1\.0 ms$/);
  expect(lines[9]).toMatch(/^ {5}setup and records +2\.0 ms$/);
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
  expect(lines[8]).toMatch(/^ {3}✗ 4 verdict {11}BLOCK {2}src\/hooks\/useRx\.ts:2 warden-no-comments +1\.0 ms$/);
  expect(lines).toContainEqual(expect.stringMatching(/^ > 14:02:11 {2}edit {4}useRx\.ts +✗ BLOCK no-comments L2 +12 ms {2}2 rules$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ {3}14:01:40 {2}commit/));
  expect(lines.filter((l) => l.includes("Next action:"))).toEqual([' Next action: change the code at the lines above to match "Do this"']);
});

it("a selected run lists each step's time and each rule's time, and the parts add up to the run total", () => {
  const run: Evidence = { ...passRun, run: "r9", ms: 70, rules: { "warden-no-comments": 4, "warden-no-suppressions": 4 }, passes: { eslint: 57 }, steps: { "rules-intact": 2, "tools-ready": 0, rules: 65, verdict: 1 } };
  const events = steps("r9", "14:01:40").map((e) => (e.state === "start" ? e : { ...e, ms: run.steps?.[e.step as keyof typeof run.steps] ?? 0 }));
  const lines = render(model([...events, run]), size, 0);
  fits(lines);
  const ms = (line: string): number[] => [...line.matchAll(/([\d.]+) ms/g)].map((m) => Number(m[1]));
  expect(lines.find((l) => l.startsWith("   ✓ 3 rules"))).toMatch(/ 65 ms$/);
  const block = rulesBlock(lines);
  expect(block).toBe("warden-no-comments 4.0 ms · warden-no-suppressions 4.0 ms · eslint pass 57 ms");
  const parts = [...block.matchAll(/([\d.]+) ms/g)].map((m) => Number(m[1]));
  expect(parts.reduce((a, b) => a + b, 0)).toBe(65);
  const stepTotals = lines.filter((l) => /^ {3}✓ \d /.test(l)).map((l) => (l.endsWith("cached") ? 0 : (ms(l).at(-1) as number)));
  const setup = ms(lines.find((l) => l.startsWith("     setup and records")) as string)[0] as number;
  expect(stepTotals.reduce((a, b) => a + b, 0) + setup).toBe(70);
  expect(lines[2]).toMatch(/· 70 ms$/);
});

it("time in the rules step that no rule or pass accounts for is shown as loading and cache", () => {
  const run: Evidence = { ...passRun, run: "r8", rules: { "warden-no-comments": 1 }, passes: { eslint: 2 } };
  const lines = render(model([...steps("r8", "14:01:40"), run]), size, 0);
  expect(rulesBlock(lines)).toBe("warden-no-comments 1.0 ms · eslint pass 2.0 ms · loading and cache 5.0 ms");
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

it("a step-only run stays live until its rules' kill timeout, past the tier budget", () => {
  const slow = steps("r3", "14:03:00").slice(0, 5);
  const lines = render({ ...model([...steps("r1", "14:01:40"), passRun, ...slow]), now: Date.parse(at("14:03:00")) + 3_000 }, size, 0);
  expect(lines[2]).toBe(" NOW  edit check · src/hooks/useRx.ts · triggered by agent edit");
  expect(lines.at(-1)).toBe(" Running warden check…");
});

it("a wide terminal still shows control characters as visible escapes on every line", () => {
  const file = "q\x1b]0;PWNED\x07\r\x1b[2K.ts";
  const hostile: Evidence = { ...blockRun, file, failures: [{ file, line: 2, guardrail: "warden-no-comments", practice: "no-comments" }] };
  for (const cols of [120, 200]) {
    const lines = render(model([...steps("r2", "14:02:11", "fail"), hostile]), { cols, rows: 30 }, 0);
    expect(lines.join("\n")).not.toMatch(CONTROL);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(cols);
    expect(lines).toContainEqual(expect.stringMatching(/44,174 → 44,174$/));
  }
  const layers = renderLayers({ ...model([]), layers: [{ pack: "lo\x1bcal", guardrail: "g\r", practice: "p", kind: "lint", adapter: "eslint", runs: ["edit"], median: "1.0 ms" }] }, { cols: 120, rows: 40 });
  expect(layers.join("\n")).not.toMatch(CONTROL);
});

it("a tampered run says no rules ran, and an error that stopped before any step says so, not older Warden", () => {
  const tampered: Evidence = { at: at("14:04:00"), kind: "cost", guardrail: "run", run: "t", tier: "commit", trigger: "manual", outcome: "tampered", exit: 1, ms: 30, files: 0, bytes: 0, steps: { "rules-intact": 20 }, next: "revert your change to .warden/lock.json" };
  const errored: Evidence = { at: at("14:05:00"), kind: "cost", guardrail: "run", run: "e", tier: "commit", trigger: "manual", outcome: "error", exit: 2, ms: 12, files: 0, bytes: 0, steps: {}, next: "run warden check --base main" };
  const events: Evidence[] = [
    { at: at("14:04:00"), kind: "step", run: "t", step: "rules-intact", state: "start", ms: 0, tier: "commit", trigger: "manual" },
    { at: at("14:04:00"), kind: "step", run: "t", step: "rules-intact", state: "fail", ms: 20 },
  ];
  const lines = render(model([...events, tampered, errored]), size, 0);
  fits(lines);
  const text = lines.join("\n");
  expect(text).not.toContain("older Warden");
  expect(lines[3]).toBe("   stopped before the first step · total 12 ms");
  expect(lines).toContainEqual(expect.stringMatching(/^ > 14:05:00 {2}manual {2}0 files +✗ error · no rules ran: error · 12 ms$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ {3}14:04:00 {2}manual {2}0 files +✗ TAMPERED · no rules ran: tampered · 30 ms$/));
  const older = render(model([...events, tampered, errored]), size, 1);
  expect(older.join("\n")).not.toContain("older Warden");
});

it("times under 10 ms show one decimal, so the parts visibly add up", () => {
  const run: Evidence = { ...passRun, run: "r7", ms: 9.9, rules: { "warden-no-comments": 1.2, "warden-no-suppressions": 1.3 }, passes: { eslint: 2.5 }, steps: { "rules-intact": 2, "tools-ready": 0, rules: 5, verdict: 1 } };
  const events = steps("r7", "14:01:40").map((e) => (e.step === "rules" && e.state === "done" ? { ...e, ms: 5 } : e));
  const lines = render(model([...events, run]), size, 0);
  expect(rulesBlock(lines)).toBe("warden-no-comments 1.2 ms · warden-no-suppressions 1.3 ms · eslint pass 2.5 ms");
  expect(lines[2]).toMatch(/· 9\.9 ms$/);
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
  expect(lines[0]).toMatch(/^ WARDEN {2}warden · base mai… q quit {2}r rerun {2}l runs {2}v violations {2}d determinism$/);
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

const counted: Evidence = {
  ...passRun,
  at: at("16:13:20"),
  run: "v1",
  result: "fail",
  rules: { "warden-no-comments": 3, "principles-small-files": 2, "architecture-layers": 1 },
  cachedRules: ["warden-no-suppressions"],
  failures: [
    { file: "src/a.ts", line: 2, guardrail: "warden-no-comments", practice: "no-comments" },
    { file: "src/b.ts", line: 4, guardrail: "warden-no-suppressions", practice: "no-suppressions" },
  ],
  next: 'change the code at the lines above to match "Do this"',
};

const violated = (evidence: Evidence[] = [counted], baselined: Record<string, number> = { "warden-no-comments": 29923, "warden-no-suppressions": 191, "principles-small-files": 8402 }): ViewModel => ({
  ...model(evidence),
  packs: ["core", "principles", "architecture"],
  rules: ["warden-no-comments", "warden-no-suppressions", "principles-small-files", "architecture-layers"].map((guardrail) => ({ guardrail, strength: "proven", fired: 0, median: "4 ms", budgetMs: 2000, baselined: baselined[guardrail] ?? 0 })),
  layers: [
    { pack: "core", guardrail: "warden-no-comments", practice: "no-comments", kind: "lint", adapter: "eslint", runs: ["edit", "commit"], median: "4 ms" },
    { pack: "core", guardrail: "warden-no-suppressions", practice: "no-suppressions", kind: "lint", adapter: "eslint", runs: ["edit", "commit"], median: "4 ms" },
    { pack: "principles", guardrail: "principles-small-files", practice: "small-files", kind: "lint", adapter: "eslint", runs: ["commit"], median: "4 ms" },
    { pack: "architecture", guardrail: "architecture-layers", practice: "layers", kind: "lint", adapter: "eslint", runs: ["commit"], median: "4 ms" },
  ],
});

const bar = (line: string): string => line.match(/[█▓▏]+/)?.[0] ?? "";

it("renders the violations screen at 120 columns: a bar per pack and Guardrail, right-aligned counts, and the legend", () => {
  const lines = renderViolations(violated(), { cols: 120, rows: 40 });
  for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(120);
  expect(lines[0]).toMatch(/^ WARDEN {2}context-manager · base origin\/main · v9\.8\.7 +q quit {2}r rerun {2}v back {2}d determinism$/);
  expect(lines[1]).toBe("─".repeat(120));
  expect(lines[2]).toMatch(/^ VIOLATIONS BY PACK +baselined +new +last run$/);
  const row = (label: string): string => lines.find((l) => l.startsWith(` ${label} `)) as string;
  expect(row("core")).toMatch(/^ core +█+▓ +30,114 +2 +16:13 commit$/);
  expect(row("  warden-no-comments")).toMatch(/^ {3}warden-no-comments +█+▓ +29,923 +1$/);
  expect(row("  warden-no-suppressions")).toMatch(/^ {3}warden-no-suppressions +█▓ +191 +1$/);
  expect(row("principles")).toMatch(/^ principles +█+ +8,402 +0 +16:13 commit$/);
  expect(row("  principles-small-files")).toMatch(/^ {3}principles-small-files +█+ +8,402 +0$/);
  expect(row("architecture")).toMatch(/^ architecture +▏ +0 +0 +16:13 commit$/);
  const core = bar(row("core")).length;
  expect(bar(row("principles")).length).toBe(Math.round((8402 / 30116) * core));
  const ends = (re: RegExp): number[] => lines.filter((l) => re.test(l)).map((l) => (l.match(re)?.index ?? 0) + (l.match(re)?.[0].length ?? 0));
  expect(new Set(ends(/[\d,]+(?= +\d+( |$))/)).size).toBe(1);
  expect(lines.at(-3)).toBe("─".repeat(120));
  expect(lines.at(-2)).toBe(" █ baselined, allowed until touched   ▓ new in the last run, blocking");
  expect(lines.at(-1)).toBe(' Next action: change the code at the lines above to match "Do this"');
});

it("at 60 columns the violations screen drops the Guardrail rows first, then the last run column, and bars never wrap", () => {
  const narrow = renderViolations(violated(), { cols: 60, rows: 40 });
  for (const l of narrow) expect(l.length, l).toBeLessThanOrEqual(60);
  expect(narrow.filter((l) => /^ {3}\S/.test(l))).toEqual([]);
  expect(narrow).toContainEqual(expect.stringMatching(/^ core +█+▓ +30,114 +2 +16:13 commit$/));
  expect(narrow).toContainEqual(expect.stringMatching(/^ architecture +▏ +0 +0 +16:13 commit$/));
  expect(narrow).toContain(" █ baselined, allowed until touched");
  expect(narrow).toContain(" ▓ new in the last run, blocking");
  const tight = renderViolations(violated(), { cols: 40, rows: 40 });
  for (const l of tight) expect(l.length, l).toBeLessThanOrEqual(40);
  expect(tight).toContainEqual(expect.stringMatching(/^ VIOLATIONS BY PACK +baselined +new$/));
  expect(tight).toContainEqual(expect.stringMatching(/^ core +█+▓ +30,114 +2$/));
});

it("the violations screen with no Evidence shows every pack, new as –, and one next action", () => {
  const lines = renderViolations(violated([]), { cols: 80, rows: 30 });
  expect(lines).toContainEqual(expect.stringMatching(/^ core +█+ +30,114 +– *$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ architecture +▏ +0 +– *$/));
  expect(lines.filter((l) => l.includes("Next action:"))).toEqual([" Next action: press r to run warden check"]);
});

it("the violations screen with no baseline shows every pack at zero baselined", () => {
  const lines = renderViolations(violated([counted], {}), { cols: 80, rows: 30 });
  expect(lines).toContainEqual(expect.stringMatching(/^ core +▓+ +0 +2 +16:13 commit$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ principles +▏ +0 +0 +16:13 commit$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ architecture +▏ +0 +0 +16:13 commit$/));
});

it("new counts come from each pack's most recent run, and a run at the failure cap says its counts are partial", () => {
  const later: Evidence = { ...passRun, at: at("16:20:00"), run: "v2", rules: { "principles-small-files": 1 }, failures: Array.from({ length: 10 }, (_, i) => ({ file: `f${i}.ts`, line: 1, guardrail: "principles-small-files", practice: "small-files" })) };
  const lines = renderViolations(violated([counted, later]), { cols: 80, rows: 30 });
  expect(lines).toContainEqual(expect.stringMatching(/^ core +█+▓ +30,114 +2 +16:13 commit$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ principles +█+▓+ +8,402 +10 +16:20 commit$/));
  expect(lines).toContain(" New counts are the first 10 failures a run records.");
});

it("plain violations carry no escape codes and control characters stay visible", () => {
  const text = plainViolations({ ...violated(), packs: ["co\x1bre"], layers: [{ pack: "co\x1bre", guardrail: "g\r", practice: "p", kind: "lint", adapter: "eslint", runs: ["edit"], median: "1 ms" }] });
  expect(text).not.toMatch(CONTROL);
  expect(text).toContain(" VIOLATIONS BY PACK");
});

it("v toggles the violations screen, and l and v switch between screens", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", rerun: vi.fn(), load: () => Promise.resolve(violated()) });
  const screen = (): string => output.text.slice(output.text.lastIndexOf("\x1b[H"));
  await vi.waitFor(() => expect(screen()).toContain(" NOW  "));
  expect(screen()).toMatch(/v violations/);
  input.emit("data", Buffer.from("v"));
  expect(screen()).toContain(" VIOLATIONS BY PACK");
  input.emit("data", Buffer.from("v"));
  expect(screen()).toContain(" NOW  ");
  input.emit("data", Buffer.from("l"));
  expect(screen()).toContain(" LAYERS  ");
  expect(screen()).toMatch(/v violations/);
  input.emit("data", Buffer.from("v"));
  expect(screen()).toContain(" VIOLATIONS BY PACK");
  input.emit("data", Buffer.from("q"));
  expect(await done).toBe(0);
});

it("liveView opens on the screen it is given", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", screen: "violations", rerun: vi.fn(), load: () => Promise.resolve(violated()) });
  await vi.waitFor(() => expect(output.text).toContain(" VIOLATIONS BY PACK"));
  input.emit("data", Buffer.from("q"));
  await done;
});

const fourPacks = (): ViewModel => {
  const ids = ["core", "principles", "architecture", "collection-folders"];
  const layers = ids.flatMap((pack) => Array.from({ length: 5 }, (_, i) => ({ pack, guardrail: `${pack}-rule-${i}`, practice: `p${i}`, kind: "lint" as const, adapter: "eslint", runs: ["commit" as const], median: "4 ms" })));
  return { ...violated([]), packs: ids, layers, rules: layers.map((l, i) => ({ guardrail: l.guardrail, strength: "proven", fired: 0, median: "4 ms", budgetMs: 2000, baselined: i * 100 })) };
};

it("a short terminal drops the Guardrail rows so every enabled pack still shows", () => {
  const lines = renderViolations(fourPacks(), { cols: 120, rows: 24 });
  expect(lines.length).toBeLessThanOrEqual(24);
  for (const pack of ["core", "principles", "architecture", "collection-folders"]) expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^ ${pack} +[█▏]`)));
  expect(lines.filter((l) => /rule-\d/.test(l))).toEqual([]);
  expect(lines.join("\n")).not.toContain("hidden");
  const tall = renderViolations(fourPacks(), { cols: 120, rows: 40 });
  expect(tall.filter((l) => /rule-\d/.test(l))).toHaveLength(20);
});

it("when even the pack rows do not fit, the last line says how many are hidden and how to see them", () => {
  const lines = renderViolations(fourPacks(), { cols: 120, rows: 8 });
  expect(lines.length).toBeLessThanOrEqual(8);
  expect(lines).toContainEqual(expect.stringMatching(/^ core /));
  expect(lines).toContain(" 3 packs hidden. Next action: run warden --violations | cat");
});

it("a long pack label is cut so its counts stay, and a small baselined count still draws a bar", () => {
  const long = renderViolations({ ...violated([]), packs: ["a-very-long-pack-name-that-is-wide"], layers: [{ pack: "a-very-long-pack-name-that-is-wide", guardrail: "g", practice: "p", kind: "lint", adapter: "eslint", runs: ["commit"], median: "1 ms" }], rules: [{ guardrail: "g", strength: "proven", fired: 0, median: "1 ms", budgetMs: 1, baselined: 5 }] }, { cols: 40, rows: 20 });
  for (const l of long) expect(l.length, l).toBeLessThanOrEqual(40);
  expect(long).toContainEqual(expect.stringMatching(/^ a-very.*… █+ +5 +–$/));
  const small = renderViolations(violated([], { "warden-no-comments": 100000, "warden-no-suppressions": 3 }), { cols: 120, rows: 40 });
  expect(small).toContainEqual(expect.stringMatching(/^ {3}warden-no-suppressions +█ +3 +–/));
});

const ranWith = (kinds: Evidence["kinds"], extra: Partial<Evidence> = {}): Evidence => ({ ...passRun, result: "fail", kinds, ...extra });

const threeProjects = (): ViewModel => ({
  ...model([]),
  projects: [
    { project: "warden", run: ranWith({}) },
    { project: "context-manager", run: ranWith({ lint: 9, type: 2, model: 1, review: 1, instruction: 1 }) },
    { project: "trq-berry", run: ranWith({ runtime: 1200, model: 300, legacy: 4 }) },
  ],
});

it("renders the determinism screen at 120 columns: the current project first and marked, a stacked bar, right-aligned counts, and the share", () => {
  const lines = renderDeterminism(threeProjects(), { cols: 120, rows: 40 });
  for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(120);
  expect(lines[0]).toMatch(/^ WARDEN {2}context-manager · base origin\/main · v9\.8\.7 +q quit {2}r rerun {2}d back$/);
  expect(lines[2]).toMatch(/^ DETERMINISM BY PROJECT +deterministic {2}judgment {2}prose {2}det\. share$/);
  expect(lines[3]).toMatch(/^ ▸ context-manager █+▒+░+ +11 +2 +1 +79%$/);
  expect(lines[4]).toMatch(/^ {3}trq-berry +█+▒+░ +1,200 +300 +4 +80%$/);
  expect(lines[5]).toMatch(/^ {3}warden +▏ +0 +0 +0 +–$/);
  expect(lines.filter((l) => l.endsWith("%") || l.endsWith("–")).map((l) => l.length)).toEqual([120, 120, 120]);
  expect(lines).toContain(" █ deterministic   ▒ judgment   ░ prose");
  expect(lines.at(-1)).toBe(" Most non-deterministic failures: trq-berry, 304 of 1,504 in its last completed run.");
});

it("at 60 columns the determinism screen drops the share column first, and bars never wrap", () => {
  const lines = renderDeterminism(threeProjects(), { cols: 60, rows: 24 });
  expect(lines.length).toBeLessThanOrEqual(24);
  for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(60);
  expect(lines[2]).toMatch(/^ DETERMINISM BY PROJECT +deterministic {2}judgment {2}prose$/);
  expect(lines.join("\n")).not.toContain("%");
  expect(lines[3]).toMatch(/^ ▸ context-manager █+▒+░+ +11 +2 +1$/);
  expect(bar(lines[4] as string).length + (lines[4]?.match(/[▒░]+/g) ?? []).join("").length).toBeGreaterThanOrEqual(8);
});

it("a record without kinds counts its recorded failures as unknown kind, in a column shown only when nonzero", () => {
  const old: Evidence = { ...blockRun, failures: [...(blockRun.failures ?? []), { file: "b.ts", line: 1, guardrail: "x", practice: "x" }] };
  const lines = renderDeterminism({ ...threeProjects(), projects: [...threeProjects().projects, { project: "older", run: old }] }, { cols: 120, rows: 40 });
  expect(lines[2]).toMatch(/ prose {2}unknown {2}det\. share$/);
  expect(lines).toContainEqual(expect.stringMatching(/^ {3}older +· +0 +0 +0 +2 +–$/));
  expect(lines).toContain(" █ deterministic   ▒ judgment   ░ prose   · unknown");
  const narrow = renderDeterminism({ ...threeProjects(), projects: [...threeProjects().projects, { project: "older", run: old }] }, { cols: 60, rows: 24 });
  for (const l of narrow) expect(l.length, l).toBeLessThanOrEqual(60);
  expect(narrow[2]).toMatch(/^ DETERMINISM +deterministic {2}judgment {2}prose {2}unknown$/);
  expect(renderDeterminism(threeProjects(), { cols: 120, rows: 40 }).join("\n")).not.toContain("unknown");
});

it("with an empty evidence folder the determinism screen says the current project has no completed run, with one next action", () => {
  const lines = renderDeterminism({ ...model([]), projects: [{ project: "context-manager" }] }, { cols: 80, rows: 24 });
  expect(lines[3]).toBe(" ▸ context-manager no completed run yet");
  expect(lines.at(-1)).toBe(" No project has a completed run. Next action: press r to run warden check");
});

it("no judgment or prose failure anywhere says so", () => {
  const lines = renderDeterminism({ ...model([]), projects: [{ project: "context-manager", run: ranWith({ lint: 3 }) }] }, { cols: 80, rows: 24 });
  expect(lines.at(-1)).toBe(" No project has a judgment or prose failure in its last completed run.");
});

it("a short terminal keeps the current project and says how many projects are hidden and how to see them", () => {
  const lines = renderDeterminism(threeProjects(), { cols: 120, rows: 8 });
  expect(lines.length).toBeLessThanOrEqual(8);
  expect(lines[3]).toMatch(/^ ▸ context-manager /);
  expect(lines).toContain(" 2 projects hidden. Next action: run warden --determinism | cat");
});

it("plain determinism carries no escape codes and control characters stay visible", () => {
  const text = plainDeterminism({ ...threeProjects(), projects: [{ project: "co\x1bntext", run: ranWith({ lint: 1 }) }] });
  expect(text).not.toMatch(CONTROL);
  expect(text).toContain("co\\u001bntext");
});

it("d toggles the determinism screen, every header names it, and l, v, and d switch between screens", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, file: "p.jsonl", rerun: vi.fn(), load: () => Promise.resolve({ ...violated(), projects: threeProjects().projects }) });
  const screen = (): string => output.text.slice(output.text.lastIndexOf("\x1b[H"));
  output.columns = 120;
  await vi.waitFor(() => expect(screen()).toContain(" NOW  "));
  expect(screen()).toContain("d determinism");
  input.emit("data", Buffer.from("d"));
  expect(screen()).toContain(" DETERMINISM BY PROJECT");
  input.emit("data", Buffer.from("d"));
  expect(screen()).toContain(" NOW  ");
  input.emit("data", Buffer.from("l"));
  expect(screen()).toContain("d determinism");
  input.emit("data", Buffer.from("v"));
  expect(screen()).toContain("d determinism");
  input.emit("data", Buffer.from("d"));
  expect(screen()).toContain(" DETERMINISM BY PROJECT");
  input.emit("data", Buffer.from("q"));
  expect(await done).toBe(0);
});
