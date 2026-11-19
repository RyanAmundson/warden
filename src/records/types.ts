export type Kind = "lint" | "type" | "model" | "runtime" | "review" | "instruction" | "legacy";

export const KIND_LADDER: readonly (readonly Kind[])[] = [["type", "lint"], ["runtime"], ["model"], ["review"], ["instruction"], ["legacy"]];

export const kindRank = (kind: Kind): number => KIND_LADDER.findIndex((tier) => tier.includes(kind));
export type Tier = "edit" | "commit" | "boundary";

export interface Term {
  id: string;
  definition: string;
  bans: string[];
}

export type Example = string | Record<string, string>;

export interface Guardrail {
  id: string;
  kind: Kind;
  runs: Tier[];
  budgetMs: number;
  version: number;
  implementation: string;
  options?: unknown;
  mustFail?: Example;
  mustPass?: Example;
  packDir?: string;
}

export interface Practice {
  id: string;
  pack: string;
  statement: string;
  terms: string[];
  paths: string[];
  conflictsWith: string[];
  guardrails: Guardrail[];
}

export interface Pack {
  id: string;
  file: string;
  layer: number;
  terms: Term[];
  practices: Practice[];
}

export interface ProjectConfig {
  project: string;
  base: string;
  packs: { id: string; paths: string[] }[];
  tierBudgetMs: Record<Tier, number>;
  loopBreakerRepeats: number;
  bench?: Partial<BenchSettings>;
}

export interface BenchSettings {
  baseFiles: number;
  maxFiles: number;
  minMarginalMs: number;
  linearMax: number;
  sublinearMax: number;
  constantMs: number;
}

export const BENCH_DEFAULTS: BenchSettings = { baseFiles: 25, maxFiles: 3200, minMarginalMs: 20, linearMax: 1.15, sublinearMax: 0.9, constantMs: 5 };

export const benchSettings = (config: ProjectConfig): BenchSettings => ({ ...BENCH_DEFAULTS, ...config.bench });

export interface RecordSet {
  config: ProjectConfig;
  packs: Pack[];
  root: string;
}
