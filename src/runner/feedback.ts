import { PARSE_ERROR, type Violation } from "../adapters/types.js";
import type { Guardrail, Practice, RecordSet } from "../records/types.js";
import type { Tamper } from "./tamper.js";

export type Format = "text" | "agent" | "json";

export interface Repeated {
  guardrail: string;
  file: string;
  n: number;
}

export interface OverBudget {
  guardrail: string;
  ms: number;
}

export interface Killed extends OverBudget {
  command: string;
}

export interface Notes {
  tampered?: Tamper[];
  repeated?: Repeated;
  overBudget?: OverBudget[];
  killed?: Killed[];
  unstaged?: string[];
}

const EXAMPLE_LINES = 15;

const ownerOf = (set: RecordSet, id: string): { practice: Practice; guardrail: Guardrail } | undefined => {
  for (const practice of set.packs.flatMap((p) => p.practices)) {
    const guardrail = practice.guardrails.find((g) => g.id === id);
    if (guardrail !== undefined) return { practice, guardrail };
  }
  return undefined;
};

const byLocation = (a: Violation, b: Violation): number => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

const nextAction = (failures: Violation[], set: RecordSet, notes: Notes): string | null => {
  if (notes.tampered?.some((t) => t.detail === "base-moved") === true) {
    return "revert the base change in .warden/config.yaml and run warden compile.";
  }
  if (notes.tampered !== undefined && notes.tampered.length > 0) {
    return `revert your change to ${[...new Set(notes.tampered.map((t) => t.file))].join(", ")}.`;
  }
  if ((notes.unstaged ?? []).length > 0) return "stage or discard unstaged changes, then run warden check again.";
  const parse = failures.filter((v) => v.guardrail === PARSE_ERROR).sort(byLocation)[0];
  if (parse !== undefined) return `fix the syntax error at ${parse.file}:${parse.line}.`;
  if (notes.repeated !== undefined) {
    return "stop editing this file; in your reply, name the rule and file, quote its Do this line, and say why it does not fit; then continue with other work.";
  }
  const located = failures.filter((v) => v.file !== "");
  const legacy = failures.find((v) => v.file === "" && ownerOf(set, v.guardrail)?.guardrail.implementation.startsWith("cmd:") === true);
  if (located.length === 0 && legacy !== undefined) {
    const { implementation } = (ownerOf(set, legacy.guardrail) as { guardrail: Guardrail }).guardrail;
    return `run \`${implementation.slice(implementation.indexOf(":") + 1)}\` and fix what it reports.`;
  }
  if (failures.length > 0) {
    return 'change the code at the lines above to match "Do this". Do not edit .warden/ or generated config; that is recorded as tampering.';
  }
  const killed = notes.killed?.[0];
  if (killed !== undefined) return `run \`${killed.command}\` directly to see why it does not finish.`;
  if ((notes.overBudget ?? []).length > 0) return "continue your task; nothing in your code failed.";
  return null;
};

const indent = (text: string): string => text.split("\n").join(`\n${" ".repeat(12)}`);

export function formatFeedback(failures: Violation[], set: RecordSet, format: Format, notes: Notes = {}): string {
  const items = [...failures]
    .sort(byLocation)
    .map((v) => {
      const owner = ownerOf(set, v.guardrail);
      const example = owner?.guardrail.mustPass?.replace(/\n+$/, "").split("\n").slice(0, EXAMPLE_LINES).join("\n");
      return {
        file: v.file,
        line: v.line,
        guardrail: v.guardrail,
        practice: owner?.practice.id ?? v.guardrail,
        rule: owner?.practice.statement ?? v.message,
        message: v.message,
        doThis: v.doThis ?? example,
        why: owner === undefined ? undefined : `warden explain ${owner.practice.id}`,
      };
    });
  const timing = (label: string, list: OverBudget[], reason: (ms: number, budget: string) => string) =>
    list.map(({ guardrail, ms }) => {
      const owner = ownerOf(set, guardrail);
      return {
        label,
        guardrail,
        practice: owner?.practice.id ?? guardrail,
        rule: owner?.practice.statement,
        reason: reason(Math.round(ms), owner === undefined ? "its" : `its ${owner.guardrail.budgetMs} ms`),
        why: owner === undefined ? undefined : `warden explain ${owner.practice.id}`,
      };
    });
  const slow = [
    ...timing("FAIL project", notes.killed ?? [], (ms, budget) => `stopped at ${ms} ms: did not finish within ${budget} budget`),
    ...timing("WARDEN DEFECT", notes.overBudget ?? [], (ms, budget) => `finished in ${ms} ms, over ${budget} budget; its result counted and the overrun is recorded as a Warden defect`),
  ];
  const next = nextAction(failures, set, notes);
  const tampered = notes.tampered ?? [];
  if (format === "json") {
    return JSON.stringify({ failures: items, tampered, unstaged: notes.unstaged, repeated: notes.repeated, overBudget: notes.overBudget, killed: notes.killed, next });
  }

  const lines: string[] = tampered.map((t) => `TAMPERED ${t.file}  ${t.detail}`);
  lines.push(...(notes.unstaged ?? []).map((f) => `UNSTAGED ${f}  the commit tier judges what you stage; this working copy differs from the index`));
  for (const item of items) {
    lines.push(`FAIL ${item.file === "" ? "project" : `${item.file}:${item.line}`}  ${item.practice}`);
    lines.push(`  Rule:     ${item.rule}`);
    if (item.file === "") lines.push(`  Output:   ${indent(item.message)}`);
    if (item.doThis !== undefined) lines.push(`  Do this:  ${indent(item.doThis)}`);
    if (item.why !== undefined) lines.push(`  Why:      ${item.why}`);
  }
  for (const item of slow) {
    lines.push(`${item.label}  ${item.practice}`);
    if (item.rule !== undefined) lines.push(`  Rule:     ${item.rule}`);
    lines.push(`  Reason:   ${item.reason}`);
    if (item.why !== undefined) lines.push(`  Why:      ${item.why}`);
  }
  if (notes.repeated !== undefined) {
    lines.push(`Same failure ${notes.repeated.n} times: ${notes.repeated.guardrail} in ${notes.repeated.file}.`);
  }
  if (next !== null) lines.push(`Next action: ${next}`);
  return lines.join("\n");
}
