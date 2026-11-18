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
  warden: string;
  project: string;
  base: string;
  packs: { id: string; paths: string[] }[];
  tierBudgetMs: Record<Tier, number>;
  loopBreakerRepeats: number;
}

export interface RecordSet {
  config: ProjectConfig;
  packs: Pack[];
  root: string;
}
