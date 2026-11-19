import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, sha256 } from "../compiler/lock.js";
import { wardenHome } from "./evidence.js";
const VIOLATION_CACHE = "violation-range";
export const cacheKey = (file, contentSha, g, lockSha, warden) => sha256(canonicalJson([VIOLATION_CACHE, g.id, g.version, g.implementation, g.options ?? null, file, contentSha, lockSha, warden]));
const cacheDir = (project) => join(wardenHome(), "cache", project);
export function readCache(project, key) {
    try {
        return JSON.parse(readFileSync(join(cacheDir(project), `${key}.json`), "utf8"));
    }
    catch {
        return undefined;
    }
}
export function writeCache(project, key, violations) {
    mkdirSync(cacheDir(project), { recursive: true });
    const target = join(cacheDir(project), `${key}.json`);
    const temp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(violations));
    renameSync(temp, target);
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
