import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PARSE_ERROR, type RunContext, type RunResult, type Violation } from "../adapters/types.js";
import { wardenVersion } from "../compiler/compile.js";
import { LOCK_PATH, canonicalJson, sha256 } from "../compiler/lock.js";
import { RecordError, loadRecords, parseConfig } from "../records/load.js";
import type { Guardrail, RecordSet, Tier } from "../records/types.js";
import { applyBaseline, carryRenames, readBaseline, writeBaseline } from "../runner/baseline.js";
import { cacheKey, readCache, writeCache } from "../runner/cache.js";
import { changedFiles, changesSinceMergeBase, lastCommittedText, showAtMergeBase, verifyBase } from "../runner/changed.js";
import { appendEvidence, readEvidence } from "../runner/evidence.js";
import { type Format, type Notes, type Repeated, formatFeedback } from "../runner/feedback.js";
import { runGuardrails } from "../runner/run.js";
import { type Tamper, findTampering } from "../runner/tamper.js";

export interface CheckOptions {
  root: string;
  wardenRoot: string;
  paths?: string[];
  rule?: string;
  tier?: Tier;
  format: Format;
  hook?: "claude";
}

const selectGuardrails = (set: RecordSet, rule: string | undefined): Guardrail[] => {
  const gs = set.packs.flatMap((p) =>
    p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction" && (rule === undefined || g.id === rule || x.id === rule))),
  );
  if (rule !== undefined && gs.length === 0) throw new RecordError("", "/rule", `no Practice or Guardrail has id "${rule}"`);
  return gs;
};

const removedWarden = (root: string): { set: RecordSet; tamper: Tamper } | undefined => {
  if (existsSync(join(root, ".warden"))) return undefined;
  const text = lastCommittedText(root, ".warden/config.yaml");
  if (text === undefined) return undefined;
  const config = parseConfig(".warden/config.yaml", text);
  verifyBase(root, config.base);
  if (showAtMergeBase(root, config.base, LOCK_PATH) === undefined) return undefined;
  return { set: { config, packs: [], root }, tamper: { file: ".warden", detail: "removed" } };
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
  gs: Guardrail[],
  scanned: string[],
  shas: Map<string, string>,
  ctx: RunContext,
  project: string,
  run: { lockSha: string; warden: string },
): Promise<{ perFile: RunResult[]; wholeProject: RunResult[]; ran: RunResult[] }> => {
  if (scanned.length === 0) return { perFile: [], wholeProject: [], ran: [] };
  const lint = gs.filter((g) => g.kind === "lint");
  const rest = gs.filter((g) => g.kind !== "lint");
  const keyOf = (f: string, g: Guardrail): string => cacheKey(f, shas.get(f) as string, g, run.lockSha, run.warden);
  const hits = new Map<string, Violation[]>();
  const misses = new Set<string>();
  for (const g of lint) {
    for (const f of scanned) {
      const cached = readCache(project, keyOf(f, g));
      if (cached === undefined) misses.add(f);
      else hits.set(keyOf(f, g), cached);
    }
  }
  const fresh = misses.size > 0 ? await runGuardrails(lint, [...misses], ctx) : [];
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
    return { guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms: r?.ms ?? 0, overBudget: r?.overBudget === true };
  });
  const others = rest.length > 0 ? await runGuardrails(rest, scanned, ctx) : [];
  return { perFile: [...results, ...parse], wholeProject: others, ran: [...fresh, ...others] };
};

const report = (failures: Violation[], set: RecordSet, opts: CheckOptions, notes: Notes): number => {
  const failed = failures.length > 0 || (notes.tampered ?? []).length > 0 || (notes.killed ?? []).length > 0;
  if (opts.hook === "claude") {
    if (failed) process.stdout.write(`${JSON.stringify({ decision: "block", reason: formatFeedback(failures, set, "agent", notes) })}\n`);
    return 0;
  }
  if (failed || opts.format === "json" || (notes.overBudget ?? []).length > 0) {
    process.stdout.write(`${formatFeedback(failures, set, opts.format, notes)}\n`);
  }
  return failed ? 1 : 0;
};

const check = async (opts: CheckOptions): Promise<number> => {
  const root = resolve(opts.root);
  const at = new Date().toISOString();
  const removed = removedWarden(root);
  if (removed !== undefined) {
    appendEvidence(removed.set.config.project, { at, kind: "tampered", file: removed.tamper.file, detail: removed.tamper.detail });
    return report([], removed.set, opts, { tampered: [removed.tamper] });
  }
  if (!existsSync(join(root, ".warden/config.yaml"))) {
    throw new RecordError(".warden/config.yaml", "", "not found. Next action: run warden init.");
  }
  const set = await loadRecords(root, opts.wardenRoot);
  const { project, base, loopBreakerRepeats } = set.config;
  verifyBase(root, base);
  if (!existsSync(join(root, LOCK_PATH)) && showAtMergeBase(root, base, LOCK_PATH) === undefined) {
    throw new RecordError(LOCK_PATH, "", "not found; this project was never compiled. Next action: run warden compile.");
  }

  const tampered = await findTampering(set, opts.wardenRoot, base);
  if (tampered.length > 0) {
    for (const t of tampered) appendEvidence(project, { at, kind: "tampered", file: t.file, detail: t.detail, guardrail: t.guardrail });
    return report([], set, opts, { tampered });
  }

  const tier: Tier = opts.hook === "claude" ? "edit" : (opts.tier ?? "commit");
  const known = new Set(selectGuardrails(set, undefined).map((g) => g.id));
  const chosen = selectGuardrails(set, opts.rule).filter((g) => g.runs.includes(tier));
  const selected = new Set(chosen.map((g) => g.id));
  const lintChosen = chosen.some((g) => g.kind === "lint");
  const guardrails = selectGuardrails(set, undefined).filter((g) => (lintChosen && g.kind === "lint") || selected.has(g.id));
  const scanned = scannedFiles(root, base, opts.paths);
  const shas = new Map(scanned.map((f) => [f, sha256(readFileSync(join(root, f)))]));
  const ctx = { root, generatedDir: join(root, ".warden/generated") };
  const lockSha = sha256(readFileSync(join(root, LOCK_PATH)));
  const run = await runCached(guardrails, scanned, shas, ctx, project, { lockSha, warden: await wardenVersion(opts.wardenRoot) });
  const wanted = (r: RunResult): boolean => selected.has(r.guardrail) || !known.has(r.guardrail);
  const perFile = run.perFile.filter(wanted);
  const wholeProject = run.wholeProject.filter(wanted);
  const overBudget = [...perFile, ...wholeProject].filter((r) => r.overBudget === true).map((r) => ({ guardrail: r.guardrail, ms: r.ms }));
  const killed = [...perFile, ...wholeProject]
    .filter((r) => r.status === "killed")
    .map((r) => ({ guardrail: r.guardrail, ms: r.ms, command: r.command as string }));

  const exists = (f: string): boolean => existsSync(join(root, f));
  const changes = changesSinceMergeBase(root, base);
  const touched = (v: Violation): boolean => {
    const lines = changes.lines.get(v.file);
    return lines === "all" || lines?.has(v.line) === true;
  };
  const baseline = readBaseline(root);
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
  if (canonicalJson(wide.next) !== canonicalJson(baseline)) writeBaseline(root, wide.next);

  for (const r of run.ran) {
    appendEvidence(project, { at, kind: "cost", guardrail: r.guardrail, status: r.overBudget === true ? "over-budget" : r.status, ms: r.ms });
  }
  const prior = readEvidence(project);
  let repeated: Repeated | undefined;
  for (const key of new Set(failures.map((v) => `${v.guardrail}\0${v.file}`))) {
    const [guardrail, file] = key.split("\0") as [string, string];
    const detail = shas.get(file) ?? (file !== "" && exists(file) ? sha256(readFileSync(join(root, file))) : "");
    const n =
      prior.filter((e) => e.kind === "fired" && e.status === "fail" && e.guardrail === guardrail && e.file === file && e.detail === detail).length + 1;
    appendEvidence(project, { at, kind: "fired", guardrail, file, status: "fail", detail });
    if (n >= loopBreakerRepeats && (repeated === undefined || n > repeated.n)) repeated = { guardrail, file, n };
  }
  return report(failures, set, opts, { repeated, overBudget, killed });
};

export async function runCheck(opts: CheckOptions): Promise<number> {
  try {
    return await check(opts);
  } catch (cause) {
    if (!(cause instanceof RecordError)) throw cause;
    process.stderr.write(`${cause.file} ${cause.pointer}: ${cause.message}\n`);
    return 2;
  }
}
