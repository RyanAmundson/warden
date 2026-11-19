import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { spawnBudgeted } from "./cmd.js";
import { PARSE_ERROR } from "./types.js";
const BASELINE = "baseline-errors";
const BASELINE_ID = `tsc:${BASELINE}`;
const CONFIG_PATH = ".warden/generated/tsconfig.json";
const DIAGNOSTIC = /^(.+)\((\d+),\d+\): error TS(\d+): (.*)$/;
const FLAG_CODES = {
    strictNullChecks: [2531, 2532, 2533, 18047, 18048],
    noImplicitAny: [7005, 7006, 7031],
};
const flagOf = (g) => g.implementation.slice(g.implementation.indexOf(":") + 1);
const emit = (gs, _set) => {
    const compilerOptions = { noEmit: true };
    for (const g of gs) {
        if (flagOf(g) !== BASELINE)
            compilerOptions[flagOf(g)] = g.options === undefined ? true : g.options;
    }
    const config = { extends: "../../tsconfig.json", compilerOptions };
    return { [CONFIG_PATH]: `${JSON.stringify(config, null, 2)}\n` };
};
const run = async (gs, _files, ctx) => {
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
    const budgetMs = ctx.unbudgeted === true ? undefined : Math.min(...gs.map((g) => g.budgetMs));
    const project = join(relative(ctx.root, ctx.generatedDir), "tsconfig.json");
    const { stdout, stderr, code, signal, killed, ms } = await spawnBudgeted(process.execPath, [tsc, "-p", project, "--pretty", "false", "--listFiles"], ctx.root, budgetMs, false, ctx.signal);
    if (!killed && (signal !== null || (code !== 0 && code !== 1 && code !== 2))) {
        throw new Error(`tsc ended with ${signal ?? `exit code ${code}`}: ${stderr.trim()}`);
    }
    const owners = new Map();
    for (const g of gs)
        for (const code of FLAG_CODES[flagOf(g)] ?? [])
            owners.set(code, g.id);
    const baseline = gs.find((g) => flagOf(g) === BASELINE)?.id ?? BASELINE_ID;
    const byGuardrail = new Map([[baseline, []], ...gs.map((g) => [g.id, []])]);
    const program = [];
    if (!killed) {
        for (const line of stdout.split("\n")) {
            if (line.trim() === "" || /^\s/.test(line))
                continue;
            const m = DIAGNOSTIC.exec(line);
            if (m === null && isAbsolute(line)) {
                program.push(line);
                continue;
            }
            if (m === null)
                throw new Error(`tsc printed an unparsable line: ${line}`);
            const code = Number(m[3]);
            const guardrail = code >= 1000 && code < 2000 ? PARSE_ERROR : (owners.get(code) ?? baseline);
            if (!byGuardrail.has(guardrail))
                byGuardrail.set(guardrail, []);
            byGuardrail.get(guardrail).push({
                guardrail,
                file: m[1],
                line: Number(m[2]),
                message: `TS${m[3]}: ${m[4]}`,
            });
        }
    }
    const parsed = [...byGuardrail.values()].some((v) => v.length > 0);
    if (!killed && code !== 0 && !parsed) {
        throw new Error(`tsc exited with ${code} and printed no diagnostics: ${stderr.trim()}`);
    }
    const size = { files: program.length, bytes: program.reduce((n, f) => n + statSync(f).size, 0) };
    return [...byGuardrail].map(([guardrail, violations]) => killed
        ? { guardrail, status: "killed", violations, ms, command: `npx tsc -p ${project} --pretty false` }
        : { guardrail, status: violations.length > 0 ? "fail" : "pass", violations, ms, ...size });
};
export const tscAdapter = { id: "tsc", emit, run };
