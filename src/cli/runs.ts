import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RecordError, loadRecords } from "../records/load.js";
import { type Evidence, RUN_TOTAL, readEvidence, wardenHome } from "../runner/evidence.js";
import { type Report, buildReport } from "./report.js";

export interface RunsOptions {
  limit: number;
  format: "text" | "json";
  html?: string;
  follow?: boolean;
  signal?: AbortSignal;
}

export const visible = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export const runRecords = (evidence: Evidence[]): Evidence[] => evidence.filter((e) => e.kind === "cost" && e.guardrail === RUN_TOTAL && e.outcome !== undefined);

export const clock = (at: string): string => new Date(at).toTimeString().slice(0, 8);

export const target = (e: Evidence): string => e.file ?? `${e.files ?? 0} file${e.files === 1 ? "" : "s"}`;

export const verdictOf = (e: Evidence): string => e.result ?? (e.outcome === "ran" ? "no result recorded" : (e.outcome ?? ""));

export const NOT_RECORDED = "rules not recorded (older Warden)";

export const ruleParts = (e: Evidence): string[] | undefined => {
  if (e.rules === undefined) return undefined;
  const ms = (n: number): string => `${Math.round(n)} ms`;
  return [
    ...Object.entries(e.rules).map(([id, n]) => `${id} ${ms(n)}`),
    ...Object.entries(e.passes ?? {}).map(([id, n]) => `${id} pass ${ms(n)}`),
    ...((e.cachedRules ?? []).length === 0 ? [] : [`${(e.cachedRules as string[]).length} cached`]),
  ];
};

export const ruleTimes = (e: Evidence): string => ruleParts(e)?.join(" · ") ?? NOT_RECORDED;

export const firstFailure = (e: Evidence): string => {
  const f = e.failures?.[0];
  return f === undefined ? "" : `${f.file === "" ? "project" : `${f.file}:${f.line}`} ${f.guardrail}`;
};

const COLUMNS = ["time", "trigger", "tier", "files", "rules", "cached", "result", "ms", "first failure", "rule times"];

const cells = (e: Evidence): string[] => [
  clock(e.at),
  e.trigger ?? "-",
  e.tier ?? "-",
  target(e),
  e.guardrails === undefined ? "-" : String(e.guardrails),
  e.cached === undefined ? "-" : String(e.cached),
  verdictOf(e),
  String(Math.round(e.ms ?? 0)),
  firstFailure(e) === "" ? "-" : firstFailure(e),
  ruleTimes(e),
];

const WIDTHS = [8, 10, 8, 24, 5, 6, 8, 6, 36, 0];

const row = (values: string[]): string => values.map(visible).map((v, i) => (WIDTHS[i] === 0 ? v : v.padEnd(WIDTHS[i] as number))).join("  ").trimEnd();

const escape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const page = (project: string, runs: Evidence[], report: Report): string => {
  const timeline = [...runs]
    .reverse()
    .map((e) => `<tr class="${escape(verdictOf(e))}">${[e.at.replace("T", " ").slice(0, 19), e.trigger ?? "-", e.tier ?? "-", target(e), verdictOf(e), `${Math.round(e.ms ?? 0)} ms`, (e.commit ?? "").slice(0, 7), ruleTimes(e), e.next ?? ""].map((c) => `<td>${escape(c)}</td>`).join("")}</tr>`)
    .join("\n");
  const practices = report.practices
    .map((p) => {
      const rails = p.guardrails.map((id) => {
        const g = report.guardrails.find((x) => x.guardrail === id);
        return `<li>${escape(id)} <span>${escape(g?.kind ?? "")} · ${escape(g?.strength ?? "")} · fired ${g?.fired ?? 0}</span></li>`;
      });
      return `<section><h3>${escape(p.practice)} <span>strongest ${escape(p.strongestKind)}${p.promote ? " · promote" : ""}</span></h3><ul>${rails.join("")}</ul></section>`;
    })
    .join("\n");
  const failures = [...runs]
    .reverse()
    .flatMap((e) => (e.failures ?? []).map((f) => ({ e, f })))
    .map(({ e, f }) => `<div class="failure"><b>${escape(f.file === "" ? "project" : `${f.file}:${f.line}`)}</b> ${escape(f.practice)} <span>${escape(clock(e.at))}</span>${f.doThis === undefined ? "" : `<pre>Do this: ${escape(f.doThis)}</pre>`}</div>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Warden runs</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1d1d1f; --muted: #6e6e73; --pass: #1a7f37; --fail: #cf222e; --line: #d0d7de; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --pass: #3fb950; --fail: #f85149; --line: #30363d; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.5 ui-monospace, Menlo, monospace; margin: 0 auto; max-width: 1100px; padding: 16px; }
table { border-collapse: collapse; width: 100%; } td, th { border-bottom: 1px solid var(--line); padding: 4px 8px; text-align: left; }
tr.pass td:nth-child(5) { color: var(--pass); } tr.fail td:nth-child(5), tr.tampered td:nth-child(5), tr.error td:nth-child(5) { color: var(--fail); }
span { color: var(--muted); } pre { margin: 4px 0 0; white-space: pre-wrap; } .failure { border-left: 3px solid var(--fail); margin: 8px 0; padding-left: 8px; }
.scroll { overflow-x: auto; }
</style></head><body>
<h1>Warden runs · ${escape(project)}</h1>
<h2>Run timeline</h2>
<div class="scroll"><table><tr><th>time</th><th>trigger</th><th>tier</th><th>files</th><th>result</th><th>ms</th><th>commit</th><th>rule times</th><th>next action</th></tr>
${timeline}
</table></div>
<h2>Practices</h2>
${practices}
<h2>Failures</h2>
${failures === "" ? "<p>No failures in these runs.</p>" : failures}
</body></html>
`;
};

export async function runRuns(root: string, wardenRoot: string, opts: RunsOptions): Promise<number> {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new RecordError("", "/limit", "--limit must be a whole number above 0. Next action: run warden runs --limit 20");
  if (!existsSync(join(root, ".warden/config.yaml"))) throw new RecordError(".warden/config.yaml", "", ".warden/config.yaml not found. Next action: run warden init");
  const set = await loadRecords(root, wardenRoot);
  const { project } = set.config;
  const all = runRecords(readEvidence(project));
  const runs = all.slice(-opts.limit);
  if (opts.html !== undefined) {
    const file = resolve(opts.html);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, page(project, runs, await buildReport(root, wardenRoot)));
    process.stdout.write(`${file}\n`);
    return 0;
  }
  if (opts.format === "json") {
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${[row(COLUMNS), ...runs.map((e) => row(cells(e)))].join("\n")}\n`);
  if (opts.follow !== true) return 0;
  const seen = new Set(all.map((e) => e.run));
  const dir = join(wardenHome(), "evidence");
  mkdirSync(dir, { recursive: true });
  const scan = (): void => {
    for (const e of runRecords(readEvidence(project))) {
      if (seen.has(e.run)) continue;
      seen.add(e.run);
      process.stdout.write(`${row(cells(e))}\n`);
    }
  };
  if (opts.signal?.aborted === true) return 0;
  const watcher = watch(dir, (_event, filename) => {
    if (filename === null || filename === `${project}.jsonl`) scan();
  });
  try {
    scan();
    await new Promise<void>((done) => opts.signal?.addEventListener("abort", () => done(), { once: true }));
  } finally {
    watcher.close();
  }
  return 0;
}
