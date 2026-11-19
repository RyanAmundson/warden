import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { RecordError, loadRecords, readText } from "../records/load.js";
import { BASELINE_PATH, measureBaseline, readBaseline, writeBaseline } from "../runner/baseline.js";
import { isRepository } from "../runner/changed.js";
import { adapters, prefixOf, refuseUnknownAdapters } from "../runner/run.js";
import { admit } from "./bench.js";
import { checkConsistency } from "./consistency.js";
import { stamp } from "./emit.js";
import { runExamples } from "./examples.js";
import { LOCK_PATH, computeLock, sha256 } from "./lock.js";
const sourceFiles = async (set, projectRoot, wardenRoot) => {
    const out = {};
    const config = await readText(join(projectRoot, ".warden/config.yaml"));
    if (config === undefined)
        throw new RecordError(join(projectRoot, ".warden/config.yaml"), "", "file not found");
    out[".warden/config.yaml"] = config;
    for (const { id } of set.config.packs) {
        for (const [dir, base] of [[`packs/${id}`, wardenRoot], [`.warden/packs/${id}`, projectRoot]]) {
            const entries = await readdir(join(base, dir), { recursive: true, withFileTypes: true }).catch((cause) => {
                if (cause.code === "ENOENT")
                    return [];
                throw cause;
            });
            for (const entry of entries.filter((e) => e.isFile())) {
                const key = relative(base, join(entry.parentPath, entry.name));
                out[key] = await readFile(join(base, key), "utf8");
            }
        }
    }
    return out;
};
const emitAll = (set) => {
    refuseUnknownAdapters(set);
    const groups = new Map();
    for (const g of set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails))) {
        if (g.kind === "instruction")
            continue;
        const prefix = prefixOf(g);
        groups.set(prefix, [...(groups.get(prefix) ?? []), g]);
    }
    const emitted = {};
    const pairs = [...groups].map(([prefix, gs]) => [adapters.get(prefix), gs]);
    for (const [adapter, gs] of pairs) {
        for (const [path, content] of Object.entries(adapter.emit(gs, set))) {
            if (path in emitted)
                throw new Error(`more than one adapter emits ${path}`);
            emitted[path] = content;
        }
    }
    return emitted;
};
const writeAll = async (root, outputs) => {
    const staged = [];
    try {
        for (const [file, content] of Object.entries(outputs)) {
            const target = join(root, file);
            const temp = `${target}.warden-tmp-${process.pid}`;
            await mkdir(dirname(target), { recursive: true });
            await writeFile(temp, content);
            staged.push([temp, target]);
        }
        for (const [temp, target] of staged)
            await rename(temp, target);
    }
    finally {
        for (const [temp] of staged)
            await rm(temp, { force: true });
    }
};
export const wardenVersion = async (wardenRoot) => JSON.parse(await readFile(join(wardenRoot, "package.json"), "utf8")).version;
export async function expectedOutputs(set, projectRoot, wardenRoot) {
    const version = await wardenVersion(wardenRoot);
    const sources = await sourceFiles(set, projectRoot, wardenRoot);
    const sourceHash = sha256(Object.entries(sources)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, content]) => `${path}\0${content}\0`)
        .join(""));
    const files = Object.fromEntries(Object.entries(emitAll(set)).map(([key, content]) => [key, stamp(key, content, version, sourceHash)]));
    return { lock: computeLock(set, files, sources, version), files };
}
const previousGuardrails = (text) => {
    if (text === undefined)
        return undefined;
    try {
        return JSON.parse(text).guardrails;
    }
    catch {
        return undefined;
    }
};
export async function compile(projectRoot, wardenRoot) {
    const set = await loadRecords(projectRoot, wardenRoot);
    const findings = [...checkConsistency(set), ...(await runExamples(set))];
    if (findings.length > 0)
        return { findings, written: [] };
    const slow = await admit(set, await wardenVersion(wardenRoot));
    if (slow.length > 0)
        return { findings: slow, written: [] };
    const { lock, files: outputs } = await expectedOutputs(set, projectRoot, wardenRoot);
    const previous = previousGuardrails(await readText(join(projectRoot, LOCK_PATH)));
    await writeAll(projectRoot, outputs);
    await writeAll(projectRoot, { [LOCK_PATH]: `${JSON.stringify(lock, null, 2)}\n` });
    const written = [...Object.keys(outputs), LOCK_PATH];
    if (previous === undefined || !isRepository(projectRoot))
        return { findings: [], written };
    const checked = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction")));
    const added = new Set(checked.filter((g) => !(g.id in previous)).map((g) => g.id));
    const prefixes = new Set(checked.filter((g) => added.has(g.id)).map(prefixOf));
    const { baseline } = await measureBaseline(set, checked.filter((g) => prefixes.has(prefixOf(g))));
    const located = Object.entries(baseline)
        .filter(([id]) => added.has(id))
        .map(([id, entries]) => [id, Object.fromEntries(Object.entries(entries).filter(([file]) => file !== ""))])
        .filter(([, entries]) => Object.keys(entries).length > 0);
    if (located.length === 0)
        return { findings: [], written };
    writeBaseline(projectRoot, { ...readBaseline(projectRoot), ...Object.fromEntries(located) });
    return { findings: [], written: [...written, BASELINE_PATH] };
}
