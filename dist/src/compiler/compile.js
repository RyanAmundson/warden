import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TscConfigError, tscConfigSources } from "../adapters/tsc-config.js";
import { targetOf } from "../adapters/pack-code.js";
import { bundledScript } from "../adapters/cmd.js";
import { RecordError, loadRecords, readPack, readText } from "../records/load.js";
import { BASELINE_PATH, measureBaseline, readBaseline, writeBaseline } from "../runner/baseline.js";
import { hasCommit, isRepository } from "../runner/changed.js";
import { SIGNERS_FILE, readBaseLock } from "../runner/tamper.js";
import { adapters, prefixOf, refuseUnknownAdapters } from "../runner/run.js";
import { admit } from "./bench.js";
import { checkConsistency } from "./consistency.js";
import { COMMAND_REPLACEMENTS, COMMIT_HOOK, commitHook, stamp } from "./emit.js";
import { runExamples } from "./examples.js";
import { commandSources } from "./command-sources.js";
import { LOCK_PATH, computeLock, packFiles, scriptsOf, sha256 } from "./lock.js";
import { checkCommands, commandReplacements, emitSkills, SKILLS_DIR } from "./skills.js";
const sourceFiles = async (set, projectRoot, wardenRoot) => {
    const out = {};
    const config = await readText(join(projectRoot, ".warden/config.yaml"));
    if (config === undefined)
        throw new RecordError(join(projectRoot, ".warden/config.yaml"), "", "file not found");
    out[".warden/config.yaml"] = config;
    const signers = await readText(join(wardenRoot, SIGNERS_FILE));
    if (signers !== undefined)
        out[SIGNERS_FILE] = signers;
    const packSources = new Map();
    for (const { id } of set.config.packs) {
        for (const [dir, base] of [[`packs/${id}`, wardenRoot], [`.warden/packs/${id}`, projectRoot]]) {
            const relativeSources = new Map();
            packSources.set(join(base, dir), relativeSources);
            for (const key of await packFiles(base, dir)) {
                const source = (await readText(join(base, key)));
                out[key] = source;
                relativeSources.set(key.slice(dir.length + 1), source);
            }
        }
    }
    const scripts = scriptsOf(projectRoot);
    const guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails));
    if (guardrails.some((g) => g.kind !== "instruction" && prefixOf(g) === "tsc")) {
        try {
            Object.assign(out, await tscConfigSources(projectRoot));
        }
        catch (cause) {
            if (!(cause instanceof TscConfigError))
                throw cause;
            throw new RecordError(cause.file, "", cause.message);
        }
    }
    for (const g of guardrails) {
        if (!g.implementation.startsWith("cmd:"))
            continue;
        const dir = g.packDir;
        const sources = dir === undefined ? undefined : packSources.get(dir);
        const command = targetOf(g);
        const owner = {
            file: dir === undefined ? "" : join(dir, "pack.yaml"), id: g.id,
            ...(sources === undefined ? {} : { packSources: sources }),
            exactNodeEntry: bundledScript(command, dir) !== undefined,
        };
        Object.assign(out, commandSources(projectRoot, command, g.sources ?? [], scripts, owner));
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
            await writeFile(temp, content, { mode: file === COMMIT_HOOK ? 0o755 : 0o644 });
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
    return buildOutputs(set, version, sources);
}
function buildOutputs(set, version, sources) {
    const sourceHash = sha256(Object.entries(sources)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, content]) => `${path}\0${content}\0`)
        .join(""));
    const emitted = { ...emitAll(set), [COMMIT_HOOK]: commitHook(version, set.config.base) };
    const replacements = commandReplacements(set);
    if (replacements.length > 0)
        emitted[COMMAND_REPLACEMENTS] = JSON.stringify({ replacements });
    for (const [path, content] of Object.entries(emitSkills(set))) {
        if (path in emitted)
            throw new Error(`more than one output is ${path}`);
        emitted[path] = content;
    }
    const files = Object.fromEntries(Object.entries(emitted).map(([key, content]) => [key, stamp(key, content, version, sourceHash)]));
    return { lock: computeLock(set, files, sources, version), files };
}
const previousLock = (text) => {
    if (text === undefined)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
};
const retireOutputs = async (root, previous, outputs) => {
    for (const file of Object.keys(previous?.generated ?? {})) {
        const [id, name, extra] = file.slice(SKILLS_DIR.length + 1).split("/");
        const skill = file.startsWith(`${SKILLS_DIR}/`) && /^[a-z0-9][a-z0-9-]*$/.test(id ?? "") && name === "SKILL.md" && extra === undefined;
        if ((!skill && file !== COMMAND_REPLACEMENTS) || file in outputs)
            continue;
        let directory = root;
        for (const segment of dirname(file).split("/")) {
            directory = join(directory, segment);
            const entry = await lstat(directory).catch((cause) => {
                if (cause.code === "ENOENT")
                    return undefined;
                throw cause;
            });
            if (entry?.isDirectory() !== true)
                break;
            if (directory === join(root, dirname(file)))
                await rm(join(root, file), { force: true });
        }
    }
};
const packDirs = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT")
            return [];
        throw error;
    });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
};
export async function practicesElsewhere(set, wardenRoot) {
    const elsewhere = new Map();
    const enabled = new Set(set.packs.flatMap((p) => p.practices.map((x) => x.id)));
    if (set.packs.every((p) => p.practices.every((x) => x.conflictsWith.every((id) => enabled.has(id)))))
        return elsewhere;
    const on = new Set(set.packs.map((p) => p.id));
    const configFile = join(set.root, ".warden", "config.yaml");
    const ids = [...(await packDirs(join(wardenRoot, "packs"))), ...(await packDirs(join(set.root, ".warden", "packs")))];
    for (const id of new Set(ids)) {
        if (on.has(id))
            continue;
        if ((await readText(join(wardenRoot, "packs", id, "pack.yaml"))) === undefined && (await readText(join(set.root, ".warden", "packs", id, "pack.yaml"))) === undefined)
            continue;
        const { pack } = await readPack(set.root, wardenRoot, id, configFile);
        for (const practice of pack.practices)
            elsewhere.set(practice.id, pack.id);
    }
    return elsewhere;
}
export async function compile(projectRoot, wardenRoot) {
    const set = await loadRecords(projectRoot, wardenRoot);
    const sources = await sourceFiles(set, projectRoot, wardenRoot);
    const findings = [...checkConsistency(set, await practicesElsewhere(set, wardenRoot)), ...(await runExamples(set)), ...(await checkCommands(set, wardenRoot))];
    if (findings.length > 0)
        return { findings, written: [] };
    const version = await wardenVersion(wardenRoot);
    const slow = await admit(set, version);
    if (slow.length > 0)
        return { findings: slow, written: [] };
    const { lock, files: outputs } = buildOutputs(set, version, sources);
    const prior = previousLock(await readText(join(projectRoot, LOCK_PATH)));
    const previous = prior?.guardrails;
    await writeAll(projectRoot, outputs);
    await retireOutputs(projectRoot, prior, outputs);
    await writeAll(projectRoot, { [LOCK_PATH]: `${JSON.stringify(lock, null, 2)}\n` });
    const written = [...Object.keys(outputs), LOCK_PATH];
    if (previous === undefined || !isRepository(projectRoot))
        return { findings: [], written };
    const checked = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction")));
    const atBase = hasCommit(projectRoot, set.config.base) ? (readBaseLock(projectRoot, set.config.base)?.guardrails ?? {}) : {};
    const added = new Set(checked.filter((g) => !(g.id in previous) && !(g.id in atBase)).map((g) => g.id));
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
