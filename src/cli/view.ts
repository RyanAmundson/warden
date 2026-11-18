import { type FSWatcher, existsSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { wardenVersion } from "../compiler/compile.js";
import { bundledTools } from "../compiler/lock.js";
import { RecordError, loadRecords } from "../records/load.js";
import type { Tier } from "../records/types.js";
import { type Evidence, type Step, readEvidence } from "../runner/evidence.js";
import { buildReport } from "./report.js";
import { clock, firstFailure, runRecords, target, visible } from "./runs.js";

export interface RuleRow {
  guardrail: string;
  strength: string;
  fired: number;
  median: string;
  budgetMs: number;
}

export interface ViewModel {
  project: string;
  base: string;
  version: string;
  packs: string[];
  tools: Record<string, string>;
  rules: RuleRow[];
  evidence: Evidence[];
  now: number;
  budgets: Record<Tier, number>;
}

export async function loadView(root: string, wardenRoot: string): Promise<ViewModel> {
  if (!existsSync(join(root, ".warden/config.yaml"))) throw new RecordError(".warden/config.yaml", "", ".warden/config.yaml not found. Next action: run warden init");
  const set = await loadRecords(root, wardenRoot);
  const report = await buildReport(root, wardenRoot);
  const budget = new Map(set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.map((g) => [g.id, g.budgetMs] as const))));
  return {
    project: set.config.project,
    base: set.config.base,
    version: await wardenVersion(wardenRoot),
    packs: set.config.packs.map((p) => p.id),
    tools: bundledTools(),
    rules: report.guardrails.map((g) => ({ guardrail: g.guardrail, strength: g.strength, fired: g.fired, median: g.costShared === undefined ? `${g.medianMs ?? 0} ms` : "shared", budgetMs: budget.get(g.guardrail) ?? 0 })),
    evidence: readEvidence(set.config.project),
    now: Date.now(),
    budgets: set.config.tierBudgetMs,
  };
}

export interface Size {
  cols: number;
  rows: number;
}

interface Shown {
  record?: Evidence;
  steps: Evidence[];
  interrupted?: boolean;
}

const STEPS: { step: Step; done: string; running: string }[] = [
  { step: "rules-intact", done: "rules intact", running: "checking rules" },
  { step: "tools-ready", done: "tools ready", running: "checking tools" },
  { step: "rules", done: "rules", running: "running rules" },
  { step: "verdict", done: "verdict", running: "deciding" },
];

const TRIGGER: Record<string, string> = { "agent-edit": "agent edit", "git-commit": "git commit", manual: "manual run" };

const SHORT: Record<string, string> = { "agent-edit": "edit", "git-commit": "commit", manual: "manual" };

const BAR = 16;

const clip = (raw: string, width: number): string => {
  const line = visible(raw);
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
};

const spread = (left: string, right: string, width: number): string => {
  if (right === "") return clip(left, width);
  const room = width - right.length - 1;
  if (room < 1) return clip(left, width);
  return `${clip(left, room).padEnd(room)} ${right}`;
};

const wrap = (text: string, width: number, most: number): string[] => {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(lines.length === 0 ? word : ` ${word}`);
  }
  const kept = lines.slice(0, most);
  if (lines.length > most) kept[most - 1] = `${kept[most - 1] as string}…`;
  return kept.map((l) => clip(l, width));
};

const count = (n: number): string => n.toLocaleString("en-US");

const stepLines = (shown: Shown | undefined, tools: Record<string, string>, width: number): string[] => {
  const all = shown?.steps ?? [];
  const finished = STEPS.filter(({ step }) => {
    const last = all.filter((e) => e.step === step).at(-1);
    return last !== undefined && last.state !== "start";
  }).length;
  return STEPS.map(({ step, done, running }, i) => {
    const events = all.filter((e) => e.step === step);
    const last = events.at(-1);
    const n = i + 1;
    if (last === undefined) return `   ○ ${n} ${done}`;
    const members = [...new Set(events.flatMap((e) => e.members ?? []))].join(" · ");
    if (last.state === "start" && shown?.interrupted === true) {
      return spread(`   ✗ ${n} ${done.padEnd(18)}${members}`, "interrupted", width);
    }
    if (last.state === "start") {
      const bar = "█".repeat(Math.round((finished / STEPS.length) * BAR)).padEnd(BAR, "░");
      return spread(`   ● ${n} ${running.padEnd(18)}${step === "rules" ? `${bar}  ${members}` : ""}`, "...", width);
    }
    const failed = events.some((e) => e.state === "fail");
    const ms = events.filter((e) => e.state !== "start").reduce((sum, e) => sum + (e.ms ?? 0), 0);
    const cached = events.some((e) => e.status === "cached") && step === "tools-ready";
    const detail = (() => {
      if (step === "rules-intact") return failed ? "records or generated config changed outside warden compile" : "lock matches, 0 tampered files";
      if (step === "tools-ready") return failed ? "a bundled tool or a cmd Guardrail's command is missing" : Object.entries(tools).filter(([name]) => name !== "typescript-eslint").map(([name, v]) => `${name} ${v}`).join(" · ");
      if (step === "rules") return members === "" ? (last.status === "empty" ? "no changed files" : "every result cached") : members;
      const first = shown?.record === undefined ? "" : firstFailure(shown.record);
      return failed ? `BLOCK  ${first}`.trimEnd() : "pass";
    })();
    return spread(`   ${failed ? "✗" : "✓"} ${n} ${done.padEnd(18)}${detail}`, cached ? "cached" : `${Math.round(ms)} ms`, width);
  });
};

const verdictCell = (e: Evidence): string => {
  if (e.outcome === "ran" && e.result === "pass") return `✓ pass   ${Math.round(e.ms ?? 0)} ms`;
  if (e.outcome === "ran" && e.result === "fail") {
    const f = e.failures?.[0];
    return `✗ BLOCK  ${f === undefined ? "" : `${f.practice} ${f.file === "" ? "project" : `L${f.line}`}`}`.trimEnd();
  }
  if (e.outcome === "tampered") return "✗ TAMPERED";
  if (e.outcome === "unstaged") return "✗ unstaged";
  if (e.outcome === "error") return "✗ error";
  if (e.outcome === "empty") return "· no changes";
  return `· ${e.outcome ?? ""}`;
};

const footer = (shown: Shown | undefined, live: boolean): string => {
  if (shown?.interrupted === true) return " Next action: press r to run warden check";
  if (live) return " Running warden check…";
  const record = shown?.record;
  if (record === undefined) return " Next action: press r to run warden check";
  if (record.next !== undefined) return ` Next action: ${record.next}`;
  if (record.result === "pass") return " The last run passed; nothing to do.";
  if (record.outcome === "empty") return " The last run found no changed files; nothing to do.";
  return " This run was recorded without a result.";
};

export const liveDeadline = (model: ViewModel): number | undefined => {
  const lastStep = model.evidence.filter((e) => e.kind === "step").at(-1);
  if (lastStep === undefined || runRecords(model.evidence).some((r) => r.run === lastStep.run)) return undefined;
  const tier = model.evidence.find((e) => e.kind === "step" && e.run === lastStep.run && e.tier !== undefined)?.tier ?? "commit";
  const at = Date.parse(lastStep.at) + model.budgets[tier];
  return at >= model.now ? at : undefined;
};

export function render(model: ViewModel, size: Size, selected: number): string[] {
  const width = Math.max(20, size.cols);
  const rule = "─".repeat(width);
  const runs = runRecords(model.evidence).reverse();
  const stepsOf = (run: string | undefined): Evidence[] => model.evidence.filter((e) => e.kind === "step" && e.run === run);
  const lastStep = model.evidence.filter((e) => e.kind === "step").at(-1);
  const liveRun = lastStep !== undefined && !runs.some((r) => r.run === lastStep.run) ? lastStep.run : undefined;
  const liveSteps = stepsOf(liveRun);
  const interrupted = liveRun !== undefined && liveDeadline(model) === undefined;
  const pick = Math.min(Math.max(0, selected), Math.max(0, runs.length - 1));
  const live = liveRun !== undefined && selected === 0;
  const record = live ? undefined : runs[pick];
  const shown: Shown | undefined = live ? { steps: liveSteps, interrupted } : record === undefined ? undefined : { record, steps: stepsOf(record.run) };
  const head = (() => {
    if (shown === undefined) return " NOW  idle · no check has run in this project yet";
    const first = shown.steps[0];
    const tier = shown.record?.tier ?? first?.tier ?? "";
    const trigger = shown.record?.trigger ?? first?.trigger;
    const where = shown.record === undefined ? shown.steps.find((e) => e.files !== undefined) : shown.record;
    return [` NOW  ${tier === "" ? "" : `${tier} `}check`, ...(where === undefined ? [] : [target(where)]), ...(trigger === undefined ? [] : [`triggered by ${TRIGGER[trigger] ?? trigger}`]), ...(shown.interrupted === true ? ["interrupted"] : [])].join(" · ");
  })();
  const top = [spread(` WARDEN  ${model.project} · base ${model.base} · v${model.version}`, "q quit  r rerun  ↑↓ runs", width), rule, clip(head, width), ...stepLines(shown, model.tools, width), ""];
  const bottom = [rule, ...wrap(footer(shown, live), width, 3)];
  const room = Math.max(0, size.rows - top.length - bottom.length - 3);
  const ruleRows = Math.min(model.rules.length, Math.ceil(room / 2));
  const runRows = Math.max(0, room - ruleRows);
  const packs = ` RULES (${model.packs.join(", ")} pack${model.packs.length === 1 ? "" : "s"})`;
  const rules = [
    spread(packs, `${"strength".padStart(8)} ${"fired".padStart(7)} ${"median".padStart(8)} ${"budget".padStart(9)}`, width),
    ...model.rules.slice(0, ruleRows).map((r) => spread(`   ${r.guardrail}`, `${r.strength.padStart(8)} ${String(r.fired).padStart(7)} ${r.median.padStart(8)} ${`${r.budgetMs} ms`.padStart(9)}`, width)),
  ];
  const start = Math.max(0, Math.min(pick - runRows + 1, runs.length - runRows));
  const recent = [
    spread(" RECENT RUNS", "ratchet left", width),
    ...runs.slice(start, start + runRows).map((e, i) => {
      const mark = !live && start + i === pick ? ">" : " ";
      const ratchet = e.ratchet === undefined ? "" : `${count(e.ratchet[0])} → ${count(e.ratchet[1])}`;
      const trigger = SHORT[e.trigger ?? ""] ?? e.trigger ?? "-";
      return spread(` ${mark} ${clock(e.at)}  ${trigger.padEnd(6)}  ${basename(target(e)).padEnd(18)} ${verdictCell(e)}`, ratchet, width);
    }),
  ];
  const middle = size.rows - top.length - bottom.length >= 3 ? [...rules, "", ...recent] : [];
  return [...top, ...middle, ...bottom].slice(0, Math.max(size.rows, 2)).map((l) => l.trimEnd());
}

export const plainView = (model: ViewModel): string => `${render(model, { cols: 80, rows: 40 }, 0).join("\n")}\n`;

export const ENTER = "\x1b[?1049h\x1b[?25l";

export const LEAVE = "\x1b[?25h\x1b[?1049l";

const HOME = "\x1b[H\x1b[2J";

export interface ViewInput {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
  setRawMode?(on: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface ViewOutput {
  columns?: number;
  rows?: number;
  write(chunk: string): boolean;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface ViewIo {
  input: ViewInput;
  output: ViewOutput;
  watchDir: string;
  file: string;
  load: () => Promise<ViewModel>;
  rerun: () => void;
}

export function liveView(io: ViewIo): Promise<number> {
  return new Promise((resolve, reject) => {
    let model: ViewModel | undefined;
    let selected = 0;
    let closed = false;
    let watcher: FSWatcher | undefined;
    let timer: NodeJS.Timeout | undefined;
    const restore = (): void => {
      if (closed) return;
      closed = true;
      watcher?.close();
      clearTimeout(timer);
      io.output.off("resize", draw);
      io.input.off("data", key);
      process.off("exit", restore);
      process.off("SIGTERM", quit);
      process.off("SIGHUP", quit);
      io.input.setRawMode?.(false);
      io.input.pause();
      io.output.write(LEAVE);
    };
    const fail = (cause: unknown): void => {
      restore();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const quit = (): void => {
      restore();
      resolve(0);
    };
    function draw(): void {
      if (closed || model === undefined) return;
      try {
        const lines = render(model, { cols: io.output.columns || 80, rows: io.output.rows || 24 }, selected);
        io.output.write(`${HOME}${lines.join("\n")}`);
      } catch (cause) {
        fail(cause);
      }
    }
    let loading = false;
    let again = false;
    const refresh = (): void => {
      if (loading) {
        again = true;
        return;
      }
      loading = true;
      io.load().then(
        (next) => {
          loading = false;
          if (again) {
            again = false;
            refresh();
            return;
          }
          model = next;
          draw();
          schedule();
        },
        fail,
      );
    };
    const schedule = (): void => {
      clearTimeout(timer);
      const at = model === undefined ? undefined : liveDeadline(model);
      if (at !== undefined) timer = setTimeout(refresh, Math.max(0, at - Date.now()) + 1);
    };
    function key(chunk: Buffer): void {
      const k = chunk.toString("utf8");
      if (k === "q" || k === "\x03") return quit();
      if (k === "r") return io.rerun();
      const runs = model === undefined ? 0 : runRecords(model.evidence).length;
      if (k === "\x1b[A") selected = Math.max(0, selected - 1);
      else if (k === "\x1b[B") selected = Math.min(Math.max(0, runs - 1), selected + 1);
      else return;
      draw();
    }
    process.once("exit", restore);
    process.once("SIGTERM", quit);
    process.once("SIGHUP", quit);
    io.output.write(ENTER);
    io.input.setRawMode?.(true);
    io.input.resume();
    io.input.on("data", key);
    io.output.on("resize", draw);
    try {
      watcher = watch(io.watchDir, (_event, filename) => {
        if (filename === null || filename === io.file) refresh();
      });
    } catch (cause) {
      fail(cause);
      return;
    }
    refresh();
  });
}
