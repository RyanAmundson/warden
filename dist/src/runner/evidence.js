import { appendFileSync, closeSync, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const RUN_TOTAL = "run";
export const ESLINT_PASS = "eslint-pass";
export const wardenHome = () => process.env.WARDEN_HOME ?? join(homedir(), ".warden");
export const evidenceFile = (project) => join(wardenHome(), "evidence", `${project}.jsonl`);
export const previousEvidenceFile = (project) => join(wardenHome(), "evidence", `${project}.1.jsonl`);
export const ROTATE_BYTES = 16 * 1024 * 1024;
export const LOOP_TAIL_BYTES = 1024 * 1024;
const sizeOf = (file) => {
    try {
        return statSync(file).size;
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return 0;
        throw cause;
    }
};
const rotate = (project) => {
    try {
        renameSync(evidenceFile(project), previousEvidenceFile(project));
    }
    catch (cause) {
        if (cause.code !== "ENOENT")
            throw cause;
    }
};
export function linkRecord(path, value) {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = mkdtempSync(join(directory, ".pending-"));
    try {
        const candidate = join(temp, "record.json");
        writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flush: true });
        linkSync(candidate, path);
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
export function appendEvidence(project, e) {
    mkdirSync(join(wardenHome(), "evidence"), { recursive: true });
    if (sizeOf(evidenceFile(project)) >= ROTATE_BYTES)
        rotate(project);
    appendFileSync(evidenceFile(project), `${JSON.stringify(e)}\n`);
}
export function evidenceProjects() {
    try {
        return readdirSync(join(wardenHome(), "evidence"))
            .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".1.jsonl"))
            .map((f) => f.slice(0, -".jsonl".length));
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return [];
        throw cause;
    }
}
const tailOf = (file, bytes) => {
    let fd;
    try {
        fd = openSync(file, "r");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return Buffer.alloc(0);
        throw cause;
    }
    try {
        const size = fstatSync(fd).size;
        const length = Math.min(size, bytes);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        return buffer;
    }
    finally {
        closeSync(fd);
    }
};
const parse = (text, include) => text.split("\n").flatMap((l) => {
    try {
        return l === "" || include?.(l) === false ? [] : [JSON.parse(l)];
    }
    catch {
        return [];
    }
});
export function readEvidenceTail(project, bytes, include) {
    const current = tailOf(evidenceFile(project), bytes + 1);
    const tail = Buffer.concat([tailOf(previousEvidenceFile(project), bytes + 1 - current.length), current]);
    return parse((tail.length <= bytes ? tail : tail.subarray(tail.indexOf("\n") + 1)).toString("utf8"), include);
}
export function readEvidence(project, include) {
    return readEvidenceTail(project, Number.POSITIVE_INFINITY, include);
}
export function readEvidenceFrom(project, offset) {
    const size = sizeOf(evidenceFile(project));
    if (offset === 0 || size < offset)
        return { events: readEvidence(project), offset: size };
    const fd = openSync(evidenceFile(project), "r");
    try {
        const buffer = Buffer.alloc(size - offset);
        readSync(fd, buffer, 0, buffer.length, offset);
        const end = buffer.lastIndexOf("\n") + 1;
        return { events: parse(buffer.subarray(0, end).toString("utf8")), offset: offset + end };
    }
    finally {
        closeSync(fd);
    }
}
