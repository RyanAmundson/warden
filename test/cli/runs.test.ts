import { appendFileSync, watch } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runRuns } from "../../src/cli/runs.js";

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, watch: vi.fn(real.watch) };
});

const wardenRoot = resolve(import.meta.dirname, "../..");

let root: string;
let home: string;
let out: string;

const passed = { kind: "cost", guardrail: "run", run: "r1", at: "2026-11-18T14:01:40.000Z", tier: "commit", trigger: "git-commit", outcome: "ran", result: "pass", exit: 0, ms: 9.4, files: 3, bytes: 90, guardrails: 4, cached: 2, commit: "abc1234def" };
const blocked = {
  kind: "cost", guardrail: "run", run: "r2", at: "2026-11-18T14:02:11.000Z", tier: "edit", trigger: "agent-edit", outcome: "ran", result: "fail", exit: 0, ms: 5, files: 1, file: "src/useRx.ts", bytes: 30, guardrails: 2, cached: 0, commit: "fedcba9876",
  failures: [{ file: "src/useRx.ts", line: 2, guardrail: "warden-no-comments", practice: "no-comments", doThis: "export const sumOfPrices = 1;" }],
  next: 'change the code at the lines above to match "Do this"',
};
const step = { kind: "step", run: "r2", step: "rules", state: "start", ms: 0, at: "2026-11-18T14:02:11.000Z" };

const lines = (rows: Record<string, unknown>[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "warden-runs-"));
  home = await mkdtemp(join(tmpdir(), "warden-home-"));
  vi.stubEnv("WARDEN_HOME", home);
  vi.stubEnv("TZ", "UTC");
  await mkdir(join(root, ".warden"), { recursive: true });
  await writeFile(join(root, ".warden/config.yaml"), 'warden: "0.1.0"\nproject: p\nbase: main\npacks:\n  - id: core\n    paths: ["**/*.ts"]\ntierBudgetMs: { edit: 1000, commit: 2000, boundary: 5000 }\nloopBreakerRepeats: 3\n');
  await mkdir(join(home, "evidence"), { recursive: true });
  await writeFile(join(home, "evidence/p.jsonl"), lines([passed, step, blocked]));
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

it("lists the newest runs as a table, newest last, with the first failure", async () => {
  expect(await runRuns(root, wardenRoot, { limit: 20, format: "text" })).toBe(0);
  const rows = out.trimEnd().split("\n");
  expect(rows[0]).toMatch(/^time\s+trigger\s+tier\s+files\s+rules\s+cached\s+result\s+ms\s+first failure$/);
  expect(rows[1]).toMatch(/^14:01:40\s+git-commit\s+commit\s+3 files\s+4\s+2\s+pass\s+9\s*$/);
  expect(rows[2]).toMatch(/^14:02:11\s+agent-edit\s+edit\s+src\/useRx\.ts\s+2\s+0\s+fail\s+5\s+src\/useRx\.ts:2 warden-no-comments$/);
  expect(rows).toHaveLength(3);
});

it("--limit keeps the newest N runs", async () => {
  await runRuns(root, wardenRoot, { limit: 1, format: "text" });
  expect(out.trimEnd().split("\n").slice(1).map((r) => r.slice(0, 8))).toEqual(["14:02:11"]);
});

it("--format json prints the run records", async () => {
  await runRuns(root, wardenRoot, { limit: 20, format: "json" });
  expect((JSON.parse(out) as { run: string }[]).map((r) => r.run)).toEqual(["r1", "r2"]);
});

it("--follow prints a run that lands after it starts, until interrupted", async () => {
  const stop = new AbortController();
  const following = runRuns(root, wardenRoot, { limit: 20, format: "text", follow: true, signal: stop.signal });
  await vi.waitFor(() => expect(out).toContain("14:02:11"));
  await new Promise((r) => setTimeout(r, 50));
  await appendFile(join(home, "evidence/p.jsonl"), lines([{ ...passed, run: "r3", at: "2026-11-18T14:05:00.000Z", trigger: "manual" }]));
  await vi.waitFor(() => expect(out).toMatch(/14:05:00\s+manual/), { timeout: 2000, interval: 20 });
  stop.abort();
  expect(await following).toBe(0);
  expect(out.match(/14:02:11/g)).toHaveLength(1);
});

it("--follow prints a run that lands while the watcher is being armed", async () => {
  const real = (await vi.importActual<typeof import("node:fs")>("node:fs")).watch;
  vi.mocked(watch).mockImplementationOnce(((...args: Parameters<typeof real>) => {
    appendFileSync(join(home, "evidence/p.jsonl"), lines([{ ...passed, run: "r4", at: "2026-11-18T14:06:00.000Z", trigger: "manual" }]));
    return real(...args);
  }) as typeof real);
  const stop = new AbortController();
  const following = runRuns(root, wardenRoot, { limit: 20, format: "text", follow: true, signal: stop.signal });
  await vi.waitFor(() => expect(out).toMatch(/14:06:00\s+manual/), { timeout: 1000, interval: 20 });
  stop.abort();
  expect(await following).toBe(0);
});

it("shows control characters in a file name as visible escapes", async () => {
  await appendFile(join(home, "evidence/p.jsonl"), lines([{ ...blocked, run: "r5", file: "q\x1b]0;PWNED\x07<b>.ts" }]));
  await runRuns(root, wardenRoot, { limit: 20, format: "text" });
  expect(out).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  expect(out).toContain("q\\u001b]0;PWNED\\u0007<b>.ts");
});

it("--html writes one self-contained page with the latest run's commit and result, each Practice's strength, and failures with Do this", async () => {
  const file = join(root, "runs.html");
  expect(await runRuns(root, wardenRoot, { limit: 20, format: "text", html: file })).toBe(0);
  const page = await readFile(file, "utf8");
  expect(page).toContain("fedcba9");
  expect(page).toMatch(/fedcba9[\s\S]*fail/);
  expect(page).toContain("no-comments");
  expect(page).toContain("proven");
  expect(page).toContain("export const sumOfPrices = 1;");
  expect(page).not.toMatch(/<script|<link|https?:\/\//);
  expect(out).toContain(file);
});

it("a project without Warden exits 2 with one next action", async () => {
  await rm(join(root, ".warden"), { recursive: true, force: true });
  await expect(runRuns(root, wardenRoot, { limit: 20, format: "text" })).rejects.toThrow(/not found\. Next action: run warden init$/);
});
