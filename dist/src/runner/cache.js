import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import { wardenHome } from "./evidence.js";
export const cacheKey = (file, contentSha, g, lockSha, warden) => sha256(canonicalJson(["violation-range", g.id, g.version, g.implementation, g.options ?? null, file, contentSha, lockSha, warden]));
const cacheDir = (project) => join(wardenHome(), "cache", project);
export function readCache(project, key) {
    try {
        return JSON.parse(readFileSync(join(cacheDir(project), `${key}.json`), "utf8"));
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return undefined;
        throw cause;
    }
}
export function writeCache(project, key, violations) {
    mkdirSync(cacheDir(project), { recursive: true });
    writeFileSync(join(cacheDir(project), `${key}.json`), JSON.stringify(violations));
}
const benchDir = () => join(wardenHome(), "bench");
export function readBenchCache(key) {
    try {
        return JSON.parse(readFileSync(join(benchDir(), `${key}.json`), "utf8"));
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return undefined;
        throw cause;
    }
}
export function writeBenchCache(key, m) {
    mkdirSync(benchDir(), { recursive: true });
    writeFileSync(join(benchDir(), `${key}.json`), JSON.stringify(m));
}
