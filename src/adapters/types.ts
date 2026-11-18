import type { Guardrail, RecordSet } from "../records/types.js";

export interface Violation {
  guardrail: string;
  file: string;
  line: number;
  message: string;
}

export interface RunResult {
  guardrail: string;
  status: "pass" | "fail" | "over-budget";
  violations: Violation[];
  ms: number;
}

export interface RunContext {
  root: string;
  generatedDir: string;
}

export interface Adapter {
  id: string;
  emit(gs: Guardrail[], set: RecordSet): Record<string, string>;
  run(gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]>;
}
