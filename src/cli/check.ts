import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { hookTriggers } from "../adapters/claude.js";
import { PARSE_ERROR, type RunContext, type RunResult, type Violation } from "../adapters/types.js";
import { wardenVersion } from "../compiler/compile.js";
import { LOCK_FORMAT, LOCK_PATH, bundledTools, canonicalJson, readLock, sha256 } from "../compiler/lock.js";
import { RecordError, loadRecords, parseConfig } from "../records/load.js";
import type { Guardrail, Kind, RecordSet, Tier } from "../records/types.js";
import { BASELINE_PATH, applyBaseline, carryRenames, readBaseline, writeBaseline } from "../runner/baseline.js";
import { cacheKey, readCache, writeCache } from "../runner/cache.js";
import { checkBaseAction, changedFiles, mergeBase, changesSinceMergeBase, containsHead, headCommit, matchesHead, lastCommittedText, showAtMergeBase, stageFile, stagedFiles, unstagedFiles, verifyBase } from "../runner/changed.js";
import { doctor, formatDoctor } from "../runner/doctor.js";
import { type Evidence, LOOP_TAIL_BYTES, type Outcome, RUN_TOTAL, type RunFailure, type Step, type Trigger, appendEvidence, readEvidenceTail } from "../runner/evidence.js";
import { type Format, type Notes, type Repeated, formatFeedback } from "../runner/feedback.js";
import { runGuardrails, unknownAdapters } from "../runner/run.js";
import { type Tamper, findTampering, readBaseLock, recordedBases } from "../runner/tamper.js";

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

const requireBase = (base: string | undefined, configured: string): string => {
  if (base !== undefined) return base;
  throw new RecordError("", "/base", `--base is missing; Warden takes the base branch from the command, never from the editable config. Next action: run warden check --base ${configured}`);
};

const olderThan = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number)) as [number[], number[]];
  const i = x.findIndex((n, j) => n !== y[j]);
  return i !== -1 && (x[i] as number) < (y[i] ?? 0);
};

const hookBase = (root: string): string => {
  if (!existsSync(join(root, LOCK_PATH))) throw new RecordError(LOCK_PATH, "", "is missing, so the edit hook has no base branch. Next action: run warden compile");
  return readLock(root).config.base;
};

const refuseOwnBranch = (root: string, base: string): void => {
  if (!containsHead(root, base)) return;
  const recorded = recordedBases(root);
  if (recorded.every((b) => b === base)) return;
  const original = recorded.at(-1) as string;
  const working = existsSync(join(root, LOCK_PATH)) ? readLock(root).config?.base : undefined;
  if (original === base && working === base) return;
  const next =
    original === base
      ? `the lock's base changed in this branch's history and now reads ${working}. Next action: revert base in .warden/config.yaml to ${original} and run warden compile`
      : `the lock first recorded base ${original}. Next action: run warden check --base ${original}`;
  throw new RecordError("", "/base", `--base ${base} already contains this work, so the merge-base lock would compare with itself; ${next}`);
};

const removedWarden = (root: string, given: string | undefined): { set: RecordSet; tamper: Tamper } | undefined => {
  if (existsSync(join(root, ".warden/config.yaml"))) return undefined;
  const text = lastCommittedText(root, ".warden/config.yaml");
  if (text === undefined) return undefined;
  const config = parseConfig(".warden/config.yaml", text);
  const base = requireBase(given, config.base);
  verifyBase(root, base, checkBaseAction);
  refuseOwnBranch(root, base);
  if (!existsSync(join(root, LOCK_PATH)) && showAtMergeBase(root, base, LOCK_PATH) === undefined) return undefined;
  const file = existsSync(join(root, ".warden")) ? ".warden/config.yaml" : ".warden";
  return { set: { config, packs: [], root }, tamper: { file, detail: "removed" } };
};

const scannedFiles = (root: string, base: string, paths: string[] | undefined): string[] => {
  if (paths === undefined) return changedFiles(root, base).filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile());
  return paths.map((p) => {
    const file = relative(root, resolve(root, p));
    if (file.startsWith("..") || !existsSync(join(root, file)) || !statSync(join(root, file)).isFile()) {
      throw new RecordError("", "/paths", `${p} is not a file in ${root}`);
    }
    return file;
  });
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
  const lint = scanned.length === 0 ? [] : gs.filter((g) => g.kind === "lint");
  const rest = gs.filter((g) => g.kind !== "lint" && (scanned.length > 0 || !g.implementation.startsWith("eslint:")));
  const keyOf = (f: string, g: Guardrail): string => cacheKey(f, shas.get(f) as string, g, run.lockSha, run.warden);
  const hits = new Map<string, Violation[]>();
  const misses = new Set<string>();
  for (const g of lint) {
    for (const f of scanned) {
      const cached = run.tier === "edit" ? readCache(project, keyOf(f, g)) : undefined;
      if (cached === undefined) misses.add(f);
      else hits.set(keyOf(f, g), cached);
    }
  }
  const fresh = misses.size > 0 ? await runGuardrails(set, lint, [...misses], ctx) : [];
  const parse = fresh.filter((r) => r.guardrail === PARSE_ERROR);
  const unparsed = new Set(parse.flatMap((r) => r.violations.map((v) => v.file)));
  const results = lint.map((g): RunResult => {
    const r = fresh.find((x) => x.guardrail === g.id);
    if (r?.status === "killed") return r;
    const violations = scanned.flatMap((f) => {
      if (!misses.has(f)) return hits.get(keyOf(f, g)) as Violation[];
      const own = (r as RunResult).violations.filter((v) => v.file === f);
      if (!unparsed.has(f)) writeCache(project, keyOf(f, g), own);
      return own;
    });
    return { guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms: r?.ms ?? 0, overBudget: r?.overBudget === true, ...(r?.shared === undefined ? {} : { shared: r.shared }) };
  });
  const others = rest.length > 0 ? await runGuardrails(set, rest, scanned, ctx) : [];
  return { perFile: [...results, ...parse], wholeProject: others, ran: [...fresh, ...others], cached: hits.size };
};

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

const baselineTotal = (b: Record<string, Record<string, number>>): number => Object.values(b).reduce((n, e) => n + Object.values(e).reduce((a, x) => a + x, 0), 0);

const check = async (opts: CheckOptions, live: Live): Promise<number> => {
  const root = resolve(opts.root);
  const { at, run, tier } = live;
  const finish = (project: string, outcome: Outcome, files: string[], code: number, judged?: { set: RecordSet; failures?: Violation[]; notes: Notes; extra?: Partial<Evidence> }): number => {
    const bytes = files.reduce((n, f) => n + statSync(join(root, f)).size, 0);
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
      outcome,
      ...(outcome === "ran" && judged !== undefined ? { result: failedOf(failures, judged.notes) ? "fail" : "pass" } : {}),
      exit: code,
      ms: performance.now() - live.started,
      steps: live.steps,
      files: files.length,
      ...(files.length === 1 ? { file: files[0] } : {}),
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
  const base = requireBase(opts.base ?? (opts.hook === "claude" ? hookBase(root) : undefined), set.config.base);
  verifyBase(root, base, checkBaseAction);
  refuseOwnBranch(root, base);
  live.base = { base, mergeBase: mergeBase(root, base) };
  openStep(live, "rules-intact");
  if (!existsSync(join(root, LOCK_PATH)) && showAtMergeBase(root, base, LOCK_PATH) === undefined) {
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
    const baseLock = readBaseLock(root, base);
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

  const tampered = await findTampering(set, opts.wardenRoot, base, opts.trigger === "git-commit");
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
  const guardrails = selectGuardrails(set, undefined).filter((g) => (lintChosen && g.kind === "lint") || selected.has(g.id));
  const listed = scannedFiles(root, base, opts.paths);
  const unstaged = new Set(tier === "commit" ? unstagedFiles(root) : []);
  const committing = opts.trigger === "git-commit" ? new Set(stagedFiles(root)) : undefined;
  const scanned = committing === undefined ? listed : listed.filter((f) => committing.has(f) || !unstaged.has(f));
  if (tier === "commit") {
    const differing = scanned.filter((f) => unstaged.has(f));
    if (differing.length > 0) {
      const notes = { unstaged: differing, base };
      return finish(project, "unstaged", scanned, report([], set, opts, notes), { set, notes });
    }
  }
  const shas = new Map(scanned.map((f) => [f, sha256(readFileSync(join(root, f)))]));
  const where = { files: scanned.length, ...(scanned.length === 1 ? { file: scanned[0] } : {}) };
  let groups = 0;
  const onGroup = (adapter: string, ids: string[]): void => {
    groups += 1;
    openStep(live, "rules", { detail: adapter, members: ids, ...where });
  };
  const ctx = { root, generatedDir: join(root, ".warden/generated"), onGroup };
  const lockSha = sha256(readFileSync(join(root, LOCK_PATH)));
  const ran = await runCached(set, guardrails, scanned, shas, ctx, project, { lockSha, warden: running, tier });
  if (groups === 0) {
    openStep(live, "rules", { members: chosen.map((g) => g.id), ...where });
    closeStep(live, "done", { status: scanned.length === 0 ? "empty" : "cached" });
  }
  openStep(live, "verdict");
  const wanted = (r: RunResult): boolean => selected.has(r.guardrail) || !known.has(r.guardrail);
  const perFile = ran.perFile.filter(wanted);
  const wholeProject = ran.wholeProject.filter(wanted);
  const overBudget = [...perFile, ...wholeProject].filter((r) => r.overBudget === true).map((r) => ({ guardrail: r.guardrail, ms: r.ms, ...(r.shared?.budgetMs === undefined ? {} : { budgetMs: r.shared.budgetMs }) }));
  const killed = [...perFile, ...wholeProject]
    .filter((r) => r.status === "killed")
    .map((r) => ({ guardrail: r.guardrail, ms: r.ms, command: r.command as string }));

  const exists = (f: string): boolean => existsSync(join(root, f));
  const changes = changesSinceMergeBase(root, base);
  const touched = (v: Violation): boolean => {
    const lines = changes.lines.get(v.file);
    if (lines === "all") return true;
    for (let n = v.line; n <= (v.endLine ?? v.line); n++) if (lines?.has(n) === true) return true;
    return false;
  };
  const baseline = readBaseline(root);
  const ratchetFrom = matchesHead(root, BASELINE_PATH) ? "head" : "uncommitted";
  const narrow = applyBaseline(perFile, carryRenames(baseline, changes.renames), scanned, exists, touched);
  const judged =
    tier === "edit"
      ? scanned
      : [
          ...new Set([
            ...scanned,
            ...wholeProject.flatMap((r) => r.violations.map((v) => v.file)),
            ...wholeProject.flatMap((r) => Object.keys(narrow.next[r.guardrail] ?? {})),
          ]),
        ].filter((f) => f !== "");
  const wide = applyBaseline(wholeProject, narrow.next, judged, exists, touched);
  const failures = [...narrow.failures, ...wide.failures];
  if (tier !== "edit" && canonicalJson(wide.next) !== canonicalJson(baseline)) {
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
  for (const r of ran.ran) {
    const size = { run, tier, files: r.files, bytes: r.bytes };
    if (r.shared === undefined || r.shared.guardrails === 1) {
      const pack = packOf.get(r.guardrail);
      if (r.guardrail !== PARSE_ERROR) ruleTimes[r.guardrail] = r.ms;
      appendEvidence(project, { at, kind: "cost", guardrail: r.guardrail, status: r.overBudget === true ? "over-budget" : r.status, ms: r.ms, ...size, ...(pack === undefined ? {} : { pack }) });
    } else if (!sharedPasses.has(r.shared)) {
      sharedPasses.add(r.shared);
      const members = ran.ran.filter((x) => x.shared === r.shared && x.guardrail !== PARSE_ERROR);
      const over = members.some((x) => x.overBudget === true);
      const rules = Object.fromEntries(members.map((x) => [x.guardrail, x.ruleMs ?? 0]));
      Object.assign(ruleTimes, rules);
      passTimes[r.shared.id] = r.ms - Object.values(rules).reduce((a, b) => a + b, 0);
      appendEvidence(project, { at, kind: "cost", shared: r.shared.id, guardrails: r.shared.guardrails, members: r.shared.members, status: over ? "over-budget" : "pass", ms: r.ms, ...size, rules });
    }
  }
  const prior = readEvidenceTail(project, LOOP_TAIL_BYTES);
  const trigger = new Set(
    opts.hook === "claude" ? (opts.hookInput === undefined ? [] : hookTriggers(root, opts.hookInput)) : opts.paths === undefined ? [] : scanned,
  );
  let repeated: Repeated | undefined;
  for (const key of new Set(failures.map((v) => `${v.guardrail}\0${v.file}`))) {
    const [guardrail, file] = key.split("\0") as [string, string];
    const detail = shas.get(file) ?? (file !== "" && exists(file) ? sha256(readFileSync(join(root, file))) : "");
    const triggered = trigger.has(file);
    appendEvidence(project, { at, kind: "fired", guardrail, file, status: "fail", detail, triggered });
    if (!triggered) continue;
    const same = (e: Evidence): boolean =>
      e.kind === "fired" && e.status === "fail" && e.triggered === true && e.guardrail === guardrail && e.file === file && e.detail === detail;
    const n = prior.filter(same).length + 1;
    if (n >= loopBreakerRepeats && (repeated === undefined || n > repeated.n)) repeated = { guardrail, file, n };
  }
  const notes = { repeated, overBudget, killed };
  closeStep(live, failedOf(failures, notes) ? "fail" : "done");
  const code = report(failures, set, opts, notes);
  return finish(project, scanned.length === 0 && ran.ran.length === 0 ? "empty" : "ran", scanned, code, { set, failures, notes, extra: { guardrails: chosen.length, cached: ran.cached, rules: ruleTimes, passes: passTimes, cachedRules: chosen.filter((g) => ruleTimes[g.id] === undefined).map((g) => g.id), ratchet: [baselineTotal(baseline), baselineTotal(wide.next)], ratchetFrom } });
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
