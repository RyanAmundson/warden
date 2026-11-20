import type { Guardrail, RecordSet, Term, UnitKind } from "../records/types.js";
import type { LockedTscConfig } from "./tsc-config.js";
import type { Unit } from "../records/units.js";

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
  members: string[];
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
  files?: number;
  bytes?: number;
  ruleMs?: number;
  inputShas?: ReadonlyMap<string, string>;
  judgedFiles?: ReadonlyMap<string, string>;
}

export interface RunContext {
  root: string;
  generatedDir: string;
  unbudgeted?: boolean;
  base?: string;
  settingsOf?: (g: Guardrail) => Record<string, unknown> | undefined;
  signal?: AbortSignal;
  captureLintSource?: boolean;
  lockedTscConfig?: LockedTscConfig;
  projectInventory?: { nonRegular: string[]; discoveryMs: number };
  unitStructure?: { units: (Unit & { kindRecord: UnitKind })[]; ignoreCase: boolean; termDefinitions?: Pick<Term, "id" | "definition">[] };
  onGroup?: (adapter: string, guardrails: string[]) => void;
}

export interface Adapter {
  id: string;
  wholeTree?: boolean;
  emit(gs: Guardrail[], set: RecordSet): Record<string, string>;
  run(gs: Guardrail[], files: string[], ctx: RunContext): Promise<RunResult[]>;
}

export const PARSE_ERROR = "warden:parse-error";
