import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { RecordError } from "../records/load.js";
import { targetOf } from "./pack-code.js";
import { GENERATED_TSCONFIG } from "./tsc-config.js";
import { PARSE_ERROR } from "./types.js";
const BASELINE = "baseline-errors";
const BASELINE_ID = `tsc:${BASELINE}`;
const DIAGNOSTIC = /^((.+)\((\d+),\d+\)): error TS(\d+): (.*)$/;
const OPTIONS_DIAGNOSTIC = /^error TS(\d+): (.*)$/;
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
const PREREQUISITES = { exactOptionalPropertyTypes: ["strictNullChecks"] };
export const unmappedFlag = (g) => {
    if (!g.implementation.startsWith("tsc:"))
        return undefined;
    const flag = targetOf(g);
    return flag === BASELINE || flag in FLAG_CODES ? undefined : `tsc:${flag} has no known diagnostic codes, so its errors would count as tsc:${BASELINE}. Next action: change the implementation to one of ${Object.keys(FLAG_CODES).map((f) => `tsc:${f}`).join(", ")}, then run warden compile.`;
};
const emit = (gs, _set) => {
    const compilerOptions = { noEmit: true };
    for (const g of gs) {
        if (targetOf(g) !== BASELINE)
            compilerOptions[targetOf(g)] = g.options === undefined ? true : g.options;
    }
    for (const flag of Object.keys(compilerOptions)) {
        if (compilerOptions[flag])
            for (const prerequisite of PREREQUISITES[flag] ?? [])
                compilerOptions[prerequisite] ??= true;
    }
    const config = { extends: "../../tsconfig.json", compilerOptions };
    return { [GENERATED_TSCONFIG]: `${JSON.stringify(config, null, 2)}\n` };
};
const WORKER = new URL(`./tsc-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
let worker;
let busy = false;
const ask = (request, budgetMs, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    if (busy)
        throw new Error("the tsc adapter checks one program at a time; await the previous run");
    busy = true;
    const w = (worker ??= new Worker(WORKER));
    const start = performance.now();
    const settle = (lost) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
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
    const onAbort = () => {
        settle(true);
        void w.terminate();
        reject(signal?.reason);
    };
    const timer = budgetMs === undefined
        ? undefined
        : setTimeout(() => {
            const ms = settle(true);
            void w.terminate();
            resolve({ ms });
        }, budgetMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    w.ref();
    w.on("message", onReply).on("error", onError).on("exit", onExit);
    w.postMessage(request);
});
const run = async (gs, _files, ctx) => {
    const budgetMs = ctx.unbudgeted === true ? undefined : Math.min(...gs.map((g) => g.budgetMs));
    const project = join(relative(ctx.root, ctx.generatedDir), "tsconfig.json");
    const { reply, ms } = await ask({ cwd: ctx.root, project, parameterCodes: FLAG_CODES.noUnusedParameters, lockedConfig: ctx.lockedTscConfig }, budgetMs, ctx.signal);
    if (reply?.configError !== undefined)
        throw new RecordError(reply.configError.file, "", reply.configError.message);
    const killed = reply === undefined;
    const stdout = reply?.stdout ?? "";
    const owners = new Map();
    for (const g of gs)
        for (const code of FLAG_CODES[targetOf(g)] ?? [])
            owners.set(`${code}${targetOf(g) === "noUnusedParameters" ? "p" : ""}`, g.id);
    const parameters = new Set(reply?.parameters ?? []);
    const baseline = gs.find((g) => targetOf(g) === BASELINE)?.id ?? BASELINE_ID;
    const byGuardrail = new Map([[baseline, []], ...gs.map((g) => [g.id, []])]);
    const program = [];
    const optionsError = (line, m) => {
        const bare = m === null ? OPTIONS_DIAGNOSTIC.exec(line) : null;
        if (bare === null && (m === null || !m[2].endsWith(".json")))
            return undefined;
        const [at, code, text] = bare === null ? [` at ${m[1]}`, m[4], m[5]] : ["", bare[1], bare[2]];
        const refusal = `tsc refused the compiler options${at}: TS${code}: ${text}`;
        if (m !== null && m[2] === project) {
            const key = /"([^"]+)"\s*:/.exec(readFileSync(join(ctx.root, project), "utf8").split("\n")[Number(m[3]) - 1] ?? "")?.[1] ?? "";
            const related = (flag) => flag === key || (PREREQUISITES[flag] ?? []).includes(key) || (PREREQUISITES[key] ?? []).includes(flag);
            const guilty = gs.filter((g) => g.options !== undefined && related(targetOf(g)));
            if (guilty.length > 0) {
                const names = guilty.map((g) => `${g.id} (${g.implementation} options ${JSON.stringify(g.options)})`).join(", ");
                return new RecordError(join(ctx.root, project), `/compilerOptions/${key}`, `${refusal} The Guardrail options of ${names} produce it. Next action: change or remove the options of ${guilty.map((g) => g.id).join(", ")} so tsc accepts them, then run warden compile and warden check again.`);
            }
        }
        const tsconfig = m === null || m[2] === project ? join(ctx.root, "tsconfig.json") : resolve(ctx.root, m[2]);
        return new RecordError(tsconfig, "/compilerOptions", `${refusal} Next action: change compilerOptions in ${tsconfig} so tsc accepts them, then run warden check again.`);
    };
    if (!killed) {
        let refused;
        for (const line of stdout.split("\n")) {
            if (line.trim() === "" || /^\s/.test(line))
                continue;
            const m = DIAGNOSTIC.exec(line);
            const syntax = m !== null && Number(m[4]) >= 1000 && Number(m[4]) < 2000;
            if (syntax && m[2]?.endsWith(".json")) {
                const config = resolve(ctx.root, m[2]);
                throw new RecordError(config, "", `tsc could not parse the configuration at ${m[1]}: TS${m[4]}: ${m[5]}. Next action: fix the syntax in ${config}:${m[3]}, then run warden check again.`);
            }
            const option = optionsError(line, m);
            if (option !== undefined) {
                refused ??= option;
                continue;
            }
            if (m === null && isAbsolute(line)) {
                program.push(line);
                continue;
            }
            if (m === null)
                throw new Error(`tsc printed an unparsable line: ${line}`);
            const code = Number(m[4]);
            const guardrail = syntax ? PARSE_ERROR : (owners.get(`${code}${parameters.has(m[1]) ? "p" : ""}`) ?? baseline);
            if (!byGuardrail.has(guardrail))
                byGuardrail.set(guardrail, []);
            byGuardrail.get(guardrail).push({
                guardrail,
                file: m[2],
                line: Number(m[3]),
                message: `TS${m[4]}: ${m[5]}`,
            });
        }
        if (refused !== undefined)
            throw refused;
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
