import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadRecords } from "../records/load.js";
import type { Capability } from "../records/types.js";
import { type ReviewAdapter, type ReviewScope, reviewAdapters } from "../review/adapter.js";
import { type Triage, exitCode, touchedLines, triage } from "../review/findings.js";

export interface ReviewOptions {
  capability: string;
  base: string;
  head: string;
  previousHead?: string;
  previous?: string;
  previousReport?: string;
  requirements: string[];
  report?: string;
  format: "text" | "json";
}

const FLAGS: [keyof ReviewOptions, string][] = [["capability", "--capability <id>"], ["base", "--base <ref>"], ["head", "--head <ref>"]];

export function reviewOptions(sub: "brief" | "triage", raw: Partial<ReviewOptions>): ReviewOptions {
  const missing = FLAGS.filter(([k]) => raw[k] === undefined).map(([, f]) => f);
  if (sub === "brief" && (raw.requirements ?? []).length === 0) missing.push("--requirements <paths...>");
  if (sub === "triage" && raw.report === undefined) missing.push("--report <file>");
  if (missing.length > 0) throw new Error(`warden review ${sub} needs ${missing.join(", ")}. Next action: run warden review ${sub} again with ${missing.join(", ")}`);
  if (raw.previous !== undefined && raw.previousReport !== undefined) throw new Error("--previous and --previous-report both give the previous findings. Next action: run the command again with only one of them");
  if (sub === "triage" && raw.previousHead !== undefined && raw.previousReport === undefined) throw new Error("--previous-head needs --previous-report. Next action: run the command again with --previous-report <file>, the previous round's report");
  if ((raw.previous !== undefined || raw.previousReport !== undefined) && raw.previousHead === undefined) throw new Error("--previous and --previous-report need --previous-head. Next action: run the command again with --previous-head <ref>, the head the previous review covered");
  return { requirements: [], format: "text", ...raw } as ReviewOptions;
}

const resolveRef = (root: string, ref: string): string => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (cause) {
    if (typeof (cause as { status?: unknown }).status !== "number") throw new Error("git is not available. Next action: install git and put it on PATH, then run the command again");
    throw new Error(`${ref} is not a commit. Next action: run git fetch origin ${ref}, then run the command again`);
  }
};

const readFile = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path} cannot be read. Next action: save the reviewer's report to ${path}, then run the command again`);
  }
};

const quote = (v: string): string => (/^[\w./@%+=:,-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`);

interface Rerun {
  head: string;
  previousHead?: string | undefined;
  previousReport?: string | undefined;
}

const briefLine = (o: ReviewOptions, base: string, r: Rerun): string =>
  [
    `warden review brief --capability ${o.capability} --base ${base} --head ${r.head}`,
    ...(r.previousHead === undefined ? [] : [`--previous-head ${r.previousHead}`]),
    ...(r.previousReport === undefined ? [] : [`--previous-report ${quote(r.previousReport)}`]),
    `--requirements ${o.requirements.map(quote).join(" ")}`,
  ].join(" ");

async function prepare(root: string, wardenRoot: string, o: ReviewOptions) {
  const set = await loadRecords(root, wardenRoot);
  const capabilities = set.packs.flatMap((p) => p.capabilities);
  const capability = capabilities.find((c) => c.id === o.capability && c.review !== undefined) as (Capability & { review: NonNullable<Capability["review"]> }) | undefined;
  const base = resolveRef(root, o.base);
  const head = resolveRef(root, o.head);
  if (capability === undefined) {
    const ids = capabilities.filter((c) => c.review !== undefined).map((c) => c.id);
    const why = capabilities.some((c) => c.id === o.capability) ? `Capability ${o.capability} has no review block` : `no Capability has id ${o.capability}`;
    if (ids.length === 0) throw new Error(`${why}. Next action: add a review block to a Capability in a pack, then run warden compile`);
    if (o.requirements.length === 0) throw new Error(`${why}. Next action: run the command again with --capability ${ids[0]} and --requirements <paths...>`);
    throw new Error(`${why}. Next action: run ${briefLine({ ...o, capability: ids[0]! }, base, { head, previousHead: o.previousHead, previousReport: o.previousReport })}`);
  }
  const adapter = reviewAdapters.get(capability.review.adapter);
  if (adapter === undefined) throw new Error(`no review adapter has id ${capability.review.adapter}. Next action: set the review adapter of Capability ${capability.id} to one of ${[...reviewAdapters.keys()].join(", ")}, then run warden compile`);
  const practices = set.packs.flatMap((p) => p.practices);
  const previousHead = o.previousHead === undefined ? undefined : resolveRef(root, o.previousHead);
  const scope: ReviewScope = {
    base,
    head,
    requirements: o.requirements,
    upholds: capability.upholds.map((id) => ({ id, statement: practices.find((p) => p.id === id)?.statement ?? id })),
    ...(previousHead === undefined ? {} : { previousHead }),
  };
  return { capability, adapter, scope, previousHead };
}

const sameShape = (f: unknown): boolean => typeof f === "object" && f !== null && typeof (f as { n?: unknown }).n === "number" && typeof (f as { title?: unknown }).title === "string";

const previousFindings = (adapter: ReviewAdapter, scope: ReviewScope, head: string, report: string): NonNullable<ReviewScope["previous"]> => {
  const earlier = { ...scope, head };
  const normalized = adapter.normalize(readFile(report), earlier);
  if (normalized.reviewedHead !== head || normalized.findings.some(({ severity, flaky }) => severity === "environment" || flaky)) {
    throw new Error(`${report} does not contain a completed review of ${head}. Next action: pass --previous-report with a completed review of ${head}.`);
  }
  return normalized.findings;
};

export async function runBrief(root: string, wardenRoot: string, o: ReviewOptions): Promise<number> {
  const { capability, adapter, scope, previousHead } = await prepare(root, wardenRoot, o);
  if (o.previous !== undefined) {
    const text = readFile(o.previous);
    try {
      const findings = (JSON.parse(text) as Triage).findings;
      if (!Array.isArray(findings) || !findings.every(sameShape)) throw new Error("shape");
      scope.previous = findings;
    } catch {
      throw new Error(`${o.previous} is not a triage result. Next action: save the reviewer's triage --format json output to ${o.previous}, then run the command again`);
    }
  }
  if (o.previousReport !== undefined) {
    scope.previous = previousFindings(adapter, scope, previousHead as string, o.previousReport);
  }
  process.stdout.write(`${JSON.stringify(adapter.invocation(capability.review, scope), null, 2)}\n`);
  return 0;
}

const label = (f: Triage["findings"][number]): string => (f.blocks ? "BLOCK" : f.kind === "env" ? "ENV" : f.kind === "flake" ? "RERUN" : "TASK");

export async function runTriage(root: string, wardenRoot: string, o: ReviewOptions): Promise<number> {
  const { adapter, scope, previousHead } = await prepare(root, wardenRoot, o);
  if (previousHead !== undefined && o.previousReport !== undefined) {
    scope.previous = previousFindings(adapter, scope, previousHead, o.previousReport);
  }
  const normalized = adapter.normalize(readFile(o.report as string), scope);
  const touched = touchedLines(root, previousHead ?? scope.base, scope.head);
  const round = previousHead === undefined ? 1 : 2;
  const retry = briefLine(o, scope.base, { head: scope.head, previousHead, previousReport: o.previousReport });
  const afterFix = briefLine(o, scope.base, { head: "HEAD", previousHead: scope.head, previousReport: o.report });
  const result = triage(normalized.findings, touched, round, retry, afterFix);
  if (result.verdict !== "pass" && o.requirements.length === 0) throw new Error("the rerun command needs the requirements. Next action: run warden review triage again with --requirements <paths...>");
  if (o.format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const f of result.findings) process.stdout.write(`${label(f)} ${f.n} ${f.kind} ${f.file === undefined ? "-" : `${f.file}${f.line === undefined ? "" : `:${f.line}`}`}  ${f.title}\n`);
    if (result.next !== null) process.stdout.write(`Next action: ${result.next}\n`);
  }
  return exitCode(result);
}
