import type { Guardrail, RecordSet } from "../records/types.js";

export interface Violation {
  guardrail: string;
  file: string;
  line: number;
  endLine?: number;
  message: string;
  doThis?: string;
}

export interface SharedPass {
  id: string;
  guardrails: number;
  budgetMs?: number;
}

export interface RunResult {
  guardrail: string;
  status: "pass" | "fail" | "killed";
  violations: Violation[];
  ms: number;
  overBudget?: boolean;
  command?: string;
  shared?: SharedPass;
}

export interface RunContext {
  root: string;
  generatedDir: string;
  unbudgeted?: boolean;
}

export interface Adapter {
  id: string;
  emit(gs: Guardrail[], set: RecordSet): Record<string, string>;
  run(gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]>;
}

export const PARSE_ERROR = "warden:parse-error";
