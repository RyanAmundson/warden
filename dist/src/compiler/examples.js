import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { adapters, runGuardrails, unknownAdapters } from "../runner/run.js";
import { enabledOn, pathGroups } from "../records/paths.js";
import { exampleSet } from "../records/load.js";
import { PARSE_ERROR } from "../adapters/types.js";
const TSCONFIG = JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true }, include: ["**/*.ts"] });
const literal = (glob) => (glob.startsWith("!") ? "" : (glob.split("*", 1)[0] ?? ""));
export const examplePrefix = (group) => (group ?? []).map(literal).reduce((a, b) => (b.length > a.length ? b : a), "");
const exampleFile = (group) => `${examplePrefix(group)}warden-example.ts`;
const SCAFFOLD = ["package.json", "tsconfig.json"];
const ownedBy = (owned) => (key) => {
    const path = posix.normalize(key).toLowerCase();
    const first = path.split("/")[0];
    return first === "node_modules" || first === ".warden" || [...owned].some((o) => path === o || path.startsWith(`${o}/`));
};
const unremoved = (failures) => new Error(`Warden could not remove ${failures.length === 1 ? "its example project" : `${failures.length} example projects:`} ${failures.map((f) => `${f.project} (${f.cause})`).join(", ")}. Next action: delete ${failures.map((f) => f.project).join(" and ")}, then run the command again.`);
const removals = new Set();
export const exampleProjectsRemoved = async () => {
    const pending = [...removals];
    removals.clear();
    const failures = (await Promise.allSettled(pending)).flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (failures.length > 0)
        throw unremoved(failures);
};
export async function thenRemoveExampleProjects(run, report) {
    try {
        await run();
    }
    catch (cause) {
        report(cause);
    }
    try {
        await exampleProjectsRemoved();
    }
    catch (cause) {
        report(cause);
    }
}
export async function withExampleProject(fn, removeLater = false) {
    const project = await mkdtemp(join(tmpdir(), "warden-examples-"));
    try {
        await writeFile(join(project, "package.json"), "{}\n");
        await writeFile(join(project, "tsconfig.json"), TSCONFIG);
        return await fn(project);
    }
    finally {
        const removal = rm(project, { recursive: true, force: true }).catch((cause) => Promise.reject({ project, cause: cause.message }));
        if (removeLater) {
            removals.add(removal);
            removal.then(() => removals.delete(removal), () => undefined);
        }
        else {
            await removal.catch((failure) => Promise.reject(unremoved([failure])));
        }
    }
}
export async function runExamples(project) {
    const set = exampleSet(project);
    const unknown = unknownAdapters(set).map(({ code, record, message }) => ({ code, record, message }));
    if (unknown.length > 0)
        return unknown;
    const findings = [];
    await withExampleProject(async (project) => {
        const checked = [];
        const ctx = { root: project, generatedDir: join(project, ".warden/generated") };
        const emittedPaths = set.packs
            .flatMap((p) => p.practices.flatMap((x) => x.guardrails))
            .flatMap((g) => {
            const adapter = g.kind === "instruction" ? undefined : adapters.get(g.implementation.slice(0, g.implementation.indexOf(":")));
            return adapter === undefined ? [] : Object.keys(adapter.emit([g], set));
        });
        const owned = ownedBy(new Set([...SCAFFOLD, ...emittedPaths].map((p) => p.toLowerCase())));
        for (const pack of set.packs) {
            for (const practice of pack.practices) {
                const groups = pathGroups(practice.paths, set.config.packs.find((p) => p.id === pack.id)?.paths ?? []);
                const file = exampleFile(groups[0]);
                for (const g of practice.guardrails) {
                    if (g.kind === "instruction")
                        continue;
                    const adapter = adapters.get(g.implementation.slice(0, g.implementation.indexOf(":")));
                    checked.push({ g, file, groups, packFile: pack.file });
                    const then = `in ${pack.file}, then run warden compile.`;
                    for (const [label, want] of [["mustFail", "fail"], ["mustPass", "pass"]]) {
                        const source = g[label];
                        if (source === undefined) {
                            findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} has no ${label} example. Next action: add ${label} to Guardrail ${g.id} ${then}` });
                            continue;
                        }
                        const unsafe = typeof source === "string" ? undefined : Object.keys(source).find(owned);
                        if (unsafe !== undefined) {
                            findings.push({ code: "example-unsafe", record: g.id, message: `Guardrail ${g.id} ${label} example writes ${unsafe}, which Warden's example project owns (node_modules, .warden, package.json, tsconfig.json, and emitted configs). Next action: move ${unsafe} to another path in the ${label} example of Guardrail ${g.id} ${then}` });
                            continue;
                        }
                        const status = await runExample(set, g, adapter.emit([g], set), source, file, ctx);
                        if (status === "parse-error") {
                            findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} ${label} example does not parse. Next action: fix the syntax of the ${label} example of Guardrail ${g.id} ${then}` });
                        }
                        else if (status === "over-budget") {
                            findings.push({ code: "over-budget", record: g.id, message: `Guardrail ${g.id} ran longer than its ${g.budgetMs} ms budget on its ${label} example. Next action: make the ${label} example of Guardrail ${g.id} finish within ${g.budgetMs} ms ${then}` });
                        }
                        else if (status !== want) {
                            findings.push({ code: "example-failed", record: g.id, message: `Guardrail ${g.id} ${label} example did not ${want}. Next action: change the ${label} example of Guardrail ${g.id} in ${pack.file} so ${g.implementation} ${want === "pass" ? "passes" : "fails"} on it, then run warden compile.` });
                        }
                    }
                }
            }
        }
        for (const { g, file, packFile } of checked) {
            if (typeof g.mustPass !== "string")
                continue;
            for (const other of checked) {
                if (other.g === g || other.g.implementation.startsWith("cmd:") || !enabledOn(file, other.groups))
                    continue;
                const adapter = adapters.get(other.g.implementation.slice(0, other.g.implementation.indexOf(":")));
                const status = await runExample(set, other.g, adapter.emit([other.g], set), g.mustPass, file, ctx);
                if (status === "fail") {
                    findings.push({ code: "example-conflict", record: g.id, message: `Guardrail ${g.id} mustPass example fails Guardrail ${other.g.id}. Next action: change the mustPass example of Guardrail ${g.id} in ${packFile} so it also passes ${other.g.id}, then run warden compile.` });
                }
            }
        }
    });
    return findings;
}
async function runExample(set, g, emitted, source, file, ctx) {
    const tree = typeof source === "string" ? { [file]: source } : source;
    const made = [];
    try {
        for (const [path, content] of Object.entries(emitted)) {
            await mkdir(dirname(join(ctx.root, path)), { recursive: true });
            await writeFile(join(ctx.root, path), content);
        }
        for (const [path, content] of Object.entries(tree)) {
            const dir = await mkdir(dirname(join(ctx.root, path)), { recursive: true });
            if (dir !== undefined)
                made.push(dir);
            await writeFile(join(ctx.root, path), content);
        }
        const results = await runGuardrails(set, [g], Object.keys(tree), ctx);
        if (results.some((r) => r.guardrail === PARSE_ERROR && r.status === "fail"))
            return "parse-error";
        const own = results.find((r) => r.guardrail === g.id);
        if (own === undefined)
            throw new Error(`no result for guardrail ${g.id}`);
        return own.status === "killed" || own.overBudget === true ? "over-budget" : own.status;
    }
    finally {
        for (const path of Object.keys(tree))
            await rm(join(ctx.root, path), { force: true });
        for (const dir of made)
            await rm(dir, { recursive: true, force: true });
    }
}
