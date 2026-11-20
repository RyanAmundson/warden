import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { GENERATED_TSCONFIG, TSC_CONFIG_SOURCE } from "../adapters/tsc-config.js";
import { claudeSession, hookTriggers } from "../adapters/claude.js";
import { PARSE_ERROR, type RunContext, type RunResult, type Violation } from "../adapters/types.js";
import { wardenVersion } from "../compiler/compile.js";
import { LOCK_FORMAT, LOCK_PATH, bundledTools, canonicalJson, olderThan, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, loadRecords, parseConfig } from "../records/load.js";
import type { Guardrail, Kind, RecordSet, Tier } from "../records/types.js";
import { BASELINE_PATH, applyBaseline, carryRenames, projectFiles, projectInventory, readBaseline, writeBaseline } from "../runner/baseline.js";
import { cacheKey, readCache, writeCache, type CachedViolations } from "../runner/cache.js";
import { type BaseRef, commitsOf, covers, indexTree, stagedMismatch, changedFiles, mergeBase, changesSinceMergeBase, hasPathCommitIndex, headCommit, matchesHead, lastCommittedText, showAtMergeBase, skippedIndexPaths, stageFile, sparseMode, stagedFiles, trackedFiles, type StagedBlob, unstagedFiles, checkoutBlobs } from "../runner/changed.js";
import { type Detection, heartbeatProblem, openAlerts } from "../runner/daemon.js";
import { doctor, formatDoctor } from "../runner/doctor.js";
import { type Evidence, LOOP_TAIL_BYTES, type Outcome, RUN_TOTAL, type RunFailure, type Step, type Trigger, appendEvidence, readEvidenceTail } from "../runner/evidence.js";
import { type Format, type Notes, type Repeated, formatFeedback } from "../runner/feedback.js";
import { recordResolutions } from "../runner/resolutions.js";
import { runGuardrails, unknownAdapters, wholeTree } from "../runner/run.js";
import { type Tamper, findTampering, readBaseLock } from "../runner/tamper.js";
import { verifyCheckBase } from "./base.js";

export interface CheckOptions {
  root: string;
  wardenRoot: string;
  paths?: string[];
  rule?: string;
  tier?: Tier;
  base?: string;
  format: Format;
  hook?: "claude";
  hookInput?: string;
  trigger?: Trigger;
}

const selectGuardrails = (set: RecordSet, rule: string | undefined): Guardrail[] => {
  const gs = set.packs.flatMap((p) =>
    p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction" && (rule === undefined || g.id === rule || x.id === rule))),
  );
  if (rule !== undefined && gs.length === 0) throw new RecordError("", "/rule", `no Practice or Guardrail has id "${rule}"`);
  return gs;
};

const guardrailsOf = (set: RecordSet, implementation: string): Guardrail[] => selectGuardrails(set, undefined).filter((g) => g.implementation === implementation);

const hookBase = (root: string): string => {
  if (!existsSync(join(root, LOCK_PATH))) throw new RecordError(LOCK_PATH, "", "is missing, so the edit hook has no base branch. Next action: run warden compile");
  return readLock(root).config.base;
};

const removedWarden = (root: string, given: string | undefined): { set: RecordSet; tamper: Tamper } | undefined => {
  if (existsSync(join(root, ".warden/config.yaml"))) return undefined;
  const text = lastCommittedText(root, ".warden/config.yaml");
  if (text === undefined) return undefined;
  const config = parseConfig(".warden/config.yaml", text);
  const comparison = verifyCheckBase(root, given, config.base);
  if (!existsSync(join(root, LOCK_PATH)) && showAtMergeBase(root, comparison, LOCK_PATH) === undefined) return undefined;
  const file = existsSync(join(root, ".warden")) ? ".warden/config.yaml" : ".warden";
  return { set: { config, packs: [], root }, tamper: { file, detail: "removed" } };
};

const scannedFiles = (root: string, base: BaseRef, paths: string[] | undefined): string[] => {
  if (paths === undefined) return changedFiles(root, base).filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile());
  return paths.map((p) => {
    const file = relative(root, resolve(root, p));
    if (file.startsWith("..") || !existsSync(join(root, file)) || !statSync(join(root, file)).isFile()) {
      throw new RecordError("", "/paths", `${p} is not a file in ${root}`);
    }
    return file;
  });
};

const sized = async (set: RecordSet, gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]> => {
  const size = { files: files.length, bytes: files.reduce((n, f) => n + statSync(join(ctx.root, f)).size, 0) };
  return (await runGuardrails(set, gs, files, ctx)).map((r) => ({ ...size, ...r }));
};

const runCached = async (
  set: RecordSet,
  gs: Guardrail[],
  scanned: string[],
  shas: Map<string, string>,
  ctx: RunContext,
  project: string,
  run: { lockSha: string; warden: string; tier: Tier },
): Promise<{ perFile: RunResult[]; wholeProject: RunResult[]; ran: RunResult[]; cached: number }> => {
  const lint = scanned.length === 0 ? [] : gs.filter((g) => g.kind === "lint" && !wholeTree(g));
  const rest = gs.filter((g) => g.kind !== "lint" && !wholeTree(g) && (scanned.length > 0 || !g.implementation.startsWith("eslint:")));
  const trees = gs.filter((g) => wholeTree(g) && g.scope !== "project");
  const full = gs.filter((g) => g.scope === "project");
  const activeFull = full.filter((g) => set.config.units !== undefined || g.unitExample === undefined);
  if (activeFull.length > 0 && sparseMode(set.root) !== "off") {
    throw new RecordError("", "/rule", "Project-scoped rules need the complete checkout. Next action: run the same Warden check from a full worktree.");
  }
  const keyOf = (f: string, g: Guardrail): string => cacheKey(f, shas.get(f) as string, g, run.lockSha, run.warden);
  const hits = new Map<string, CachedViolations>();
  const misses = new Set<string>();
  for (const g of lint) {
    for (const f of scanned) {
      const cached = run.tier === "edit" ? readCache(project, keyOf(f, g)) : undefined;
      if (cached === undefined) misses.add(f);
      else hits.set(keyOf(f, g), cached);
    }
  }
  const fresh = misses.size > 0 ? await sized(set, lint, [...misses], { ...ctx, captureLintSource: true }) : [];
  const parse = fresh.filter((r) => r.guardrail === PARSE_ERROR);
  const unparsed = new Set(parse.flatMap((r) => r.violations.map((v) => v.file)));
  const results = lint.map((g): RunResult => {
    const r = fresh.find((x) => x.guardrail === g.id);
    if (r?.status === "killed") return r;
    const judgedFiles = new Map(r?.judgedFiles);
    const violations = scanned.flatMap((f) => {
      const key = keyOf(f, g);
      const expected = shas.get(f);
      if (!misses.has(f)) {
        const cached = hits.get(key) as CachedViolations;
        if (cached.judgedSha !== undefined && cached.judgedSha === expected) judgedFiles.set(f, cached.judgedSha);
        return cached.violations;
      }
      const own = (r as RunResult).violations.filter((v) => v.file === f);
      const actual = r?.inputShas?.get(f);
      const sameSource = actual === undefined ? r?.inputShas === undefined || own.length === 0 : actual === expected;
      if (!unparsed.has(f) && sameSource) writeCache(project, key, own, r?.overBudget === true ? undefined : judgedFiles.get(f));
      return own;
    });
    return { guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms: r?.ms ?? 0, overBudget: r?.overBudget === true, ...(r?.shared === undefined ? {} : { shared: r.shared }), ...(judgedFiles.size === 0 ? {} : { judgedFiles }) };
  });
  const others = [
    ...(rest.length > 0 ? await sized(set, rest, scanned, ctx) : []),
    ...(trees.length > 0 ? await sized(set, trees, projectFiles(set.root, set.config.packs.flatMap((p) => p.paths), run.tier !== "commit"), ctx) : []),
  ];
  if (activeFull.length > 0) {
    const start = performance.now();
    const { entries, nonRegular, bytes } = await projectInventory(set.root);
    const results = await runGuardrails(set, activeFull, entries, {
      ...ctx,
      projectInventory: { nonRegular, discoveryMs: performance.now() - start },
    });
    others.push(...results.map((result) => ({ files: entries.length, bytes, ...result })));
  }
  return { perFile: [...results, ...parse], wholeProject: others, ran: [...fresh, ...others], cached: hits.size };
};

const judgeBlobs = async (root: string, set: RecordSet, gs: Guardrail[], blobs: StagedBlob[], ctx: RunContext): Promise<{ results: RunResult[]; shas: Map<string, string>; bytes: number }> => {
  if (blobs.length === 0) return { results: [], shas: new Map(), bytes: 0 };
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "warden-blobs-")));
  const remove = (): void => rmSync(dir, { recursive: true, force: true });
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  const release = (): void => {
    for (const s of signals) process.off(s, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    remove();
    release();
    process.kill(process.pid, signal);
  };
  for (const s of signals) process.on(s, onSignal);
  try {
    const paths = blobs.map((b) => b.path);
    const at = checkoutBlobs(root, paths, dir);
    const shas = new Map<string, string>();
    let bytes = 0;
    for (const path of paths) {
      const content = readFileSync(join(at, path));
      shas.set(path, sha256(content));
      bytes += content.length;
    }
    const results = gs.length === 0 ? [] : await runGuardrails(set, gs, paths, { ...ctx, root: at, captureLintSource: true });
    return { results: results.map((result) => ({ files: paths.length, bytes, ...result })), shas, bytes };
  } finally {
    release();
    remove();
  }
};

const mergeResults = (results: RunResult[]): RunResult[] =>
  [...new Set(results.map((r) => r.guardrail))].map((id) => {
    const all = results.filter((r) => r.guardrail === id);
    const violations = all.flatMap((r) => r.violations);
    const status = all.some((r) => r.status === "killed") ? "killed" : violations.length > 0 ? "fail" : "pass";
    const first = all[0] as RunResult;
    if (all.length === 1) return first;
    const judgedFiles = new Map(all.flatMap((r) => r.overBudget === true ? [] : [...(r.judgedFiles ?? [])]));
    return { ...first, status, violations, judgedFiles, ms: all.reduce((n, r) => n + r.ms, 0) };
  });

const failedOf = (failures: Violation[], notes: Notes): boolean =>
  failures.length > 0 || [notes.tampered, notes.killed, notes.unstaged].some((list) => (list ?? []).length > 0);

const report = (failures: Violation[], set: RecordSet, opts: CheckOptions, notes: Notes): number => {
  const failed = failedOf(failures, notes);
  if (opts.hook === "claude") {
    if (failed) process.stdout.write(`${JSON.stringify({ decision: "block", reason: formatFeedback(failures, set, "agent", notes) })}\n`);
    return 0;
  }
  if (failed || opts.format === "json" || (notes.overBudget ?? []).length > 0) {
    process.stdout.write(`${formatFeedback(failures, set, opts.format, notes)}\n`);
  }
  return failed ? 1 : 0;
};

const refuseForAlert = (alert: Detection, opts: CheckOptions): number => {
  const message = `Warden's daemon holds an open tamper alert for this repository: ${alert.detail} ${alert.file} in ${alert.root}. Next action: ${alert.next}`;
  if (opts.hook === "claude") {
    process.stdout.write(`${JSON.stringify({ decision: "block", reason: message })}\n`);
    return 0;
  }
  process.stderr.write(`${message}\n`);
  return 1;
};

export const MAX_RECORDED_FAILURES = 10;

const kindCounts = (failures: Violation[], set: RecordSet): Partial<Record<Kind | "unknown", number>> => {
  const kindOf = new Map(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => [g.id, g.kind] as const))));
  const counts: Partial<Record<Kind | "unknown", number>> = {};
  for (const v of failures) {
    const kind = kindOf.get(v.guardrail) ?? "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
};

interface Live {
  run: string;
  at: string;
  tier: Tier;
  trigger: Trigger;
  started: number;
  project?: string;
  base?: { base: string; mergeBase: string };
  open?: { step: Step; at: number };
  steps: Partial<Record<Step, number>>;
}

const closeStep = (live: Live, state: "done" | "fail", extra: Partial<Evidence> = {}): void => {
  if (live.open === undefined || live.project === undefined) return;
  const ms = performance.now() - live.open.at;
  live.steps[live.open.step] = (live.steps[live.open.step] ?? 0) + ms;
  appendEvidence(live.project, { at: new Date().toISOString(), kind: "step", run: live.run, step: live.open.step, state, ms, ...extra });
  live.open = undefined;
};

const openStep = (live: Live, step: Step, extra: Partial<Evidence> = {}): void => {
  closeStep(live, "done");
  if (live.project === undefined) return;
  appendEvidence(live.project, { at: new Date().toISOString(), kind: "step", run: live.run, step, state: "start", ms: 0, tier: live.tier, trigger: live.trigger, ...extra });
  live.open = { step, at: performance.now() };
};

const nextOf = (message: string): string | undefined => {
  const at = message.indexOf("Next action: ");
  return at === -1 ? undefined : message.slice(at + "Next action: ".length).replace(/\.$/, "");
};

const treeOf = (root: string): { tree?: string } => {
  const tree = indexTree(root);
  return tree === undefined ? {} : { tree };
};

const baselineTotal = (b: Record<string, Record<string, number>>): number => Object.values(b).reduce((n, e) => n + Object.values(e).reduce((a, x) => a + x, 0), 0);

const check = async (opts: CheckOptions, live: Live): Promise<number> => {
  const root = resolve(opts.root);
  if (lstatSync(join(root, ".warden"), { throwIfNoEntry: false })?.isSymbolicLink() === true) {
    throw new RecordError(".warden", "", "is a symbolic link. Next action: move the link aside, restore the tracked .warden directory, then run warden check again.");
  }
  const { at, run, tier } = live;
  const finish = (project: string, outcome: Outcome, files: string[], code: number, judged?: { set: RecordSet; failures?: Violation[]; notes: Notes; extra?: Partial<Evidence> }, blobs: { paths: string[]; bytes: number } = { paths: [], bytes: 0 }): number => {
    const bytes = files.reduce((n, f) => n + statSync(join(root, f)).size, blobs.bytes);
    const inputs = [...files, ...blobs.paths];
    const commit = headCommit(root);
    const failures = judged?.failures ?? [];
    const feedback = judged === undefined ? undefined : (JSON.parse(formatFeedback(failures, judged.set, "json", judged.notes)) as { failures: RunFailure[]; next: string | null });
    const recorded = (feedback?.failures ?? []).slice(0, MAX_RECORDED_FAILURES).map(({ file, line, guardrail, practice, doThis }) => ({ file, line, guardrail, practice, ...(doThis === undefined ? {} : { doThis }) }));
    appendEvidence(project, {
      at,
      kind: "cost",
      guardrail: RUN_TOTAL,
      run,
      tier,
      trigger: live.trigger,
      root,
      ...(tier === "commit" && judged?.extra?.sparseCoverage === undefined ? treeOf(root) : {}),
      outcome,
      ...(outcome === "ran" && judged !== undefined ? { result: failedOf(failures, judged.notes) ? "fail" : "pass" } : {}),
      exit: code,
      ms: performance.now() - live.started,
      steps: live.steps,
      files: inputs.length,
      ...(inputs.length === 1 ? { file: inputs[0] } : {}),
      bytes,
      ...(commit === undefined ? {} : { commit }),
      ...live.base,
      ...(recorded.length === 0 ? {} : { failures: recorded }),
      ...(outcome === "ran" && judged !== undefined ? { kinds: kindCounts(failures, judged.set) } : {}),
      ...(feedback?.next == null ? {} : { next: feedback.next.replace(/\.$/, "") }),
      ...judged?.extra,
    });
    return code;
  };
  const removed = removedWarden(root, opts.base);
  if (removed !== undefined) {
    live.project = removed.set.config.project;
    openStep(live, "rules-intact");
    appendEvidence(removed.set.config.project, { at, kind: "tampered", file: removed.tamper.file, detail: removed.tamper.detail });
    closeStep(live, "fail");
    const notes = { tampered: [removed.tamper] };
    return finish(removed.set.config.project, "tampered", [], report([], removed.set, opts, notes), { set: removed.set, notes });
  }
  if (!existsSync(join(root, ".warden/config.yaml"))) {
    throw new RecordError(".warden/config.yaml", "", "not found. Next action: run warden init.");
  }
  const set = await loadRecords(root, opts.wardenRoot);
  const { project, loopBreakerRepeats } = set.config;
  live.project = project;
  if (tier === "commit") {
    if (process.env.WARDEN_DAEMON === "off") appendEvidence(project, { at, kind: "gate-off", run, tier, trigger: live.trigger, root, ...(opts.base === undefined ? {} : { base: opts.base }) });
    else {
      const problem = heartbeatProblem();
      if (problem !== undefined) {
        process.stderr.write(`${problem}\n`);
        const commit = headCommit(root);
        appendEvidence(project, { at, kind: "cost", guardrail: RUN_TOTAL, run, tier, trigger: live.trigger, root, outcome: "refused", exit: 1, ms: performance.now() - live.started, steps: {}, files: 0, bytes: 0, next: nextOf(problem) as string, ...(commit === undefined ? {} : { commit }) });
        return 1;
      }
    }
  }
  const comparison = verifyCheckBase(root, opts.base ?? (opts.hook === "claude" ? hookBase(root) : undefined), set.config.base);
  const base = comparison.name;
  live.base = { base, mergeBase: mergeBase(root, comparison) };
  const alerts = openAlerts(root);
  openStep(live, "rules-intact");
  if (!existsSync(join(root, LOCK_PATH)) && showAtMergeBase(root, comparison, LOCK_PATH) === undefined) {
    throw new RecordError(LOCK_PATH, "", "not found; this project was never compiled. Next action: run warden compile.");
  }
  const running = await wardenVersion(opts.wardenRoot);
  const working = existsSync(join(root, LOCK_PATH)) ? readLock(root) : undefined;
  const lockedBy = working?.warden ?? running;
  if (lockedBy !== running && !olderThan(lockedBy, running)) {
    throw new RecordError(LOCK_PATH, "/warden", `was written by Warden ${lockedBy}; this is Warden ${running}. Next action: install Warden ${lockedBy}, the release that wrote the lock, then run warden check --base ${base} again.`);
  }
  if (lockedBy !== running || (working?.format ?? LOCK_FORMAT) < LOCK_FORMAT || Object.keys(working?.generated ?? {}).some((key) => key.includes("#"))) {
    throw new RecordError(LOCK_PATH, "/warden", `${lockedBy === running ? `is in an older format than this Warden ${running} writes` : `was written by Warden ${lockedBy}, an older release than this Warden ${running}`}. Next action: run warden compile, stage .warden, and commit.`);
  }
  const unknown = unknownAdapters(set);
  if (unknown.length > 0) {
    const working = existsSync(join(root, LOCK_PATH)) ? readLock(root).sources : undefined;
    const baseLock = readBaseLock(root, comparison);
    const based = baseLock === undefined ? {} : baseLock.sources;
    const sourceKey = (file: string): string => (file.startsWith(join(root, ".warden") + sep) ? relative(root, file) : relative(opts.wardenRoot, file));
    const tampered: Tamper[] = working === undefined && baseLock !== undefined ? [{ file: LOCK_PATH, detail: "missing-lock" }] : [];
    for (const file of new Set(unknown.map((u) => u.file))) {
      const key = sourceKey(file);
      if (working?.[key] === undefined && based[key] === undefined) continue;
      const forged = working?.[key] === sha256(readFileSync(file, "utf8"));
      const dropped = working !== undefined && working[key] === undefined;
      if ((forged || dropped) && !tampered.some((t) => t.file === LOCK_PATH)) tampered.unshift({ file: LOCK_PATH, detail: "lock-drift" });
      tampered.push({ file: key, detail: "source-drift" });
    }
    if (tampered.length > 0) {
      for (const t of tampered) appendEvidence(project, { at, kind: "tampered", file: t.file, detail: t.detail });
      closeStep(live, "fail");
      return finish(project, "tampered", [], report([], set, opts, { tampered }), { set, notes: { tampered } });
    }
    const [first] = unknown as [(typeof unknown)[number]];
    throw new RecordError(first.file, `/guardrails/${first.record}/implementation`, first.message);
  }

  const tampered = await findTampering(set, opts.wardenRoot, comparison, opts.trigger === "git-commit");
  if (tampered.length > 0) {
    for (const t of tampered) appendEvidence(project, { at, kind: "tampered", file: t.file, detail: t.detail, guardrail: t.guardrail });
    closeStep(live, "fail");
    return finish(project, "tampered", [], report([], set, opts, { tampered }), { set, notes: { tampered } });
  }
  openStep(live, "tools-ready");
  const fileSha = (file: string): string => (existsSync(join(root, file)) ? sha256(readFileSync(join(root, file))) : "");
  const doctorKey = sha256(canonicalJson(["doctor", fileSha(LOCK_PATH), fileSha("package.json")]));
  const doctorCached = tier === "edit" && readCache(project, doctorKey) !== undefined;
  if (!doctorCached) {
    const health = await doctor(set);
    if (health.next !== undefined) {
      process.stderr.write(`${formatDoctor({ lines: health.lines.filter((l) => l.startsWith("FAIL")), next: health.next })}\n`);
      closeStep(live, "fail");
      return finish(project, "error", [], 2, { set, notes: {}, extra: { next: health.next } });
    }
    writeCache(project, doctorKey, []);
  }
  const locked = existsSync(join(root, LOCK_PATH)) ? readLock(root).tools : bundledTools();
  const loaded = bundledTools();
  if (canonicalJson(locked) !== canonicalJson(loaded)) {
    throw new RecordError(LOCK_PATH, "/tools", `records bundled tools ${JSON.stringify(locked ?? {})}, but this Warden loads ${JSON.stringify(loaded)}. Next action: run warden compile.`);
  }
  closeStep(live, "done", doctorCached ? { status: "cached" } : {});

  const known = new Set(selectGuardrails(set, undefined).map((g) => g.id));
  const chosen = selectGuardrails(set, opts.rule).filter((g) => g.runs.includes(tier));
  const selected = new Set(chosen.map((g) => g.id));
  const directives = guardrailsOf(set, "eslint:warden/no-suppressions");
  if (guardrailsOf(set, "eslint:warden/no-comments").some((g) => selected.has(g.id))) for (const g of directives) if (g.runs.includes(tier)) selected.add(g.id);
  const lintChosen = chosen.some((g) => g.kind === "lint");
  const guardrails = selectGuardrails(set, undefined).filter((g) => (lintChosen && g.kind === "lint" && !wholeTree(g)) || selected.has(g.id));
  const listed = scannedFiles(root, comparison, opts.paths);
  const unstaged = new Set(tier === "commit" ? unstagedFiles(root) : []);
  const onlyCommit = tier === "commit" && opts.trigger === "git-commit" && hasPathCommitIndex(root);
  const blobRules = guardrails.filter((g) => g.kind === "lint" && g.implementation.startsWith("eslint:"));
  const indexedLint = onlyCommit && opts.paths === undefined && blobRules.length > 0 && guardrails.every((g) => g.scope !== "project" && blobRules.includes(g));
  const committing = indexedLint ? new Set(stagedFiles(root)) : undefined;
  const tracked = committing === undefined ? undefined : trackedFiles(root, listed);
  let scanned = committing === undefined ? listed : listed.filter((f) => tracked?.has(f) === true && (committing.has(f) || !unstaged.has(f)));
  let absent: StagedBlob[] = [];
  let inherited: StagedBlob[] = [];
  if (tier === "commit") {
    const differing = scanned.filter((f) => unstaged.has(f));
    if (differing.length > 0) {
      const notes = { unstaged: differing, base, sparse: sparseMode(root) };
      return finish(project, "unstaged", scanned, report([], set, opts, notes), { set, notes });
    }
    const mismatch = stagedMismatch(root, comparison, indexedLint);
    if (mismatch.paths.length > 0) {
      const notes = { unstaged: mismatch.paths, hidden: mismatch.hidden, base, sparse: sparseMode(root) };
      return finish(project, "unstaged", scanned, report([], set, opts, notes), { set, notes });
    }
    if (opts.paths === undefined) absent = mismatch.absent;
    inherited = mismatch.inherited ?? [];
    if (inherited.length > 0) {
      const projected = new Set(inherited.map(({ path }) => path));
      scanned = scanned.filter((file) => !projected.has(file));
    }
  }
  const shas = new Map(scanned.map((f) => [f, sha256(readFileSync(join(root, f)))]));
  const scopeOf = (files: string[]) => ({ files: files.length, ...(files.length === 1 ? { file: files[0] } : {}) });
  let groups = 0;
  const onGroup = (files: string[]) => (adapter: string, ids: string[]): void => {
    groups += 1;
    openStep(live, "rules", { detail: adapter, members: ids, ...scopeOf(files) });
  };
  const ctx = {
    root, generatedDir: join(root, ".warden/generated"), base, onGroup: onGroup(scanned),
    ...(working === undefined ? {} : {
      lockedTscConfig: {
        generated: working.generated[GENERATED_TSCONFIG],
        sources: Object.fromEntries(Object.entries(working.sources).filter(([name]) => name.startsWith(TSC_CONFIG_SOURCE))),
      },
    }),
  };
  const lockSha = sha256(readFileSync(join(root, LOCK_PATH)));
  const ran = await runCached(set, guardrails, scanned, shas, ctx, project, { lockSha, warden: running, tier });
  const blobs = [...absent, ...inherited];
  const blobPaths = blobs.map((b) => b.path);
  const { results: blobRun, shas: blobShas, bytes: blobBytes } = await judgeBlobs(root, set, blobRules, blobs, { ...ctx, onGroup: onGroup(blobPaths) });
  for (const [path, sha] of blobShas) shas.set(path, sha);
  const sparsePaths = absent.map((b) => b.path);
  if (groups === 0) {
    openStep(live, "rules", { members: chosen.map((g) => g.id), ...scopeOf(scanned) });
    closeStep(live, "done", { status: scanned.length === 0 ? "empty" : "cached" });
  }
  openStep(live, "verdict");
  const wanted = (r: RunResult): boolean => selected.has(r.guardrail) || !known.has(r.guardrail);
  const perFile = mergeResults([...ran.perFile, ...blobRun]).filter(wanted);
  const wholeProject = ran.wholeProject.filter(wanted);
  const overBudget = [...perFile, ...wholeProject].filter((r) => r.overBudget === true).map((r) => ({ guardrail: r.guardrail, ms: r.ms, ...(r.shared?.budgetMs === undefined ? {} : { budgetMs: r.shared.budgetMs }) }));
  const killed = [...perFile, ...wholeProject]
    .filter((r) => r.status === "killed")
    .map((r) => ({ guardrail: r.guardrail, ms: r.ms, command: r.command as string }));

  const changes = await changesSinceMergeBase(root, comparison, indexedLint);
  const touched = (v: Violation): boolean => {
    const lines = changes.lines.get(v.file);
    if (lines === "all") return true;
    for (let n = v.line; n <= (v.endLine ?? v.line); n++) if (lines?.has(n) === true) return true;
    return false;
  };
  const baseline = readBaseline(root);
  const carried = carryRenames(baseline, changes.renames);
  const baselinePaths = new Set(Object.values(carried).flatMap((entries) => Object.keys(entries)));
  const missing = new Set([...baselinePaths].filter((file) => !existsSync(join(root, file))));
  const needsProject = tier === "commit" && chosen.some((g) => wholeTree(g) || /^(?:tsc|cmd):/.test(g.implementation)) && sparseMode(root) !== "off";
  const skipped = await skippedIndexPaths(root, needsProject ? undefined : missing);
  const sparseProjectFiles = needsProject ? [...skipped].filter((file) => !existsSync(join(root, file))).length : 0;
  const incompleteSparse = sparsePaths.length > 0 || sparseProjectFiles > 0;
  const judgedBlobs = new Set(blobPaths);
  const exists = (file: string): boolean => !missing.has(file) || skipped.has(file) || judgedBlobs.has(file);
  const ratchetFrom = matchesHead(root, BASELINE_PATH) ? "head" : "uncommitted";
  const blobJudgments = new Map(blobRun.filter((r) => r.status !== "killed" && r.overBudget !== true).map((r) => [r.guardrail, r.judgedFiles]));
  const judgedBlob = (rule: string, file: string): boolean => blobJudgments.get(rule)?.get(file) === blobShas.get(file) && blobShas.has(file);
  const sparseCoverage = Object.fromEntries(sparsePaths.map((file) => [
    file,
    [...new Set(blobRules.filter((g) => selected.has(g.id) && judgedBlob(g.id, file)).map((g) => g.kind))],
  ]));
  const narrow = applyBaseline(perFile, carried, [...scanned, ...blobPaths], exists, touched, (r, file) => !judgedBlobs.has(file) || judgedBlob(r.guardrail, file));
  const judged =
    tier === "edit"
      ? scanned
      : [
          ...new Set([
            ...scanned,
            ...wholeProject.flatMap((r) => r.violations.map((v) => v.file)),
            ...wholeProject.flatMap((r) => Object.keys(narrow.next[r.guardrail] ?? {}).filter((file) => !missing.has(file) || !skipped.has(file))),
          ]),
        ].filter((f) => f !== "");
  const wide = applyBaseline(wholeProject, narrow.next, judged, exists, touched);
  const failures = [...narrow.failures, ...wide.failures];
  if (tier !== "edit" && !onlyCommit && canonicalJson(wide.next) !== canonicalJson(baseline)) {
    writeBaseline(root, wide.next);
    if (tier === "commit") {
      stageFile(root, BASELINE_PATH);
      if (live.trigger === "manual" && opts.format !== "json") process.stdout.write(`Staged ${BASELINE_PATH}, which now holds ${baselineTotal(wide.next)} baselined violations; it held ${baselineTotal(baseline)}.\n`);
    }
  }

  const packOf = new Map(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => [g.id, p.id] as const))));
  const sharedPasses = new Set<unknown>();
  const ruleTimes: Record<string, number> = {};
  const passTimes: Record<string, number> = {};
  const measured = [...ran.ran, ...blobRun];
  for (const r of measured) {
    const size = { run, tier, files: r.files, bytes: r.bytes };
    if (r.shared === undefined || r.shared.guardrails === 1) {
      const pack = packOf.get(r.guardrail);
      if (r.guardrail !== PARSE_ERROR) ruleTimes[r.guardrail] = (ruleTimes[r.guardrail] ?? 0) + r.ms;
      appendEvidence(project, { at, kind: "cost", guardrail: r.guardrail, status: r.overBudget === true ? "over-budget" : r.status, ms: r.ms, ...size, ...(pack === undefined ? {} : { pack }) });
    } else if (!sharedPasses.has(r.shared)) {
      sharedPasses.add(r.shared);
      const members = measured.filter((x) => x.shared === r.shared && x.guardrail !== PARSE_ERROR);
      const over = members.some((x) => x.overBudget === true);
      const rules = Object.fromEntries(members.map((x) => [x.guardrail, x.ruleMs ?? 0]));
      for (const [rule, ms] of Object.entries(rules)) ruleTimes[rule] = (ruleTimes[rule] ?? 0) + ms;
      passTimes[r.shared.id] = (passTimes[r.shared.id] ?? 0) + r.ms - Object.values(rules).reduce((a, b) => a + b, 0);
      appendEvidence(project, { at, kind: "cost", shared: r.shared.id, guardrails: r.shared.guardrails, members: r.shared.members, status: over ? "over-budget" : "pass", ms: r.ms, ...size, rules });
    }
  }
  const prior = readEvidenceTail(project, LOOP_TAIL_BYTES);
  const policy = sha256(canonicalJson([lockSha, running, live.base]));
  const judgedByRule = new Map(perFile.map((r) => [r.guardrail, r.judgedFiles]));
  const trigger = new Set(
    opts.hook === "claude" ? (opts.hookInput === undefined ? [] : hookTriggers(root, opts.hookInput)) : opts.paths === undefined ? [] : scanned,
  );
  const session = opts.hook === "claude" && opts.hookInput !== undefined ? claudeSession(opts.hookInput, "PostToolUse") : undefined;
  let repeated: Repeated | undefined;
  for (const key of new Set(failures.map((v) => `${v.guardrail}\0${v.file}`))) {
    const [guardrail, file] = key.split("\0") as [string, string];
    const path = join(root, file);
    const judgedSha = judgedByRule.get(guardrail)?.get(file);
    const detail = judgedSha ?? shas.get(file) ?? (file !== "" && lstatSync(path, { throwIfNoEntry: false })?.isFile() ? sha256(readFileSync(path)) : "");
    const triggered = trigger.has(file);
    const pack = packOf.get(guardrail);
    appendEvidence(project, { at, kind: "fired", guardrail, file, status: "fail", detail, triggered, root, tier, run, ...(session === undefined ? {} : { session }), ...(judgedSha === undefined ? {} : { policy }), ...(pack === undefined ? {} : { pack }) });
    if (!triggered) continue;
    const same = (e: Evidence): boolean =>
      e.kind === "fired" && e.status === "fail" && e.triggered === true && e.guardrail === guardrail && e.file === file && e.detail === detail;
    const n = prior.filter(same).length + 1;
    if (n >= loopBreakerRepeats && (repeated === undefined || n > repeated.n)) repeated = { guardrail, file, n };
  }
  const notes = { repeated, overBudget, killed, ...(sparsePaths.length === 0 ? {} : { outside: sparsePaths, sparse: sparseMode(root) }) };
  closeStep(live, failedOf(failures, notes) ? "fail" : "done");
  const scope = opts.paths === undefined && opts.rule === undefined && !incompleteSparse ? "full" : "partial";
  const tree = tier === "commit" && scope === "full" && !failedOf(failures, notes) ? indexTree(root) : undefined;
  const coveredHere = (d: Detection): boolean => d.detail === "unchecked-commit" && tree !== undefined && commitsOf(root, [d.file]).some((c) => covers(root, { tree, mergeBase: live.base?.mergeBase }, c));
  const alert = failedOf(failures, notes) ? undefined : alerts.find((d) => !coveredHere(d));
  const code = alert === undefined ? report(failures, set, opts, notes) : refuseForAlert(alert, opts);
  finish(project, scanned.length === 0 && ran.ran.length === 0 && blobRun.length === 0 ? "empty" : "ran", scanned, code, { set, failures, notes, extra: { scope, ...(incompleteSparse ? { sparseCoverage, sparseProjectFiles } : {}), ...(alert === undefined ? {} : { alert: alert.detail, next: alert.next }), guardrails: chosen.length, cached: ran.cached, rules: ruleTimes, passes: passTimes, cachedRules: chosen.filter((g) => ruleTimes[g.id] === undefined).map((g) => g.id), ratchet: [baselineTotal(baseline), baselineTotal(wide.next)], ratchetFrom } }, { paths: blobPaths, bytes: blobBytes });
  if (alert === undefined && !failedOf(failures, notes)) recordResolutions(project, prior, perFile, { at, root, tier, run, policy });
  return code;
};

export async function runCheck(opts: CheckOptions): Promise<number> {
  const live: Live = {
    run: randomUUID(),
    at: new Date().toISOString(),
    tier: opts.hook === "claude" ? "edit" : (opts.tier ?? "commit"),
    trigger: opts.hook === "claude" ? "agent-edit" : (opts.trigger ?? "manual"),
    started: performance.now(),
    steps: {},
  };
  try {
    return await check(opts, live);
  } catch (cause) {
    const known = cause instanceof RecordError;
    if (known) process.stderr.write(`${cause.file} ${cause.pointer}: ${cause.message}\n`);
    closeStep(live, "fail");
    if (live.project !== undefined) {
      const commit = headCommit(resolve(opts.root));
      const next = known ? nextOf(cause.message) : `run warden check again; it stopped with: ${(cause as Error).message}`;
      appendEvidence(live.project, { at: live.at, kind: "cost", guardrail: RUN_TOTAL, run: live.run, tier: live.tier, trigger: live.trigger, outcome: "error", exit: 2, ms: performance.now() - live.started, steps: live.steps, files: 0, bytes: 0, next, ...(commit === undefined ? {} : { commit }), ...live.base });
    }
    if (!known) throw cause;
    return 2;
  }
}
