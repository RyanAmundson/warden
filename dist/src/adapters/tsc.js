import { statSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { PARSE_ERROR } from "./types.js";
const BASELINE = "baseline-errors";
const BASELINE_ID = `tsc:${BASELINE}`;
const CONFIG_PATH = ".warden/generated/tsconfig.json";
const DIAGNOSTIC = /^((.+)\((\d+),\d+\)): error TS(\d+): (.*)$/;
const FLAG_CODES = {
    strictNullChecks: [2531, 2532, 2533, 18047, 18048],
    noImplicitAny: [7005, 7006, 7031],
    noUnusedLocals: [6133, 6138, 6192, 6196, 6198, 6199],
    noUnusedParameters: [6133, 6198, 6205],
    noImplicitReturns: [7030],
    noFallthroughCasesInSwitch: [7029],
    noImplicitThis: [2683],
    noImplicitOverride: [4114, 4116],
    noPropertyAccessFromIndexSignature: [4111],
    exactOptionalPropertyTypes: [2375, 2379, 2412],
    strictPropertyInitialization: [2564],
    allowUnreachableCode: [7027],
    allowUnusedLabels: [7028],
};
const flagOf = (g) => g.implementation.slice(g.implementation.indexOf(":") + 1);
export const unmappedFlag = (g) => {
    if (!g.implementation.startsWith("tsc:"))
        return undefined;
    const flag = flagOf(g);
    return flag === BASELINE || flag in FLAG_CODES ? undefined : `tsc:${flag} has no known diagnostic codes, so its errors would count as tsc:${BASELINE}. Next action: change the implementation to one of ${Object.keys(FLAG_CODES).map((f) => `tsc:${f}`).join(", ")}, then run warden compile.`;
};
const emit = (gs, _set) => {
    const compilerOptions = { noEmit: true };
    for (const g of gs) {
        if (flagOf(g) !== BASELINE)
            compilerOptions[flagOf(g)] = g.options === undefined ? true : g.options;
    }
    const config = { extends: "../../tsconfig.json", compilerOptions };
    return { [CONFIG_PATH]: `${JSON.stringify(config, null, 2)}\n` };
};
const WORKER = new URL(`./tsc-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
let worker;
let busy = false;
const ask = (request, budgetMs) => new Promise((resolve, reject) => {
    if (busy)
        throw new Error("the tsc adapter checks one program at a time; await the previous run");
    busy = true;
    const w = (worker ??= new Worker(WORKER));
    const start = performance.now();
    const settle = (lost) => {
        clearTimeout(timer);
        w.off("message", onReply).off("error", onError).off("exit", onExit);
        busy = false;
        if (lost)
            worker = undefined;
        else
            w.unref();
        return performance.now() - start;
    };
    const onReply = (reply) => resolve({ reply, ms: settle(false) });
    const onError = (cause) => {
        settle(true);
        reject(new Error(`tsc ended with ${cause.message}`));
    };
    const onExit = (code) => {
        settle(true);
        reject(new Error(`tsc ended with exit code ${code}`));
    };
    const timer = budgetMs === undefined
        ? undefined
        : setTimeout(() => {
            const ms = settle(true);
            void w.terminate();
            resolve({ ms });
        }, budgetMs);
    w.ref();
    w.on("message", onReply).on("error", onError).on("exit", onExit);
    w.postMessage(request);
});
const run = async (gs, _files, ctx) => {
    const budgetMs = ctx.unbudgeted === true ? undefined : Math.min(...gs.map((g) => g.budgetMs));
    const project = join(relative(ctx.root, ctx.generatedDir), "tsconfig.json");
    const { reply, ms } = await ask({ cwd: ctx.root, project, parameterCodes: FLAG_CODES.noUnusedParameters }, budgetMs);
    const killed = reply === undefined;
    const stdout = reply?.stdout ?? "";
    const owners = new Map();
    for (const g of gs)
        for (const code of FLAG_CODES[flagOf(g)] ?? [])
            owners.set(`${code}${flagOf(g) === "noUnusedParameters" ? "p" : ""}`, g.id);
    const parameters = new Set(reply?.parameters ?? []);
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
            const code = Number(m[4]);
            const guardrail = code >= 1000 && code < 2000 ? PARSE_ERROR : (owners.get(`${code}${parameters.has(m[1]) ? "p" : ""}`) ?? baseline);
            if (!byGuardrail.has(guardrail))
                byGuardrail.set(guardrail, []);
            byGuardrail.get(guardrail).push({
                guardrail,
                file: m[2],
                line: Number(m[3]),
                message: `TS${m[4]}: ${m[5]}`,
            });
        }
    }
    const parsed = [...byGuardrail.values()].some((v) => v.length > 0);
    if (!killed && reply.code !== 0 && !parsed) {
        throw new Error(`tsc exited with ${reply.code} and printed no diagnostics`);
    }
    const size = { files: program.length, bytes: program.reduce((n, f) => n + statSync(f).size, 0) };
    return [...byGuardrail].map(([guardrail, violations]) => killed
        ? { guardrail, status: "killed", violations, ms, command: `npx tsc -p ${project} --pretty false` }
        : { guardrail, status: violations.length > 0 ? "fail" : "pass", violations, ms, ...size });
};
export const tscAdapter = { id: "tsc", emit, run };
