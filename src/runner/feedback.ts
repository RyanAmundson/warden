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

export interface Notes {
  tampered?: Tamper[];
  repeated?: Repeated;
  overBudget?: OverBudget[];
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

const nextAction = (failures: Violation[], notes: Notes): string | null => {
  if (notes.tampered !== undefined && notes.tampered.length > 0) {
    return `revert your change to ${[...new Set(notes.tampered.map((t) => t.file))].join(", ")}.`;
  }
  const parse = failures.filter((v) => v.guardrail === PARSE_ERROR).sort(byLocation)[0];
  if (parse !== undefined) return `fix the syntax error at ${parse.file}:${parse.line}.`;
  if (notes.repeated !== undefined) {
    const { guardrail, file, n } = notes.repeated;
    return `this failure repeated ${n} times. Rewrite the code to follow "Do this", or file warden dispute ${guardrail} ${file} listing the approaches you tried. Stopping without either is recorded as stalled.`;
  }
  if (failures.length > 0) {
    return 'change the code at the lines above to match "Do this". Do not edit .warden/ or generated config; that is recorded as tampering.';
  }
  const slow = notes.overBudget?.[0];
  if (slow !== undefined) {
    return `${slow.guardrail} exceeded its time budget; this is recorded as a Warden defect, not a problem in your code. Re-run warden check once; if it repeats, continue your task and report it.`;
  }
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
        doThis: example,
        why: owner === undefined ? undefined : `warden explain ${owner.practice.id}`,
      };
    });
  const slow = (notes.overBudget ?? []).map(({ guardrail, ms }) => {
    const owner = ownerOf(set, guardrail);
    const limit = owner === undefined ? "" : ` > ${owner.guardrail.budgetMs} ms`;
    return {
      guardrail,
      practice: owner?.practice.id ?? guardrail,
      rule: owner?.practice.statement,
      reason: `over budget (${Math.round(ms)} ms${limit})`,
      why: owner === undefined ? undefined : `warden explain ${owner.practice.id}`,
    };
  });
  const next = nextAction(failures, notes);
  const tampered = notes.tampered ?? [];
  if (format === "json") {
    return JSON.stringify({ failures: items, tampered, repeated: notes.repeated, overBudget: notes.overBudget, next });
  }

  const lines: string[] = tampered.map((t) => `TAMPERED ${t.file}  ${t.detail}`);
  for (const item of items) {
    lines.push(`FAIL ${item.file === "" ? "project" : `${item.file}:${item.line}`}  ${item.practice}`);
    lines.push(`  Rule:     ${item.rule}`);
    if (item.doThis !== undefined) lines.push(`  Do this:  ${indent(item.doThis)}`);
    if (item.why !== undefined) lines.push(`  Why:      ${item.why}`);
  }
  for (const item of slow) {
    lines.push(`FAIL project  ${item.practice}`);
    if (item.rule !== undefined) lines.push(`  Rule:     ${item.rule}`);
    lines.push(`  Reason:   ${item.reason}`);
    if (item.why !== undefined) lines.push(`  Why:      ${item.why}`);
  }
  if (notes.repeated !== undefined) {
    lines.push(`Same failure ${notes.repeated.n} times: fix the code to match the compliant example.`);
  }
  if (next !== null) lines.push(`Next action: ${next}`);
  return lines.join("\n");
}
