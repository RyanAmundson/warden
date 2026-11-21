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
  scope?: "project";
  benchmark?: "fixed-input";
  unitExample?: { folder: string; kind: UnitKind; publicEntry?: string };
  sources?: string[];
  mustFail?: Example;
  mutations?: Record<string, Example>;
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

export interface ReviewRule {
  adapter: string;
  model: string;
  roundLimit?: number;
}

export interface Capability {
  id: string;
  kind: "skill" | "tool";
  serves: string;
  purpose: string;
  when: string;
  upholds: string[];
  commands: string[];
  replaces: (string | { command: string })[];
  review?: ReviewRule;
  pack: string;
}

export interface Pack {
  id: string;
  file: string;
  layer: number;
  terms: Term[];
  practices: Practice[];
  capabilities: Capability[];
  settings?: Record<string, unknown>;
}

export interface UnitDeclaration {
  id: string;
  kind: string;
  folder: string;
  term?: string;
  publicEntry?: string;
}

export interface UnitKind {
  document: string;
  sections: string[];
  layout?: string[];
}

export interface ProjectConfig {
  project: string;
  base: string;
  packs: { id: string; paths: string[]; settings?: Record<string, unknown> }[];
  unitKinds?: Record<string, UnitKind>;
  units?: UnitDeclaration[];
  tierBudgetMs: Record<Tier, number>;
  loopBreakerRepeats: number;
  bench?: Partial<BenchSettings>;
  learning?: { repeatFindings?: number; removalRuns?: number };
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
  unitIgnoreCase?: boolean;
}
