import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import { RecordError } from "../records/load.js";
import { pathGroups } from "../records/paths.js";
import { benchSettings } from "../records/types.js";
export const LOCK_FORMAT = 3;
export const TOOLS = ["eslint", "typescript-eslint", "typescript"];
const wardenRequire = createRequire(import.meta.url);
export const firstLine = (text) => text.split("\n")[0];
const versionOf = (name) => {
    try {
        return wardenRequire(`${name}/package.json`).version;
    }
    catch (cause) {
        throw new RecordError("", "/tools", `Warden's bundled ${name} does not load: ${firstLine(cause.message)}. Next action: reinstall Warden so its bundled ${name} loads, then run warden doctor.`);
    }
};
export const bundledTools = () => Object.fromEntries(TOOLS.map((name) => [name, versionOf(name)]));
const OS_JUNK = new Set([".DS_Store", ".localized", "Thumbs.db", "desktop.ini"].map((n) => n.toLowerCase()));
export const isOsJunk = (name) => OS_JUNK.has(name.normalize("NFKC").toLowerCase());
export const packFiles = async (base, dir) => {
    try {
        const entries = await readdir(join(base, dir), { recursive: true, withFileTypes: true });
        const link = entries.find((e) => e.isSymbolicLink());
        if (link !== undefined) {
            const path = join(link.parentPath, link.name);
            throw new RecordError(path, "", `is a symbolic link in a pack folder, so the lock cannot hash what it points to. Next action: replace ${path} with a copy of what it points to, then run warden compile.`);
        }
        return entries.filter((e) => e.isFile() && !isOsJunk(e.name)).map((e) => relative(base, join(e.parentPath, e.name)).split(sep).join("/"));
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return [];
        throw cause;
    }
};
export const LOCK_PATH = ".warden/lock.json";
export const FIRST_STAMPING = "0.1.11";
export const olderThan = (a, b) => {
    const [x, y] = [a, b].map((v) => v.split(".").map(Number));
    const i = x.findIndex((n, j) => n !== y[j]);
    return i !== -1 && x[i] < (y[i] ?? 0);
};
export const sha256 = (content) => createHash("sha256").update(content).digest("hex");
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object" && value !== null) {
        const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
const hashed = (files) => Object.fromEntries(Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => [path, sha256(content)]));
export function computeLock(set, generated, sources, warden) {
    const guardrails = set.packs
        .flatMap((pack) => pack.practices.flatMap((practice) => {
        const entry = set.config.packs.find((p) => p.id === pack.id);
        const paths = pathGroups(practice.paths, entry?.paths ?? []).map((g) => g.join(" & "));
        return practice.guardrails.map((g) => [
            g.id,
            {
                kind: g.kind,
                budgetMs: g.budgetMs,
                version: g.version,
                implementation: g.implementation,
                options: g.options ?? null,
                runs: [...g.runs].sort(),
                paths: [...paths].sort(),
                ...(entry?.settings === undefined ? {} : { settings: entry.settings }),
            },
        ]);
    }))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const { project, base, tierBudgetMs, loopBreakerRepeats } = set.config;
    return {
        format: LOCK_FORMAT,
        warden,
        sources: hashed(sources),
        tools: bundledTools(),
        generated: hashed(generated),
        guardrails: Object.fromEntries(guardrails),
        config: { project, base, tierBudgetMs, loopBreakerRepeats, bench: benchSettings(set.config) },
    };
}
export function readLock(root) {
    const lock = JSON.parse(readFileSync(join(root, LOCK_PATH), "utf8"));
    if ((lock.format ?? 0) > LOCK_FORMAT) {
        throw new RecordError(LOCK_PATH, "/format", `has format ${lock.format}; this Warden reads formats up to ${LOCK_FORMAT}. Next action: install Warden ${lock.warden}, the release that wrote the lock.`);
    }
    return lock;
}
