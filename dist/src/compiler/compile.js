import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeSettingsAdapter } from "../adapters/claude.js";
import { RecordError, loadRecords, readText } from "../records/load.js";
import { adapters, refuseUnknownAdapters } from "../runner/run.js";
import { admit } from "./bench.js";
import { checkConsistency } from "./consistency.js";
import { mergeSettings, stamp } from "./emit.js";
import { runExamples } from "./examples.js";
import { LOCK_PATH, canonicalJson, computeLock, sha256 } from "./lock.js";
const SETTINGS_KEY = "#";
const sourceFiles = async (set, projectRoot, wardenRoot) => {
    const out = {};
    const config = await readText(join(projectRoot, ".warden/config.yaml"));
    if (config === undefined)
        throw new RecordError(join(projectRoot, ".warden/config.yaml"), "", "file not found");
    out[".warden/config.yaml"] = config;
    for (const { id } of set.config.packs) {
        for (const [key, base] of [[`packs/${id}/pack.yaml`, wardenRoot], [`.warden/packs/${id}/pack.yaml`, projectRoot]]) {
            const text = await readText(join(base, key));
            if (text !== undefined)
                out[key] = text;
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
        const prefix = g.implementation.slice(0, g.implementation.indexOf(":"));
        groups.set(prefix, [...(groups.get(prefix) ?? []), g]);
    }
    const emitted = {};
    const pairs = [...groups].map(([prefix, gs]) => [adapters.get(prefix), gs]);
    pairs.push([claudeSettingsAdapter, []]);
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
    const files = {};
    const owned = {};
    for (const [key, content] of Object.entries(emitAll(set))) {
        const at = key.indexOf(SETTINGS_KEY);
        if (at === -1) {
            files[key] = stamp(key, content, version, sourceHash);
            continue;
        }
        const entries = JSON.parse(content);
        if (!Array.isArray(entries))
            throw new Error(`${key} must emit a JSON array`);
        const file = key.slice(0, at);
        owned[file] = { ...owned[file], [key.slice(at + 1)]: entries };
    }
    const generated = { ...files };
    for (const [file, entries] of Object.entries(owned))
        generated[`${file}#warden`] = canonicalJson(entries);
    return { lock: computeLock(set, generated, sources, version), files, owned };
}
export async function compile(projectRoot, wardenRoot) {
    const set = await loadRecords(projectRoot, wardenRoot);
    const findings = [...checkConsistency(set), ...(await runExamples(set))];
    if (findings.length > 0)
        return { findings, written: [] };
    const slow = await admit(set, await wardenVersion(wardenRoot));
    if (slow.length > 0)
        return { findings: slow, written: [] };
    const { lock, files, owned } = await expectedOutputs(set, projectRoot, wardenRoot);
    const outputs = { ...files };
    for (const [file, entries] of Object.entries(owned)) {
        outputs[file] = mergeSettings(file, await readText(join(projectRoot, file)), entries);
    }
    await writeAll(projectRoot, outputs);
    await writeAll(projectRoot, { [LOCK_PATH]: `${JSON.stringify(lock, null, 2)}\n` });
    return { findings: [], written: [...Object.keys(outputs), LOCK_PATH] };
}
