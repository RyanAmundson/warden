import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Served, serve } from "../../src/cli/daemon.js";

const wardenRoot = resolve(import.meta.dirname, "../..");

const { renderApp, frozenHtml }: { renderApp: (state: unknown) => string; frozenHtml: (state: unknown) => string } = await import(pathToFileURL(join(wardenRoot, "web/render.js")).href);

const at = (minutes: number): string => new Date(Date.UTC(2026, 10, 18, 17, 0) + minutes * 60000).toISOString();

const run = (over: Record<string, unknown> = {}) => ({ at: at(30), run: "r-pass", tier: "edit", trigger: "agent-edit", outcome: "ran", result: "pass", exit: 0, ms: 900, steps: { "rules-intact": 170, "tools-ready": 1, rules: 500, verdict: 50 }, files: 3, bytes: 4200, guardrails: 2, rules: { "warden-no-comments": 0.3 }, cachedRules: [], ratchet: [43634, 43634], root: "/p/cm", ...over });

const ERROR_NEXT = "run warden compile, stage .warden, and commit";

const errorRun = (id: string, minutes: number) => run({ run: id, at: at(minutes), outcome: "error", result: undefined, exit: 2, ms: 506, steps: { "rules-intact": 1.3 }, next: ERROR_NEXT, ratchet: undefined, rules: undefined });

const BLOCK_NEXT = "remove the suppression at src/cli/view.ts:212, then commit again";

const blockRun = run({ run: "r-block", at: at(20), tier: "commit", trigger: "git-commit", result: "fail", exit: 1, failures: [{ file: "src/cli/view.ts", line: 212, guardrail: "warden-no-suppressions", practice: "no-suppressions", doThis: "delete the eslint-disable comment on line 212" }], next: BLOCK_NEXT });

const cmRuns = [errorRun("r-err2", 40), errorRun("r-err1", 35), run(), blockRun];

const health = { status: "ok", pid: 1, version: "0.1.8", startedAt: at(0), heartbeatAt: at(40), heartbeatFile: "/tmp/wh/daemon/heartbeat.json", intervalMs: 10000, staleAfterMs: 30000, port: 7419, projects: 2, openAlerts: 1 };

const projects = [
  { project: "context-manager", roots: ["/p/cm"], lastRun: cmRuns[0], openAlerts: 0 },
  { project: "warden", roots: ["/p/w", "/p/w2"], lastRun: run({ run: "w-1", root: "/p/w" }), openAlerts: 1 },
];

const detection = { project: "warden", root: "/p/w", file: "packs/core/fixtures/clean-pass.ts", detail: "source-drift", next: "revert your change to packs/core/fixtures/clean-pass.ts" };

const tamper = { open: [detection], recent: [{ ...detection, at: at(10), kind: "tampered", trigger: "daemon" }, { project: "warden", root: "/p/w", at: at(5), kind: "tampered", file: ".warden/lock.json", detail: "lock-drift", next: "revert your change to .warden/lock.json" }] };

const layers = {
  project: "warden",
  bands: [
    { band: "deterministic", kinds: [{ kind: "type", rules: [] }, { kind: "lint", rules: [{ pack: "core", guardrail: "warden-no-comments", practice: "no-comments", kind: "lint", adapter: "eslint", runs: ["edit", "commit"], median: "shared", promote: false }] }, { kind: "runtime", rules: [] }] },
    { band: "judgment", kinds: [{ kind: "model", rules: [] }, { kind: "review", rules: [] }] },
    { band: "prose", kinds: [{ kind: "instruction", rules: [{ pack: "core", guardrail: "warden-say-why", practice: "say-why", kind: "instruction", adapter: "claude", runs: ["edit"], median: "–", promote: true }] }, { kind: "legacy", rules: [] }] },
  ],
  practices: [{ practice: "no-comments", strongestKind: "lint", promote: false }, { practice: "say-why", strongestKind: "instruction", promote: true }],
  packs: [{ id: "core", source: "bundled", on: true, rules: 2 }, { id: "principles", source: "bundled", on: false, rules: 9 }],
};

const violations = { project: "context-manager", packs: [{ pack: "core", baselined: 30100, new: 2, lastRun: { at: at(30), trigger: "agent-edit", run: "r-pass" }, guardrails: [{ guardrail: "warden-no-comments", baselined: 29909, new: 2 }, { guardrail: "warden-no-suppressions", baselined: 191, new: null }] }] };

const determinism = { projects: [{ project: "context-manager", run: "r-pass", at: at(30), counts: { deterministic: 2, judgment: 1, prose: 0, unknown: 0 } }, { project: "warden", run: null, at: null, counts: null }] };

const state = (page: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ page, project: "context-manager", health, projects, data: { projects, ...data }, view: { fresh: new Set() }, now: Date.parse(at(40)), ...extra });

const checks = (html: string): [string, string, string, string][] => [...html.matchAll(/<li class="check-(pass|fail|skip)"><svg[^]*?<\/svg><span class="mono wrap">([^<]*)<\/span><span class="wrap [a-z]+">([^<]*)<\/span><span class="r">([^<]*)<\/span><\/li>/g)].map((m) => m.slice(1) as [string, string, string, string]);

const nextActions = (html: string): string[] => [...html.matchAll(/<div class="next"><span class="lbl">Next action<\/span><code>([^<]*)<\/code>/g)].map((m) => m[1] as string);

describe("pages render from API responses", () => {
  it("renders the overview with alerts, project cards, and the live stream", () => {
    const html = renderApp(state("overview", { tamper, runs: { "context-manager": cmRuns, warden: [run({ run: "w-1" })] } }));
    expect(html).toContain('<h1 class="h1">Overview</h1>');
    expect(html).toContain("2 projects watched");
    expect(html).toContain("1 open detection: source-drift");
    expect(html).toContain(`href="/run?project=context-manager&amp;run=r-err2"`);
    expect(html).toContain("Error · rules intact");
    expect(html).toContain("…/p/w</span> and 1 other checkout");
    expect(html).toContain("43,634");
    expect(nextActions(html)).toEqual([ERROR_NEXT]);
    expect((html.match(/<tr class="held">/g) ?? []).length).toBe(3);
    expect(html).toContain('aria-current="page">Overview');
  });

  it("filters the overview stream to one project", () => {
    const html = renderApp(state("overview", { tamper, runs: { "context-manager": cmRuns, warden: [run({ run: "w-1", trigger: "manual" })] } }, { view: { filter: "warden", fresh: new Set() } }));
    expect(html).toContain("manual run");
    expect(html).not.toContain("<td>agent edit</td>");
  });

  it("renders runs with a selected detail, and filters to not passing", () => {
    const all = renderApp(state("runs", { runs: { project: "context-manager", runs: cmRuns } }, { view: { run: "r-block", outcome: "all", fresh: new Set() } }));
    expect(all).toContain("Runs · context-manager");
    expect(all).toContain("4 recent runs · 3 not passing");
    expect(all).toContain("Commit check");
    expect(all).toContain(">Blocked</span>");
    expect(all).toContain('title="src/cli/view.ts:212">view.ts:212');
    expect(all).toContain('src/cli/view.ts</td><td class="r">212</td>');
    expect(all).toContain("Do this: delete the eslint-disable comment on line 212");
    expect(nextActions(all)).toEqual([BLOCK_NEXT]);
    expect(all.split(`>${BLOCK_NEXT}<`)).toHaveLength(2);
    expect(all).toContain('<td><a href="#detail">See run details</a></td>');
    expect(all).toContain(`<td class="mono clip" title="${ERROR_NEXT}">${ERROR_NEXT}</td>`);
    const not = renderApp(state("runs", { runs: { project: "context-manager", runs: cmRuns } }, { view: { outcome: "not", fresh: new Set() } }));
    expect(not).toContain("Not passing · newest first");
    expect(not).not.toContain('run=r-pass"');
  });

  it("shows which ref is automatically audited even after a later manual run", () => {
    const audit = run({ run: "r-main", trigger: "main audit", ref: "refs/remotes/origin/main" });
    const watched = [{ ...projects[0], lastRun: cmRuns[0], lastMainAudit: audit }, { ...projects[1], repositories: [{ repo: "/p/w/.git", roots: ["/p/w", "/p/w2"], openAlerts: 0 }, { repo: "/p/copy/.git", roots: ["/p/copy"], openAlerts: 1 }] }];
    const html = renderApp(state("overview", { projects: watched, tamper, runs: { "context-manager": [...cmRuns, audit], warden: [] } }, { projects: watched }));
    expect(html).toContain('class="watch-audit">Automatic audit · origin/main');
    expect(html).toContain('title="refs/remotes/origin/main">Automatic audit · origin/main');
    expect(html).toContain('href="/run?project=context-manager&amp;run=r-main">Edit audit');
    expect(html).toContain('href="/runs?project=context-manager&amp;run=r-main#detail"');
    expect(html).toContain("1 of 2 repositories have open detections");
  });

  it("keeps edit findings and the passing boundary audit visible after a later manual check", () => {
    const shared = { trigger: "main audit", ref: "refs/remotes/origin/main", commit: "a".repeat(40) };
    const edit = run({ ...shared, run: "main-edit", result: "fail", exit: 0 });
    const boundary = run({ ...shared, tier: "boundary", run: "main-boundary" });
    const manual = run({ run: "manual", trigger: "manual", at: at(50) });
    const watched = [{ ...projects[0], lastRun: manual, lastMainAudit: boundary, mainAuditRuns: [edit, boundary] }];
    const html = renderApp(state("overview", { projects: watched, tamper, runs: { "context-manager": [manual, boundary, edit] } }, { projects: watched }));
    expect(html).toContain('>edit · Advisory findings</span>');
    expect(html).toContain('>boundary · Pass</span>');
    expect(html).toContain('href="/run?project=context-manager&amp;run=main-edit">Edit audit</a> <span class="tag err">Advisory findings</span>');
    expect(html).toContain('href="/run?project=context-manager&amp;run=main-boundary">Boundary audit</a> <span class="tag pass">Pass</span>');
  });

  it("shows advisory findings and the exact main audit receipt in both run views", () => {
    const audit = run({
      run: "r-audit", tier: "boundary", trigger: "main audit", ref: "refs/remotes/origin/main", result: "fail", exit: 0,
      root: "/worktrees/context-manager-main-audit", commit: "0123456789abcdef0123456789abcdef01234567", scope: "full", packs: ["core", "delivery"],
      file: "build/core-plugin-bundles.ts", files: 1, ms: 2875, rules: { "warden-no-comments": 0.3, "delivery-boundary": 135.2 }, cachedRules: ["warden-no-suppressions"],
      failures: [{ file: "build/core-plugin-bundles.ts", line: 1, guardrail: "delivery-boundary", practice: "delivery-check" }],
    });
    for (const page of ["runs", "run"]) {
      const html = renderApp(state(page, { runs: { project: "context-manager", runs: [audit] } }, { view: { run: "r-audit" } }));
      expect(html).toContain("Advisory findings");
      expect(html).toContain("main branch update · 2,875 ms · exit 0");
      expect(html).toContain("/worktrees/context-manager-main-audit");
      expect(html).toContain("0123456789abcdef0123456789abcdef01234567");
      expect(html).toContain("refs/remotes/origin/main");
      expect(html).toContain("Full tier");
      expect(html).toContain("build/core-plugin-bundles.ts</td><td class=\"r\">1</td>");
      expect(html).toContain('<code class="mono">core</code>, <code class="mono">delivery</code>');
      expect(checks(html).filter(([, label]) => label.includes("-"))).toEqual([
        ["fail", "delivery-boundary", "failed · 1 finding shown below", "135 ms"],
        ["pass", "warden-no-comments", "passed", "&lt;1 ms"],
        ["pass", "warden-no-suppressions", "passed, cached result", "cached"],
      ]);
      expect(html).not.toContain("Block · L1");
    }
  });

  it("distinguishes an incomplete audit from refusal and leaves unknown receipt fields blank", () => {
    const incomplete = run({ run: "r-incomplete", trigger: "main audit", result: "fail", exit: 1, rules: undefined, cachedRules: undefined, scope: undefined, commit: undefined });
    const refused = run({ run: "r-refused", trigger: "audit", outcome: "refused", result: "fail", exit: 1, alert: "lock-drift" });
    const runs = { project: "context-manager", runs: [incomplete, refused] };
    const list = renderApp(state("runs", { runs }));
    expect(list).toContain("Incomplete audit");
    expect(list).toContain(">Refused</span>");
    expect(checks(list)).toContainEqual(["skip", "Rules", "no per-rule results were recorded", ""]);
    expect(list).toContain('>Commit</dt><dd>–</dd>');
    expect(list).toContain('>Scope</dt><dd>–</dd>');
    const detail = renderApp(state("run", { runs }, { view: { run: refused.run } }));
    expect(detail).toContain("Audit refused by an open tamper alert");
    expect(detail).not.toContain("Blocked by an open tamper alert");
  });

  it("shows a historical continuous audit finding without implying that it blocked an edit", () => {
    const previous = run({ trigger: "continuous audit", result: "fail", failures: [{ file: "build/delivery.ts", line: 1 }] });
    const html = renderApp(state("runs", { runs: { project: "context-manager", runs: [previous] } }));
    expect(html).toContain("continuous audit");
    expect(html).toContain("Advisory findings");
    expect(html).toContain('title="build/delivery.ts:1">delivery.ts:1');
  });

  it("renders the error-run state with one next action and the streak", () => {
    const html = renderApp(state("run", { runs: { project: "context-manager", runs: cmRuns } }, { view: { run: "r-err2", fresh: new Set() } }));
    expect(html).toContain("Error at rules intact");
    expect(html).toContain("stopped at step 1 of 4");
    expect(html).toContain("not reached");
    expect(html).toContain("Same outcome, 2 runs in a row");
    expect(nextActions(html)).toEqual([ERROR_NEXT]);
  });

  it("plays a run's change video with its keyframes, and shows nothing extra for a run without one", () => {
    const recorded = run({ run: "r-video", video: { file: "change.webm", keyframes: ["01-before.jpg", "02-after.jpg"] } });
    const page = (id: string) => renderApp(state("run", { runs: { project: "context-manager", runs: [recorded, ...cmRuns] } }, { view: { run: id, fresh: new Set() } }));
    const html = page("r-video");
    const src = (file: string) => `/api/video?project=context-manager&amp;run=r-video&amp;file=${file}`;
    expect(html).toContain(`<video controls preload="metadata" width="1280" height="800" src="${src("change.webm")}"></video>`);
    expect(html).toContain("Recorded by the agent that made the change · 2 keyframes");
    expect([...html.matchAll(/<img src="([^"]+)" alt="([^"]+)"/g)].map((m) => [m[1], m[2]])).toEqual([[src("01-before.jpg"), "Keyframe 01-before.jpg"], [src("02-after.jpg"), "Keyframe 02-after.jpg"]]);
    for (const id of ["r-pass", "r-err2"]) {
      const plain = page(id);
      expect(plain).not.toContain("<video");
      expect(plain).not.toContain("Change video");
    }
  });

  it("renders layers with the weakest practice and the packs", () => {
    const html = renderApp(state("layers", { layers }, { project: "warden" }));
    expect(html).toContain("say-why, held only by instruction");
    expect(html).toContain("warden-no-comments");
    expect(html).toContain("compiler proves it · none yet");
    expect(html).toContain("Promote");
    expect(html).toContain('<span class="muted">Off</span>');
  });

  it("renders violations by pack with counts and the ratchet", () => {
    const html = renderApp(state("violations", { violations, layers, runs: { project: "context-manager", runs: cmRuns } }));
    expect(html).toContain("Violations · context-manager");
    expect(html).toContain("30,100");
    expect(html).toContain("43,634 → 43,634");
    expect(html).toContain("blocking until fixed");
    expect(html).toContain("Off in this project · 9 rules");
  });

  it("renders determinism shares and stops", () => {
    const html = renderApp(state("determinism", { determinism, runs: { "context-manager": cmRuns, warden: [] } }));
    expect(html).toContain("67%");
    expect(html).toContain("No run has reached rules yet");
    expect(html).toContain("Stops before any rule ran");
    expect(html).toMatch(/context-manager<\/td><td class="r">0<\/td><td class="r">0<\/td><td class="r">2<\/td>/);
  });

  it("renders the tamper state with exactly one next action", () => {
    const html = renderApp(state("tamper", { tamper }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Tamper detected in warden");
    expect(nextActions(html)).toEqual([detection.next]);
    expect(html).toContain("Open now · 1 detection");
    expect(html).toContain("Not open now");
  });

  it("shows alert history state by repository or by checkout and keeps unknown legacy records neutral", () => {
    const cloneA = { project: "warden", root: "/p/clone-a", repo: "/p/clone-a/.git" };
    const cloneB = { project: "warden", root: "/p/clone-b", repo: "/p/clone-b/.git" };
    const worktreeB = { ...cloneB, root: "/p/worktree-b" };
    const hook = { file: "pre-commit", detail: "hook-unwired", next: "inspect Git hooks" };
    const lock = { file: ".warden/lock.json", detail: "lock-drift", next: "inspect the lock" };
    const open = [{ ...cloneB, ...hook }, { ...cloneB, ...lock }];
    const recent = [
      { ...cloneA, ...hook, at: at(10) },
      { ...worktreeB, ...hook, at: at(11) },
      { ...cloneB, ...lock, at: at(12) },
      { ...worktreeB, ...lock, at: at(13) },
      { project: "warden", ...hook, at: at(14) },
      { project: "warden", repo: cloneB.repo, ...lock, at: at(15) },
    ];
    const html = renderApp(state("tamper", { tamper: { open, recent } }));
    const history = html.slice(html.indexOf('class="tamper-history-table"'));
    const rows = [...history.matchAll(/<tr><td>(.*?)<\/tr>/g)].map((match) => match[1]);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toContain('title="/p/clone-a">…/p/clone-a');
    expect(rows[0]).toContain(">Not open now<");
    expect(rows[1]).toContain('title="/p/worktree-b">…/p/worktree-b');
    expect(rows[1]).toContain(">Open<");
    expect(rows[2]).toContain(">Open<");
    expect(rows[3]).toContain(">Not open now<");
    expect(rows[4]).toContain("Checkout unavailable");
    expect(rows[4]).toContain(">Unknown<");
    expect(rows[5]).toContain("Repo …/p/clone-b");
    expect(rows[5]).toContain(">Unknown<");
  });

  it("renders the refused outcome with its next action", () => {
    const refused = run({ run: "r-ref", at: at(45), tier: "commit", trigger: "git-commit", outcome: "refused", result: undefined, exit: 1, steps: { "rules-intact": 2 }, next: "start the daemon: warden daemon install", ratchet: undefined, rules: undefined });
    const html = renderApp(state("run", { runs: { project: "context-manager", runs: [refused, ...cmRuns] } }, { view: { run: "r-ref", fresh: new Set() } }));
    expect(html).toContain("Refused at rules intact");
    expect(nextActions(html)).toEqual(["start the daemon: warden daemon install"]);
    const stops = renderApp(state("determinism", { determinism, runs: { "context-manager": [refused, ...cmRuns], warden: [] } }));
    expect(stops).toMatch(/context-manager<\/td><td class="r">0<\/td><td class="r">1<\/td><td class="r">2<\/td>/);
  });

  it("renders the sparse-checkout next action of a commit run whose failing file is not on disk", () => {
    const next = "run git sparse-checkout add --skip-checks -- 'packs/core' to bring packs/core/a.ts onto disk, then change the code at the lines above to match \"Do this\"";
    const sparse = run({ run: "r-sparse", at: at(45), tier: "commit", trigger: "git-commit", result: "fail", exit: 1, treeOid: "abc", failures: [{ file: "packs/core/a.ts", line: 3, guardrail: "warden-no-comments", practice: "no-comments" }], next });
    const html = renderApp(state("run", { runs: { project: "context-manager", runs: [sparse, ...cmRuns] } }, { view: { run: "r-sparse", fresh: new Set() } }));
    expect(html).toContain("Check blocked");
    expect(nextActions(html).map((n) => n.replaceAll("&#39;", "'").replaceAll("&quot;", '"'))).toEqual([next]);
  });

  it("renders a run that stopped before its first step", () => {
    const early = run({ run: "r-early", outcome: "error", result: undefined, exit: 2, steps: {}, next: "run warden check --base main", ratchet: undefined, rules: undefined });
    const html = renderApp(state("run", { runs: { project: "context-manager", runs: [early] } }, { view: { run: "r-early", fresh: new Set() } }));
    expect(html).toContain("Error before the first step");
    expect(checks(html)).toEqual([
      ["skip", "No open alerts", "not reached", ""],
      ["skip", "Rules intact", "not reached", ""],
      ["skip", "Tools ready", "not reached", ""],
      ["skip", "Rules", "did not run, because Warden stopped first", ""],
    ]);
    expect(html).toContain("0 passed · 0 failed · 4 not run");
    expect(nextActions(html)).toEqual(["run warden check --base main"]);
  });

  it("renders gate-off and unchecked-commit detections with their API next action and no lock art", () => {
    const open = [
      { project: "warden", root: "/p/w", file: "run r-9", detail: "gate-off", next: "run warden check at the commit tier without WARDEN_DAEMON=off" },
      { project: "warden", root: "/p/w", file: "3f2a9c1", detail: "unchecked-commit", next: "run warden check --base main and fix what it reports" },
    ];
    const html = renderApp(state("tamper", { tamper: { open, recent: [] } }));
    expect(nextActions(html)).toEqual([open[0]?.next]);
    expect(html).toContain("skipped the daemon gate");
    expect(html).toContain("without a passing commit check");
    expect(html).not.toContain("The key no longer fits");
  });

  it("says so when a linked run is not among the fetched runs", () => {
    const html = renderApp(state("run", { runs: { project: "context-manager", runs: cmRuns } }, { view: { run: "r-old", fresh: new Set() } }));
    expect(html).toContain("is not among the last 4 runs of context-manager");
    expect(html).not.toContain("Error at rules intact");
    const list = renderApp(state("runs", { runs: { project: "context-manager", runs: cmRuns } }, { view: { run: "r-old", outcome: "all", fresh: new Set() } }));
    expect(list).toContain("is not among the last 4 runs");
  });

  it("escapes band names from the layers API", () => {
    const html = renderApp(state("layers", { layers: { ...layers, bands: [{ band: '"><x-inj>', kinds: [] }] } }, { project: "warden" }));
    expect(html).not.toContain("<x-inj>");
  });

  it("renders the tamper page clear when nothing is open", () => {
    const html = renderApp(state("tamper", { tamper: { open: [], recent: [] } }));
    expect(html).toContain("No open tamper detections in any watched project.");
    expect(nextActions(html)).toEqual([]);
  });

  it("renders the empty state on every project page when nothing is watched", () => {
    for (const page of ["overview", "runs", "run", "layers", "violations", "determinism", "tamper"]) {
      const html = renderApp({ ...state(page, {}), projects: [], data: { projects: [] } });
      expect(html).toContain("No projects are watched yet");
      expect(nextActions(html)).toEqual(["run warden init in a project"]);
    }
  });

  it("renders the daemon-lost state over the frozen page", () => {
    const html = renderApp({ ...state("overview", {}), lost: true, frozen: "<p>frozen overview</p>", frozenAt: at(41) });
    expect(html).toContain("The Warden daemon stopped answering");
    expect(html).toContain("Daemon not answering");
    expect(html).toContain('<div class="frozen"');
    expect(html).toContain("<p>frozen overview</p>");
    expect(html).toContain("Reconnecting every 10 seconds");
    expect(nextActions(html)).toEqual(["run warden daemon install"]);
  });

  it("renders an API error with the next action the API gave", () => {
    const html = renderApp({ ...state("layers", {}), error: { status: 422, error: "lock written by an older Warden", next: "run warden compile" } });
    expect(html).toContain("lock written by an older Warden");
    expect(nextActions(html)).toEqual(["run warden compile"]);
  });

  it("escapes values from the API", () => {
    const html = renderApp(state("tamper", { tamper: { open: [{ ...detection, file: "<img src=x onerror=alert(1)>" }], recent: [] } }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("an unwired project and audit mode", () => {
  const hook = { project: "context-manager", root: "/p/cm", file: ".warden/generated/hooks/pre-commit", detail: "hook-unwired", next: "make .git/hooks/pre-commit run Warden" };
  const unchecked = { project: "context-manager", root: "/p/cm", file: "4fbbfa67b769", detail: "unchecked-commit", next: "check commit 4fbbfa67b769" };
  const unwiredRun = run({ run: "r-unwired", at: at(39), alert: "hook-unwired", next: hook.next, rules: { "warden-no-comments": 0.3 }, cachedRules: ["warden-no-suppressions"] });
  const wired = [{ ...projects[0], lastRun: unwiredRun, openAlerts: 3, mode: "enforce", unwired: [hook] }, projects[1]];
  const at2 = (page: string, data: Record<string, unknown>, view: Record<string, unknown> = {}) => ({ ...state(page, data, { view: { fresh: new Set(), ...view } }), projects: wired, data: { projects: wired, ...data } });

  it("shows an unwired project as its own setup error, apart from tamper alerts and rule results", () => {
    const overview = renderApp(at2("overview", { tamper: { open: [hook, unchecked], recent: [] }, runs: { "context-manager": [unwiredRun], warden: [] } }));
    expect(overview).toContain("Warden is unwired in context-manager");
    expect(overview).toContain("The commit hook does not run Warden. Commits land without a Warden check. While this alert is open, Warden refuses checks that would otherwise pass. This is a setup problem, not a rule failure. Fix it first, then review the remaining open alerts on the Tamper page.");
    expect(overview).toContain("unchecked-commit on");
    expect(overview).not.toContain("hook-unwired on");
    expect(overview).toContain('>Warden unwired</small>');
    expect(overview).toContain('<span class="tag mode enforce"');
    const page = renderApp(at2("run", { runs: { project: "context-manager", runs: [unwiredRun] } }, { run: "r-unwired" }));
    expect(page).toContain("Warden is unwired");
    expect(checks(page)).toEqual([
      ["fail", "No open alerts", "Warden is unwired. The commit hook does not run Warden.", ""],
      ["pass", "Rules intact", "done", "170 ms"],
      ["pass", "Tools ready", "done", "1 ms"],
      ["pass", "warden-no-comments", "passed", "&lt;1 ms"],
      ["pass", "warden-no-suppressions", "passed, cached result", "cached"],
    ]);
    expect(page).toContain("4 passed · 1 failed · 0 not run");
  });

  it("labels audit-mode failures as recorded and not blocking", () => {
    const failed = run({ run: "r-audit-mode", result: "fail", exit: 0, mode: "audit", failedRules: ["warden-no-comments"], failures: [{ file: "b.ts", line: 1, guardrail: "warden-no-comments", practice: "no-comments" }] });
    const list = renderApp(at2("runs", { runs: { project: "context-manager", runs: [failed] } }));
    expect(list).toContain("Failed · not blocked");
    expect(list).not.toContain(">Blocked</span>");
    expect(list).toContain("Audit mode. Warden recorded this run and did not block.");
    expect(list).toContain("Enforcing: Failures block agent edits and commits.");
    const page = renderApp(at2("run", { runs: { project: "context-manager", runs: [failed] } }, { run: "r-audit-mode" }));
    expect(page).toContain("Rules failed in audit mode");
    expect(checks(page)).toContainEqual(["fail", "warden-no-comments", "failed · 1 finding shown below", "&lt;1 ms"]);
  });
});

describe("runs blocked by an open alert", () => {
  const alertRun = run({ run: "r-alert", at: at(39), tier: "commit", trigger: "git-commit", exit: 1, result: "pass", scope: "full", alert: "source-drift", next: "revert your change to src/a.ts" });

  it("shows a run blocked by an alert as blocked in the runs table and the run page, with the alert's next action", () => {
    const runs = [alertRun, run()];
    const list = renderApp(state("runs", { runs: { project: "context-manager", runs } }, { view: { run: "r-alert", outcome: "not", fresh: new Set() } }));
    expect(list).toContain("1 not passing");
    expect(list).toContain("Blocked by alert");
    expect(list).toContain("open tamper alert: source-drift");
    const page = renderApp(state("run", { runs: { project: "context-manager", runs } }, { view: { run: "r-alert", fresh: new Set() } }));
    expect(page).toContain("Blocked by an open tamper alert");
    expect(page).not.toContain(">Pass<");
    expect(nextActions(page)).toEqual(["revert your change to src/a.ts"]);
  });

  it("names the repository of each open detection", () => {
    const html = renderApp(state("tamper", { tamper: { ...tamper, open: [{ ...detection, repo: "/p/w/.git" }] } }));
    expect(html).toContain('title="/p/w/.git">…/p/w</div>');
  });
});

describe("UI QA fixes", () => {
  it("marks the selected run with aria-current and links each run to its detail", () => {
    const html = renderApp(state("runs", { runs: { project: "context-manager", runs: cmRuns } }, { view: { run: "r-block", outcome: "all", fresh: new Set() } }));
    expect(html).toContain('<tr class="sel" aria-current="true">');
    expect((html.match(/<tr[^>]*aria-current/g) ?? []).length).toBe(1);
    expect(html).toContain('href="/runs?project=context-manager&amp;run=r-block#detail"');
    expect(html).toContain('<section class="mod narrow detail" id="detail"');
  });

  it("marks the current watched project in the sidebar, and the stylesheet styles it", async () => {
    const html = renderApp(state("runs", { runs: { project: "context-manager", runs: cmRuns } }));
    expect(html).toMatch(/aria-current="true"><span>context-manager<\/span>/);
    const css = await readFile(join(wardenRoot, "web/app.css"), "utf8");
    expect(css).toContain(".nav a[aria-current]{");
  });

  it("shows a dash for the last pass of a project with no runs", () => {
    const html = renderApp(state("overview", { tamper: { open: [], recent: [] }, runs: { "context-manager": [], warden: [run({ run: "w-1" })] } }));
    expect(html).not.toContain("in the last 0 runs");
    expect(html).toMatch(/Last pass<\/div><div>–<\/div>/);
  });

  it("offers no dead link from the empty state and words None yet as plain text", () => {
    const html = renderApp({ ...state("layers", {}), projects: [], data: { projects: [] } });
    expect(html).not.toContain('href="/layers">See the bundled packs');
    expect(html).toContain('<li class="empty-item">None yet</li>');
    expect(html).toContain('<h1 class="h1">Layers</h1>');
  });

  it("makes the frozen page inert while the daemon is lost", () => {
    const html = renderApp({ ...state("overview", {}), lost: true, frozen: '<button data-action="pause">Pause live</button>', frozenAt: at(41) });
    expect(html).toMatch(/<div class="frozen" inert[ >]/);
  });

  it("omits the column header of a band with no rules", () => {
    const html = renderApp(state("layers", { layers }, { project: "warden" }));
    const judgment = html.slice(html.indexOf('id="ly-judgment"'), html.indexOf('id="ly-prose"'));
    expect(judgment).not.toContain("<thead>");
    expect(html.slice(html.indexOf('id="ly-prose"'))).toContain("<thead>");
  });
});

describe("review and UI QA round 2", () => {
  const lost = (page: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const live = state(page, data, extra);
    return renderApp({ ...live, lost: true, frozen: frozenHtml(live), frozenAt: at(41) });
  };

  it("shows only the banner's next action while the daemon is lost, over a real failing page", () => {
    const overview = lost("overview", { tamper, runs: { "context-manager": cmRuns, warden: [] } });
    expect(renderApp(state("overview", { tamper, runs: { "context-manager": cmRuns, warden: [] } }))).toContain(`<code>${ERROR_NEXT}</code>`);
    expect(overview).toContain("context-manager");
    expect(nextActions(overview)).toEqual(["run warden daemon install"]);
    expect(overview).not.toContain("Next action:");
    expect(overview.match(/next action/gi)).toHaveLength(1);
    const runPage = lost("run", { runs: { project: "context-manager", runs: cmRuns } }, { view: { run: "r-block", fresh: new Set() } });
    expect(runPage).toContain("Check blocked");
    expect(nextActions(runPage)).toEqual(["run warden daemon install"]);
    const list = lost("runs", { runs: { project: "context-manager", runs: cmRuns } }, { view: { run: "r-block" } });
    expect(nextActions(list)).toEqual(["run warden daemon install"]);
    expect(list).not.toContain(BLOCK_NEXT);
    expect(list).not.toContain(ERROR_NEXT);
    expect(list).not.toContain("See run details");
  });

  it("shows each overview run's next action once", () => {
    const html = renderApp(state("overview", { tamper: { open: [], recent: [] }, runs: { "context-manager": cmRuns, warden: [] } }));
    expect(nextActions(html)).toEqual([ERROR_NEXT]);
    expect(html).not.toContain(`Next action: <span class="mono">${ERROR_NEXT}`);
  });

  it("gives every layer band table the same fixed columns", async () => {
    const html = renderApp(state("layers", { layers }));
    const tables = [...html.matchAll(/<table class="bandt">(<colgroup>.*?<\/colgroup>)/g)].map((m) => m[1]);
    expect(tables).toHaveLength(3);
    expect(new Set(tables).size).toBe(1);
    expect(await readFile(join(wardenRoot, "web/app.css"), "utf8")).toContain(".bandt{table-layout:fixed");
  });

  it("keeps the Weak column wide enough for the Promote tag", () => {
    const html = renderApp(state("layers", { layers }));
    expect(html).toContain("Promote");
    for (const m of html.matchAll(/<colgroup>(.*?)<\/colgroup>/g)) expect(m[1]).toMatch(/<col style="width:96px"><\/colgroup>|<col style="width:96px">$/);
  });

  it("wraps long band cells instead of clipping them", async () => {
    const css = await readFile(join(wardenRoot, "web/app.css"), "utf8");
    expect(css).toContain(".bandt td{white-space:normal;overflow-wrap:anywhere}");
    expect(css).not.toMatch(/\.bandt td\{[^}]*overflow:hidden/);
  });

  it("breaks long identifiers in the Layers band and Failures File cells while keeping the Median on one line", async () => {
    const css = await readFile(join(wardenRoot, "web/app.css"), "utf8");
    expect(css).toContain("td.path{overflow-wrap:anywhere");
    expect(css).toContain(".bandt td{white-space:normal;overflow-wrap:anywhere");
    expect(css).toContain(".bandt td.r{white-space:nowrap}");
    const html = renderApp(state("run", { runs: { project: "context-manager", runs: cmRuns } }, { view: { run: "r-block", fresh: new Set() } }));
    expect(html).toContain('<td class="mono wrap path">');
  });

  it("stacks each alert tag above its text below 780 px, so the link stays beside the text", async () => {
    const css = await readFile(join(wardenRoot, "web/app.css"), "utf8");
    expect(css.slice(css.indexOf("@media (max-width:779px)"))).toContain(".alert>.slot{flex-basis:100%}");
  });

  it("puts every overview alert tag in a fixed-width slot", async () => {
    const html = renderApp(state("overview", { tamper, runs: { "context-manager": cmRuns, warden: [] } }));
    const rows = html.match(/<div class="alert[^"]*">/g) ?? [];
    expect(rows.length).toBeGreaterThan(1);
    expect(html.match(/<div class="alert[^"]*"><span class="slot"><span class="tag /g)).toHaveLength(rows.length);
    expect(await readFile(join(wardenRoot, "web/app.css"), "utf8")).toMatch(/\.alert>\.slot\{flex:0 0 \d+px/);
  });

  it("names the time the data loaded, not the time of the last draw", () => {
    const html = renderApp(state("overview", { tamper, runs: { "context-manager": cmRuns, warden: [] } }, { loadedAt: Date.parse(at(10)) }));
    expect(html).toContain(`updated ${new Date(Date.parse(at(10))).toTimeString().slice(0, 8)}`);
  });

  it("says the page no longer reconnects when the event stream closed", () => {
    const html = renderApp({ ...state("overview", {}), lost: true, streamClosed: true, frozen: "", frozenAt: at(41) });
    expect(html).toContain("no longer reconnects on its own");
    expect(html).not.toContain("Reconnecting every");
  });

  it("escapes the project name in the sidebar", () => {
    const evil = [{ ...projects[0], project: "<x-inj>" }];
    const html = renderApp({ ...state("tamper", { tamper: { open: [], recent: [] } }), projects: evil });
    expect(html).toContain("&lt;x-inj&gt;");
    expect(html).not.toContain("<x-inj>");
  });
});

describe("the daemon serves the web UI", () => {
  let scratch: string;
  let served: Served;
  const saved = { WARDEN_HOME: process.env.WARDEN_HOME, HOME: process.env.HOME };

  beforeAll(async () => {
    scratch = realpathSync(await mkdtemp(join(tmpdir(), "warden-web-")));
    process.env.WARDEN_HOME = join(scratch, "warden-home");
    process.env.HOME = join(scratch, "home");
    served = await serve(wardenRoot, 0);
  });

  afterAll(async () => {
    await served.close();
    process.env.WARDEN_HOME = saved.WARDEN_HOME;
    process.env.HOME = saved.HOME;
    await rm(scratch, { recursive: true, force: true });
  });

  const get = (path: string): Promise<{ status: number; type: string; body: string }> =>
    new Promise((done, fail) => {
      request({ host: "127.0.0.1", port: served.port, path }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => done({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
      })
        .on("error", fail)
        .end();
    });

  it.each(["/", "/runs", "/run", "/layers", "/violations", "/determinism", "/tamper"])("serves %s as the page shell", async (path) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/html; charset=utf-8");
    expect(res.body).toContain('<script type="module" src="/app.js"></script>');
  });

  it.each([
    ["/app.css", "text/css; charset=utf-8", ".tag{"],
    ["/app.js", "text/javascript; charset=utf-8", 'from "/render.js"'],
    ["/render.js", "text/javascript; charset=utf-8", "export const renderApp"],
  ])("serves %s with its content type", async (path, type, text) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.type).toBe(type);
    expect(res.body).toContain(text);
  });

  it("loads both dashboard fonts from the daemon", async () => {
    const [page, css] = await Promise.all([get("/"), get("/app.css")]);
    expect(page.body).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
    const fonts = ["/fonts/Archivo.woff2", "/fonts/JetBrainsMono.woff2"];
    for (const path of fonts) expect(css.body).toContain(`url("${path}")`);
    for (const font of await Promise.all(fonts.map(get))) {
      expect(font.status).toBe(200);
      expect(font.type).toBe("font/woff2");
      expect(font.body.slice(0, 4)).toBe("wOF2");
    }
  });

  it("refuses a page for a foreign Host", async () => {
    const res = await new Promise<{ status: number; body: string }>((done, fail) => {
      request({ host: "127.0.0.1", port: served.port, path: "/runs", headers: { host: "evil.example" } }, (r) => {
        let body = "";
        r.on("data", (c: Buffer) => (body += c.toString("utf8")));
        r.on("end", () => done({ status: r.statusCode ?? 0, body }));
      })
        .on("error", fail)
        .end();
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).next).toBe(`open http://127.0.0.1:${served.port}/ directly`);
  });

  it("answers a page with a 500 and its next action when the web folder is missing", async () => {
    const bare = join(scratch, "bare-warden");
    await mkdir(bare, { recursive: true });
    await writeFile(join(bare, "package.json"), JSON.stringify({ version: "0.0.0" }));
    const other = await serve(bare, 0);
    try {
      const res = await new Promise<{ status: number; body: string }>((done, fail) => {
        request({ host: "127.0.0.1", port: other.port, path: "/runs" }, (r) => {
          let body = "";
          r.on("data", (c: Buffer) => (body += c.toString("utf8")));
          r.on("end", () => done({ status: r.statusCode ?? 0, body }));
        })
          .on("error", fail)
          .end();
      });
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).next).toBe("reinstall Warden so its web folder is present");
    } finally {
      await other.close();
    }
  });

  it("still answers an unknown path with a JSON 404", async () => {
    const res = await get("/nope.js");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).next).toContain("/api/health");
  });
});
