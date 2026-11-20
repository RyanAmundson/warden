import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import { wardenHome } from "../runner/evidence.js";
const roundId = (number, entry) => `${number}:${sha256(canonicalJson(JSON.parse(JSON.stringify(entry))))}`;
const seriesPath = (key) => join(wardenHome(), "review", sha256(canonicalJson([key.repository, key.series, key.target, key.capability])));
const roundPath = (directory, number) => join(directory, `round-${number}.json`);
const readRound = (directory, number) => {
    const path = roundPath(directory, number);
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return undefined;
        throw cause;
    }
    try {
        const round = JSON.parse(text);
        if (round.schema !== 1 || round.number !== number || round.input === undefined ||
            round.result === undefined || round.id !== roundId(number, { input: round.input, result: round.result })) {
            throw new Error("invalid round");
        }
        return round;
    }
    catch {
        throw new Error(`Invalid review round at ${path}. Next action: restore the recorded round from backup.`);
    }
};
export function getRound(key, id) {
    const match = /^([1-9]\d*):[a-f0-9]{64}$/.exec(id);
    const number = Number(match?.[1]);
    const round = Number.isSafeInteger(number) ? readRound(seriesPath(key), number) : undefined;
    if (round?.id !== id)
        throw new Error(`No completed round ${id} in series ${key.series}. Next action: run warden review history for this series to find its completed rounds.`);
    return round;
}
export function listRounds(key) {
    const directory = seriesPath(key);
    const rounds = [];
    for (let number = 1;; number++) {
        const round = readRound(directory, number);
        if (round === undefined)
            return rounds;
        rounds.push(round);
    }
}
export function recordRound(entry, previous) {
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
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = mkdtempSync(join(directory, ".pending-"));
    const candidate = join(temp, "round.json");
    const round = { schema: 1, id, number, recordedAt: new Date().toISOString(), ...entry };
    try {
        writeFileSync(candidate, `${JSON.stringify(round, null, 2)}\n`, { mode: 0o600, flush: true });
        linkSync(candidate, roundPath(directory, number));
        return round;
    }
    catch (cause) {
        if (cause.code !== "EEXIST")
            throw cause;
        const recorded = readRound(directory, number);
        if (recorded?.id === id)
            return recorded;
        throw new Error(`Review series ${input.series} already has a different round ${number}. Next action: run warden review history for this series and use its latest completed round ID.`);
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
export function reviewSignals(round, previous) {
    const earlier = previous?.result.findings ?? [];
    const current = round.result.findings;
    const repeated = [...new Set(current.map((finding) => finding.kind))].flatMap((kind) => {
        const numbers = earlier.filter((finding) => finding.kind === kind).map((finding) => finding.n);
        return numbers.length === 0 ? [] : [{ kind, previous: numbers, current: current.filter((finding) => finding.kind === kind).map((finding) => finding.n) }];
    });
    const limit = round.input.settings.roundLimit;
    const blocking = current.filter((finding) => finding.blocks).map((finding) => finding.n);
    return {
        repeated,
        escalation: limit !== undefined && round.number >= limit && blocking.length > 0 ? { limit, blocking } : null,
    };
}
