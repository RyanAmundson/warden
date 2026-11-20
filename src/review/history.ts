import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import type { ReviewRule } from "../records/types.js";
import { linkRecord, wardenHome } from "../runner/evidence.js";
import type { Kind, ReviewFinding } from "./findings.js";

export interface ReviewSeries {
  repository: string;
  series: string;
  target: string;
  capability: string;
}

interface ReviewInputs extends ReviewSeries {
  previous: string | null;
  base: string;
  head: string;
  warden: string;
  settings: ReviewRule;
  upholds: { id: string; statement: string }[];
  requirements: { path: string; sha256: string }[];
  report: { sha256: string; text: string };
  pullRequest?: string;
  component?: string;
}

interface ReviewResult {
  verdict: "pass" | "fail";
  findings: ReviewFinding[];
}

interface ReviewEntry {
  input: ReviewInputs;
  result: ReviewResult;
}

export interface ReviewRound extends ReviewEntry {
  schema: 1;
  id: string;
  number: number;
  recordedAt: string;
}

const roundId = (number: number, entry: ReviewEntry): string =>
  `${number}:${sha256(canonicalJson(JSON.parse(JSON.stringify(entry))))}`;

const seriesPath = (key: ReviewSeries): string =>
  join(wardenHome(), "review", sha256(canonicalJson([key.repository, key.series, key.target, key.capability])));

const roundPath = (directory: string, number: number): string => join(directory, `round-${number}.json`);

const readRound = (directory: string, number: number, repository?: string): ReviewRound | undefined => {
  const path = roundPath(directory, number);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    if (repository === undefined) return undefined;
    throw new Error(`Missing review round at ${path}. Next action: restore the recorded round from backup.`);
  }
  try {
    const round = JSON.parse(text) as ReviewRound;
    if (repository !== undefined) {
      if (typeof round.input?.repository !== "string" || seriesPath(round.input) !== directory) throw new Error("invalid series");
      if (round.input.repository !== repository) return undefined;
    }
    if (round.schema !== 1 || round.number !== number || round.input === undefined ||
        round.result === undefined || round.id !== roundId(number, { input: round.input, result: round.result })) {
      throw new Error("invalid round");
    }
    return round;
  } catch {
    throw new Error(`Invalid review round at ${path}. Next action: restore the recorded round from backup.`);
  }
};

export function getRound(key: ReviewSeries, id: string): ReviewRound {
  const match = /^([1-9]\d*):[a-f0-9]{64}$/.exec(id);
  const number = Number(match?.[1]);
  const round = Number.isSafeInteger(number) ? readRound(seriesPath(key), number) : undefined;
  if (round?.id !== id) throw new Error(`No completed round ${id} in series ${key.series}. Next action: run warden review history for this series to find its completed rounds.`);
  return round;
}

export function listRounds(key: ReviewSeries): ReviewRound[] {
  const directory = seriesPath(key);
  const rounds: ReviewRound[] = [];
  for (let number = 1; ; number++) {
    const round = readRound(directory, number);
    if (round === undefined) return rounds;
    rounds.push(round);
  }
}

const ownerPath = (directory: string): string => join(directory, "owner.json");

function readSeriesOwner(directory: string): ReviewSeries | Error | undefined {
  const path = ownerPath(directory);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const owner = JSON.parse(text) as ReviewSeries;
    if ([owner.repository, owner.series, owner.target, owner.capability].every((part) => typeof part === "string") &&
        seriesPath(owner) === directory) return owner;
    throw new Error("invalid series ownership");
  } catch {
    return new Error(`Invalid review series owner at ${path}. Next action: restore the series owner from backup.`);
  }
}

export function listRepositoryEscapeRounds(repository: string): ReviewRound[] {
  const root = join(wardenHome(), "review");
  let directories: string[];
  try {
    directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }

  const rounds: ReviewRound[] = [];
  for (const name of directories) {
    const directory = join(root, name);
    const numbers = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => Number(/^escape-([1-9]\d*)$/.exec(entry.name)?.[1]))
      .filter(Number.isSafeInteger)
      .sort((left, right) => left - right);
    if (numbers.length === 0) continue;
    const owner = readSeriesOwner(directory);
    if (owner !== undefined && !(owner instanceof Error) && owner.repository !== repository) continue;
    for (const number of numbers) {
      const round = readRound(directory, number, repository);
      if (round === undefined) continue;
      if (owner instanceof Error) throw owner;
      rounds.push(round);
    }
  }
  return rounds;
}

function recordSeriesOwner(directory: string, { repository, series, target, capability }: ReviewSeries): void {
  const owner = readSeriesOwner(directory);
  if (owner instanceof Error) throw owner;
  if (owner !== undefined) return;
  try {
    linkRecord(ownerPath(directory), { repository, series, target, capability });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const recorded = readSeriesOwner(directory);
    if (recorded instanceof Error) throw recorded;
    if (recorded === undefined) throw cause;
  }
}

export function recordRound(entry: ReviewEntry, previous: ReviewRound | undefined): ReturnType<typeof reviewState> {
  const { input } = entry;
  const number = (previous?.number ?? 0) + 1;
  const directory = seriesPath(input);
  const id = roundId(number, entry);
  for (let prior = 1; prior < number; prior++) {
    const round = readRound(directory, prior);
    if (round?.input.report.sha256 === input.report.sha256) {
      throw new Error(`This report already belongs to round ${round.id}. Next action: use that round's ID or submit a new report.`);
    }
  }
  const round: ReviewRound = { schema: 1, id, number, recordedAt: new Date().toISOString(), ...entry };
  try {
    linkRecord(roundPath(directory, number), round);
    return { round, rulings: [], active: round.result.findings };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const recorded = readRound(directory, number);
    if (recorded?.id === id) return reviewState(recorded);
    throw new Error(`Review series ${input.series} already has a different round ${number}. Next action: run warden review history for this series and use its latest completed round ID.`);
  }
}

export interface ReviewRulingInput {
  finding: number;
  role: "independent-reviewer" | "repository-owner";
  actor: string;
  reason: string;
  evidence: string;
}

interface ReviewRuling extends ReviewRulingInput {
  round: string;
  ruledAt: string;
}

const rulingPath = (directory: string, round: ReviewRound, finding: number): string =>
  join(directory, `error-${round.number}-${finding}.json`);

const readRuling = (directory: string, round: ReviewRound, finding: number): ReviewRuling | undefined => {
  const path = rulingPath(directory, round, finding);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const ruling = JSON.parse(text) as ReviewRuling;
    if (ruling.round === round.id && ruling.finding === finding &&
        (ruling.role === "independent-reviewer" || ruling.role === "repository-owner") &&
        [ruling.actor, ruling.reason, ruling.evidence, ruling.ruledAt].every((value) => typeof value === "string" && value.trim() !== "")) return ruling;
    throw new Error("invalid ruling");
  } catch {
    throw new Error(`Invalid review ruling at ${path}. Next action: restore the recorded ruling from backup.`);
  }
};

export function recordReviewerError(round: ReviewRound, input: ReviewRulingInput): ReviewRuling {
  const directory = seriesPath(round.input);
  const ruling = { ...input, round: round.id, ruledAt: new Date().toISOString() };
  try {
    linkRecord(rulingPath(directory, round, input.finding), ruling);
    return ruling;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const prior = readRuling(directory, round, input.finding);
    if (prior?.role === input.role && prior.actor === input.actor && prior.reason === input.reason && prior.evidence === input.evidence) return prior;
    throw new Error(`Finding ${input.finding} already has a different ruling. Next action: run warden review history for this series to inspect it.`);
  }
}

interface ReviewEscape extends ReviewRulingInput {
  kind: "escaped";
  round: string;
  head: string;
  practice: string;
  confirmedAt: string;
}

const escapeKey = (finding: number, practice: string): string =>
  `${sha256(canonicalJson([finding, practice]))}.json`;

const escapeDirectory = (directory: string, round: ReviewRound): string => join(directory, `escape-${round.number}`);

const readEscape = (directory: string, name: string, round: ReviewRound): ReviewEscape => {
  const path = join(directory, name);
  const source = readFileSync(path, "utf8");
  try {
    const escape = JSON.parse(source) as ReviewEscape;
    if (escape.kind === "escaped" && escape.round === round.id && escape.head === round.input.head &&
        typeof escape.practice === "string" && escape.practice.length > 0 &&
        round.result.findings.some(({ n }) => n === escape.finding) && escapeKey(escape.finding, escape.practice) === name &&
        (escape.role === "independent-reviewer" || escape.role === "repository-owner") &&
        [escape.actor, escape.reason, escape.evidence, escape.confirmedAt].every((value) =>
          typeof value === "string" && value.trim() !== "")) return escape;
    throw new Error("invalid confirmation");
  } catch {
    throw new Error(`Invalid review confirmation at ${path}. Next action: restore the confirmation from backup.`);
  }
};

const listEscapes = (directory: string, round: ReviewRound): ReviewEscape[] => {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
  return names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort().map((name) => readEscape(directory, name, round));
};

export function recordEscape(round: ReviewRound, input: ReviewRulingInput & { practice: string }): ReviewEscape {
  const series = seriesPath(round.input);
  if (readRuling(series, round, input.finding) !== undefined) {
    throw new Error(`Finding ${input.finding} has a reviewer-error ruling. Next action: run warden review history for this series to inspect it.`);
  }
  recordSeriesOwner(series, round.input);
  const directory = escapeDirectory(series, round);
  const name = escapeKey(input.finding, input.practice);
  const escape: ReviewEscape = { ...input, kind: "escaped", round: round.id, head: round.input.head, confirmedAt: new Date().toISOString() };
  try {
    linkRecord(join(directory, name), escape);
    return escape;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    return readEscape(directory, name, round);
  }
}

export function reviewState(round: ReviewRound) {
  const directory = seriesPath(round.input);
  const rulings = round.result.findings.flatMap(({ n }) => readRuling(directory, round, n) ?? []);
  const errors = new Set(rulings.map(({ finding }) => finding));
  return { round, rulings, active: round.result.findings.filter(({ n }) => !errors.has(n)) };
}

export function reviewHistoryState(round: ReviewRound) {
  const escapes = listEscapes(escapeDirectory(seriesPath(round.input), round), round);
  const state = reviewState(round);
  const numbers = new Set(state.active.map(({ n }) => n));
  return { ...state, escapes: escapes.filter(({ finding }) => numbers.has(finding)) };
}

interface RepeatedKind {
  kind: Kind;
  previous: number[];
  current: number[];
}

export function reviewSignals(state: ReturnType<typeof reviewState>, previous: ReturnType<typeof reviewState> | undefined) {
  const { round, rulings, active: current } = state;
  const earlier = previous?.active ?? [];
  const repeated: RepeatedKind[] = [...new Set(current.map((finding) => finding.kind))].flatMap((kind) => {
    const numbers = earlier.filter((finding) => finding.kind === kind).map((finding) => finding.n);
    return numbers.length === 0 ? [] : [{ kind, previous: numbers, current: current.filter((finding) => finding.kind === kind).map((finding) => finding.n) }];
  });
  const limit = round.input.settings.roundLimit;
  const blocking = current.filter((finding) => finding.blocks).map((finding) => finding.n);
  return {
    reviewerErrors: rulings,
    repeated,
    escalation: limit !== undefined && round.number >= limit && blocking.length > 0 ? { limit, blocking } : null,
  };
}
