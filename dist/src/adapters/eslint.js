import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { RecordError } from "../records/load.js";
import { pathGroups } from "../records/paths.js";
import { PARSE_ERROR } from "./types.js";
const RULES_PATH = ".warden/generated/eslint.rules.json";
export const BATCH_FILES = 500;
const ruleId = (g) => g.implementation.slice(g.implementation.indexOf(":") + 1);
const ruleValue = (options) => options === undefined ? "error" : Array.isArray(options) ? ["error", ...options] : ["error", options];
const owner = (g, set) => {
    for (const pack of set.packs) {
        for (const practice of pack.practices) {
            if (!practice.guardrails.some((x) => x.id === g.id))
                continue;
            const entry = set.config.packs.find((p) => p.id === pack.id);
            return { practice, paths: pathGroups(practice.paths, entry ? entry.paths : []).map((grp) => (grp.length === 1 ? grp[0] : grp)) };
        }
    }
    return { paths: [] };
};
const wardenValue = (g, practice) => {
    if (practice === undefined)
        throw new Error(`guardrail ${g.id} uses a warden rule but belongs to no practice`);
    const extra = typeof g.options === "object" && g.options !== null && !Array.isArray(g.options) ? g.options : {};
    return ["error", { practice: practice.id, statement: practice.statement, ...extra }];
};
const emit = (gs, set) => {
    const users = new Map();
    for (const g of gs) {
        const other = users.get(ruleId(g));
        if (other !== undefined) {
            throw new RecordError("", `/guardrails/${g.id}/implementation`, `ESLint rule ${ruleId(g)} is already the implementation of Guardrail ${other}`);
        }
        users.set(ruleId(g), g.id);
    }
    const entries = gs.map((g) => {
        const { practice, paths } = owner(g, set);
        const value = ruleId(g).startsWith("warden/") ? wardenValue(g, practice) : ruleValue(g.options);
        return { files: paths, rules: { [ruleId(g)]: value } };
    });
    return { [RULES_PATH]: `${JSON.stringify({ entries }, null, 2)}\n` };
};
const NO_COMMENTS = "warden/no-comments";
const NO_SUPPRESSIONS = "warden/no-suppressions";
const BOM = /^\uFEFF/;
const annotatedLine = (lines) => {
    let inBlock = false;
    for (const line of lines) {
        const text = line.trim();
        if (inBlock || text.startsWith("/*")) {
            inBlock = !text.slice(inBlock ? 0 : 2).includes("*/");
            continue;
        }
        if (text !== "" && !text.startsWith("//"))
            return line;
    }
    return undefined;
};
const joined = (before, after) => {
    const head = before.trimEnd();
    const tail = after.trimStart();
    if (head === "")
        return `${before}${tail}`;
    if (tail === "" || /[([]$/.test(head) || /^[)\],;.]/.test(tail))
        return `${head}${tail}`;
    return `${head} ${tail}`;
};
const hiddenRules = (removed) => {
    const body = removed.replace(/^\/[/*]/, "").replace(/\*\/$/, "");
    const rest = /^\s*eslint-(?:disable|enable)(?:-next-line|-line)?(?=\s|$)(.*)$/s.exec(body)?.[1] ?? "";
    return rest.split("--")[0].split(",").map((r) => r.trim()).filter((r) => r !== "");
};
const HINTS = {
    [NO_COMMENTS]: () => "Put any meaning in a name.",
    [NO_SUPPRESSIONS]: (removed) => {
        const named = hiddenRules(removed);
        if (named.length > 0)
            return `Fix the ${named.join(", ")} problem it hid.`;
        if (/@ts-(?:ignore|expect-error|nocheck)/.test(removed))
            return "Fix the type error it hid.";
        return "Fix the rule it hid.";
    },
};
const rewrite = (source, m, id) => {
    const hint = HINTS[id];
    if (hint === undefined)
        return undefined;
    const lines = source.split("\n");
    const endLine = m.endLine ?? m.line;
    const offset = (line, column) => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
    const from = offset(m.line, m.column);
    const to = offset(endLine, m.endColumn ?? lines[endLine - 1].length + 1);
    const removed = source.slice(from, to);
    if (!/^(\/\/|\/\*)/.test(removed))
        return undefined;
    const before = lines[m.line - 1].slice(0, m.column - 1);
    const after = source.slice(to).split("\n")[0];
    if (before.trim() === "" && after.trim() === "") {
        const annotated = id === NO_SUPPRESSIONS ? annotatedLine(lines.slice(endLine)) : undefined;
        if (annotated !== undefined)
            return `${annotated.trimEnd()}\n${hint(removed)}`;
        return `${endLine === m.line ? "Delete this line." : `Delete lines ${m.line} to ${endLine}.`}\n${hint(removed)}`;
    }
    return `${joined(before, after).trimEnd()}\n${hint(removed)}`;
};
const doThisFor = (doThis) => (doThis === undefined ? {} : { doThis });
const run = async (gs, files, ctx) => {
    const { entries } = JSON.parse(await readFile(join(ctx.generatedDir, "eslint.rules.json"), "utf8"));
    const [{ ESLint: Linting }, { default: tseslint }, { plugin }] = await Promise.all([import("eslint"), import("typescript-eslint"), import("../../eslint-plugin/index.js")]);
    const eslint = new Linting({
        cwd: ctx.root,
        overrideConfigFile: true,
        overrideConfig: [
            { plugins: { warden: plugin } },
            { files: ["**/*.{ts,tsx,mts,cts}"], languageOptions: { parser: tseslint.parser } },
            { linterOptions: { noInlineConfig: true } },
            ...entries,
        ],
        allowInlineConfig: false,
        warnIgnored: false,
        stats: true,
    });
    const results = [];
    let ms = 0;
    for (let i = 0; i < files.length; i += BATCH_FILES) {
        const start = performance.now();
        results.push(...(await eslint.lintFiles(files.slice(i, i + BATCH_FILES))));
        ms += performance.now() - start;
    }
    const byRule = new Map();
    for (const g of gs)
        byRule.set(ruleId(g), []);
    const owner = new Map(gs.map((g) => [ruleId(g), g.id]));
    const parseErrors = [];
    const ruleMs = new Map();
    for (const result of results) {
        for (const pass of result.stats?.times.passes ?? []) {
            for (const [id, t] of Object.entries(pass.rules ?? {}))
                ruleMs.set(id, (ruleMs.get(id) ?? 0) + t.total);
        }
        if (result.messages.length > 0 && result.source === undefined)
            throw new Error(`eslint returned messages for ${result.filePath} without its source`);
        const source = (result.source ?? "").replace(BOM, "");
        const suppressed = new Set(result.messages.filter((m) => m.ruleId === NO_SUPPRESSIONS).map((m) => `${m.line}:${m.column}`));
        for (const m of result.messages) {
            if (m.ruleId === NO_COMMENTS && suppressed.has(`${m.line}:${m.column}`))
                continue;
            if (m.ruleId === null && m.fatal === true) {
                parseErrors.push({ guardrail: PARSE_ERROR, file: relative(ctx.root, result.filePath), line: m.line, message: m.message });
                continue;
            }
            const id = m.ruleId === null ? undefined : m.ruleId;
            const bucket = id === undefined ? undefined : byRule.get(id);
            if (bucket === undefined) {
                throw new Error(`eslint reported ${id ?? "a fatal error"} in ${result.filePath}: ${m.message}`);
            }
            bucket.push({
                guardrail: owner.get(id),
                file: relative(ctx.root, result.filePath),
                line: m.line,
                endLine: m.endLine ?? m.line,
                message: m.message,
                ...doThisFor(rewrite(source, m, id)),
            });
        }
    }
    const shared = { id: "eslint", guardrails: gs.length, members: gs.map((g) => g.id) };
    const out = gs.map((g) => {
        const violations = byRule.get(ruleId(g));
        return { guardrail: g.id, status: violations.length > 0 ? "fail" : "pass", violations, ms, shared, ruleMs: ruleMs.get(ruleId(g)) ?? 0 };
    });
    return parseErrors.length > 0 ? [...out, { guardrail: PARSE_ERROR, status: "fail", violations: parseErrors, ms, shared }] : out;
};
export const eslintAdapter = { id: "eslint", emit, run };
