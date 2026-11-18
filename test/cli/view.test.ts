import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LEAVE, type ViewModel, liveView, plainView, render } from "../../src/cli/view.js";
import type { Evidence } from "../../src/runner/evidence.js";

const at = (time: string): string => `2026-11-18T${time}.000Z`;

const steps = (run: string, time: string, last: "done" | "fail" = "done"): Evidence[] => [
  { at: at(time), kind: "step", run, step: "rules-intact", state: "start", ms: 0, tier: "edit", trigger: "agent-edit" },
  { at: at(time), kind: "step", run, step: "rules-intact", state: "done", ms: 2.2 },
  { at: at(time), kind: "step", run, step: "tools-ready", state: "start", ms: 0 },
  { at: at(time), kind: "step", run, step: "tools-ready", state: "done", ms: 0.4, status: "cached" },
  { at: at(time), kind: "step", run, step: "rules", state: "start", ms: 0, tier: "edit", trigger: "agent-edit", files: 1, file: "src/hooks/useRx.ts", detail: "eslint", members: ["warden-no-comments", "warden-no-suppressions"] },
  { at: at(time), kind: "step", run, step: "rules", state: "done", ms: 4.1 },
  { at: at(time), kind: "step", run, step: "verdict", state: "start", ms: 0 },
  { at: at(time), kind: "step", run, step: "verdict", state: last, ms: 0.3 },
];

const passRun: Evidence = { at: at("14:01:40"), kind: "cost", guardrail: "run", run: "r1", tier: "commit", trigger: "git-commit", outcome: "ran", result: "pass", exit: 0, ms: 9, files: 3, bytes: 90, guardrails: 2, cached: 0, ratchet: [44175, 44174] };
const blockRun: Evidence = {
  at: at("14:02:11"), kind: "cost", guardrail: "run", run: "r2", tier: "edit", trigger: "agent-edit", outcome: "ran", result: "fail", exit: 0, ms: 5, files: 1, file: "src/hooks/useRx.ts", bytes: 30, guardrails: 2, cached: 0, ratchet: [44174, 44174],
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
  expect(lines[0]).toMatch(/^ WARDEN {2}context-manager · base origin\/main · v9\.8\.7 +q quit {2}r rerun {2}↑↓ runs$/);
  expect(lines[1]).toBe("─".repeat(80));
  expect(lines[2]).toBe(" NOW  commit check · 3 files · triggered by git commit");
  expect(lines[3]).toMatch(/^ {3}✓ 1 rules intact {6}lock matches, 0 tampered files +2 ms$/);
  expect(lines[4]).toMatch(/^ {3}✓ 2 tools ready {7}eslint 9\.39\.5 · typescript 5\.9\.3 +cached$/);
  expect(lines[5]).toMatch(/^ {3}✓ 3 rules {13}warden-no-comments · warden-no-suppressions +4 ms$/);
  expect(lines[6]).toMatch(/^ {3}✓ 4 verdict {11}pass +0 ms$/);
  expect(lines).toContainEqual(expect.stringMatching(/^ RULES \(core pack\) +strength +fired +median +budget$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ {3}warden-no-comments +proven +12 +4 ms +2000 ms$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ > 14:01:40 {2}commit {2}3 files +✓ pass {3}9 ms +44,175 → 44,174$/));
  expect(lines.at(-2)).toBe("─".repeat(80));
  expect(lines.at(-1)).toBe(" The last run passed; nothing to do.");
});

it("renders a blocked run at 80 columns with its failure and one next action", () => {
  const lines = render(model([...steps("r1", "14:01:40"), passRun, ...steps("r2", "14:02:11", "fail"), blockRun]), size, 0);
  fits(lines);
  expect(lines[2]).toBe(" NOW  edit check · src/hooks/useRx.ts · triggered by agent edit");
  expect(lines[6]).toMatch(/^ {3}✗ 4 verdict {11}BLOCK {2}src\/hooks\/useRx\.ts:2 warden-no-comments +0 ms$/);
  expect(lines).toContainEqual(expect.stringMatching(/^ > 14:02:11 {2}edit {4}useRx\.ts +✗ BLOCK {2}no-comments L2 +44,174 → 44,174$/));
  expect(lines).toContainEqual(expect.stringMatching(/^ {3}14:01:40 {2}commit/));
  expect(lines.filter((l) => l.includes("Next action:"))).toEqual([' Next action: change the code at the lines above to match "Do this"']);
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
  expect(lines[2]).toBe(" NOW  commit check · 3 files · triggered by git commit");
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
  const done = liveView({ input, output, watchDir: dir, rerun, load: () => Promise.resolve(model([...steps("r1", "14:01:40"), passRun, blockRun])) });
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
  const done = liveView({ input, output, watchDir: dir, rerun: vi.fn(), load: () => Promise.resolve(model([])) });
  await vi.waitFor(() => expect(output.text).toContain("NOW  idle"));
  input.emit("data", Buffer.from("\x03"));
  expect(await done).toBe(0);
  expect(output.text.endsWith(LEAVE)).toBe(true);
});

it("an error restores the terminal and rejects", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, rerun: vi.fn(), load: () => Promise.reject(new Error("records broke")) });
  await expect(done).rejects.toThrow("records broke");
  expect(output.text.endsWith(LEAVE)).toBe(true);
  expect(input.raw).toEqual([true, false]);
});

it("redraws when the terminal is resized", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const done = liveView({ input, output, watchDir: dir, rerun: vi.fn(), load: () => Promise.resolve(model([])) });
  await vi.waitFor(() => expect(output.text).toContain("NOW  idle"));
  output.columns = 60;
  output.emit("resize");
  expect(output.text).toContain(`${"─".repeat(60)}\n`);
  input.emit("data", Buffer.from("q"));
  await done;
});
