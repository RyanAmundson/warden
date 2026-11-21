import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import { RecordError } from "../records/load.js";
import { linkRecord, wardenHome } from "../runner/evidence.js";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_INPUTS = 8;
const MAX_BYTES = 16_384;
const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const relativePath = (path) => typeof path === "string" &&
    !/[\\:\p{Cc}]/u.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const contextOf = (g) => join(g.packDir ?? "", "pack.yaml");
const optionsOf = (g) => {
    const options = g.options;
    if (g.implementation !== "system-one:noul" || g.kind !== "model" || g.scope !== "project" ||
        g.runs.length !== 1 || g.runs[0] !== "boundary") {
        throw new RecordError(contextOf(g), `/guardrails/${g.id}`, "Use system-one:noul as a project-scoped model Guardrail that runs only at the boundary.");
    }
    if (typeof options?.model !== "string" || !/^(?:jev|laya)-\d+\.\d+\.\d+$/.test(options.model) ||
        typeof options.question !== "string" || options.question.trim() === "" ||
        !Array.isArray(options.inputs) || options.inputs.length === 0 || options.inputs.length > MAX_INPUTS ||
        !options.inputs.every(relativePath) || new Set(options.inputs).size !== options.inputs.length ||
        !probability(options.failBelow) || !probability(options.passAt) || options.failBelow >= options.passAt) {
        throw new RecordError(contextOf(g), `/guardrails/${g.id}/options`, "Supply an exact model version, a compliance question, distinct project-relative inputs, and thresholds 0 ≤ failBelow < passAt ≤ 1.");
    }
    return options;
};
const inputError = (path) => new RecordError(path, "", "The System One input must be a regular UTF-8 file at the declared path within the checkout and fit the 16 KiB request limit.");
async function inputsOf(root, paths, inventory) {
    const actualRoot = await realpath(root);
    const available = new Set(inventory);
    let remaining = MAX_BYTES;
    const inputs = [];
    for (const file of [...paths].sort()) {
        const path = join(actualRoot, ...file.split(posix.sep));
        if (!available.has(file) || await realpath(path) !== path)
            throw inputError(file);
        const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            if (!(await descriptor.stat()).isFile())
                throw inputError(file);
            const buffer = Buffer.alloc(remaining + 1);
            let size = 0;
            while (size <= remaining) {
                const { bytesRead } = await descriptor.read(buffer, size, buffer.length - size, null);
                if (bytesRead === 0)
                    break;
                size += bytesRead;
            }
            if (size > remaining)
                throw inputError(file);
            remaining -= size;
            inputs.push({ file, text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)) });
        }
        finally {
            await descriptor.close();
        }
    }
    return inputs;
}
async function cachedDecision(path, model, input) {
    let text;
    try {
        text = await readFile(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    const invalid = () => new RecordError(path, "", "Invalid System One decision cache. Next action: restore the cache entry from a trusted copy or remove the entry and rerun the check.");
    let cached;
    try {
        cached = JSON.parse(text);
    }
    catch {
        throw invalid();
    }
    if (cached?.model !== model || cached.input !== input || !probability(cached.probability) ||
        typeof cached.liveMs !== "number" || !Number.isFinite(cached.liveMs) || cached.liveMs < 0) {
        throw invalid();
    }
    return { probability: cached.probability, liveMs: cached.liveMs };
}
async function checkModel(g, files, ctx) {
    const start = performance.now();
    const options = optionsOf(g);
    const { model, question, failBelow, passAt } = options;
    const state = await inputsOf(ctx.root, options.inputs, files);
    const body = canonicalJson({ model, state, questions: { compliance: { type: "noul", instructions: question } } });
    if (Buffer.byteLength(body) > MAX_BYTES)
        throw inputError(options.inputs[0]);
    const input = sha256(body);
    const cache = join(wardenHome(), "system-one", `${input}.json`);
    let decision = await cachedDecision(cache, model, input);
    let source = "cache";
    const doOnTimeout = "Check TypeSafe System One availability and the Guardrail budget, then rerun the check.";
    const timedOut = () => ({
        guardrail: g.id, status: "killed", violations: [], ms: performance.now() - start, recovery: doOnTimeout,
    });
    if (decision === undefined) {
        const key = process.env.TYPESAFE_API_KEY;
        if (process.env.WARDEN_TYPESAFE !== "1" || !key) {
            throw new RecordError(contextOf(g), `/guardrails/${g.id}`, "System One needs permission to send the declared inputs. Next action: after approving the file transfer, supply TYPESAFE_API_KEY and set WARDEN_TYPESAFE=1 in the trusted runner.");
        }
        const remaining = Math.ceil(g.budgetMs - (performance.now() - start));
        if (remaining <= 0)
            return timedOut();
        const timeout = AbortSignal.timeout(remaining);
        const signal = ctx.signal === undefined ? timeout : AbortSignal.any([ctx.signal, timeout]);
        let returned;
        try {
            const response = await fetch(ENDPOINT, {
                method: "POST", redirect: "error", signal, body,
                headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            });
            if (!response.ok)
                throw new Error(`TypeSafe System One returned HTTP ${response.status}. Next action: check the provider account and available models, then rerun the check.`);
            returned = await response.json();
        }
        catch (error) {
            ctx.signal?.throwIfAborted();
            if (timeout.aborted)
                return timedOut();
            throw error;
        }
        ctx.signal?.throwIfAborted();
        const liveMs = performance.now() - start;
        if (timeout.aborted || liveMs > g.budgetMs)
            return timedOut();
        const answer = returned?.answers?.compliance;
        if (returned?.model !== model || answer?.type !== "noul" || !probability(answer.noul)) {
            throw new Error(`TypeSafe System One returned an invalid answer or a model other than ${model}. Next action: check the pinned model in the provider's model list.`);
        }
        decision = { probability: answer.noul, liveMs };
        source = "live";
        try {
            linkRecord(cache, { model, input, ...decision });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
            const recorded = await cachedDecision(cache, model, input);
            if (recorded === undefined)
                throw new Error("The System One cache changed during the check. Next action: rerun the check.");
            decision = recorded;
            source = "cache";
        }
    }
    const { probability: score, liveMs } = decision;
    const verdict = score >= passAt ? "pass" : score < failBelow ? "fail" : "needs-review";
    const judgment = { model, input, probability: score, verdict, source, liveMs };
    const detail = `${g.id} ${verdict} from ${model} (compliance probability ${score}; fail below ${failBelow}, pass at ${passAt}).`;
    const doThis = verdict === "needs-review" ? `Ask an independent reviewer to assess the declared inputs against: ${question}` : `Update the declared inputs to satisfy: ${question}`;
    return {
        guardrail: g.id, judgment, files: state.length, bytes: Buffer.byteLength(body), status: verdict === "pass" ? "pass" : "fail", ms: performance.now() - start,
        violations: verdict === "pass" ? [] : [{ guardrail: g.id, file: "", line: 1, message: detail, doThis }],
    };
}
export const systemOneAdapter = {
    id: "system-one",
    wholeTree: true,
    emit: (gs) => {
        gs.forEach(optionsOf);
        return {};
    },
    run: async (gs, files, ctx) => {
        const results = [];
        for (const g of gs)
            results.push(await checkModel(g, files, ctx));
        return results;
    },
};
