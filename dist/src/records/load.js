import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Ajv } from "ajv";
import { parse } from "yaml";
import schema from "../../schema/records.schema.json" with { type: "json" };
export class RecordError extends Error {
    file;
    pointer;
    message;
    constructor(file, pointer, message) {
        super(`${file} ${pointer}: ${message}`);
        this.file = file;
        this.pointer = pointer;
        this.message = message;
        this.name = "RecordError";
    }
}
const ajv = new Ajv();
ajv.addSchema(schema);
const validateConfig = ajv.getSchema("records#/$defs/config");
const validatePack = ajv.getSchema("records#/$defs/pack");
function pointerOf(error) {
    const params = error.params;
    const leaf = params.additionalProperty ?? params.missingProperty;
    return leaf === undefined ? error.instancePath : `${error.instancePath}/${leaf}`;
}
export async function readText(file) {
    try {
        return await readFile(file, "utf8");
    }
    catch (cause) {
        if (cause.code === "ENOENT")
            return undefined;
        throw cause;
    }
}
function parseYaml(file, text) {
    try {
        return parse(text);
    }
    catch (cause) {
        throw new RecordError(file, "", cause.message);
    }
}
const SHAPES = {
    mustFail: "an example is a non-empty string or a map of relative paths to file contents",
    mustPass: "an example is a non-empty string or a map of relative paths to file contents",
    implementation: "an implementation is <adapter>:<target>, such as eslint:no-var",
};
function check(file, validate, value) {
    if (validate(value))
        return;
    const shaped = (validate.errors ?? []).find((e) => ["anyOf", "pattern"].includes(e.keyword) && SHAPES[e.instancePath.split("/").at(-1)] !== undefined);
    if (shaped !== undefined) {
        const leaf = shaped.instancePath.split("/").at(-1);
        const parent = shaped.instancePath.slice(0, -leaf.length - 1);
        throw new RecordError(file, shaped.instancePath, `${SHAPES[leaf]}. Next action: fix ${leaf} at ${parent} in ${file}, then run warden compile.`);
    }
    const error = (validate.errors ?? []).find((e) => e.keyword !== "if");
    if (error === undefined)
        throw new RecordError(file, "", "record failed validation");
    const { missingProperty } = error.params;
    const next = missingProperty === undefined ? "" : `. Next action: add ${missingProperty} at ${error.instancePath} in ${file}, then run warden compile.`;
    throw new RecordError(file, pointerOf(error), `${error.message ?? "invalid"}${next}`);
}
export function parseConfig(file, text) {
    const value = parseYaml(file, text);
    check(file, validateConfig, value);
    return value;
}
export async function readPack(projectRoot, wardenRoot, id, configFile) {
    const bundled = join(wardenRoot, "packs", id, "pack.yaml");
    const local = join(projectRoot, ".warden", "packs", id, "pack.yaml");
    const [inBundled, inLocal] = await Promise.all([readText(bundled), readText(local)]);
    if (inBundled !== undefined && inLocal !== undefined) {
        throw new RecordError(configFile, "/packs", `pack ${id} exists in both ${bundled} and ${local}`);
    }
    const file = inBundled !== undefined ? bundled : local;
    const text = inBundled ?? inLocal;
    if (text === undefined) {
        throw new RecordError(configFile, "/packs", `pack ${id} not found in ${bundled} or ${local}`);
    }
    const value = parseYaml(file, text);
    check(file, validatePack, value);
    const pack = value;
    if (pack.id !== id) {
        throw new RecordError(file, "/id", `pack id ${pack.id} does not match directory ${id}`);
    }
    pack.file = file;
    for (const practice of pack.practices) {
        practice.pack = pack.id;
        for (const g of practice.guardrails)
            g.packDir = resolve(dirname(file));
    }
    return { pack, source: inBundled !== undefined ? "bundled" : "local" };
}
export async function loadRecords(projectRoot, wardenRoot) {
    const configFile = join(projectRoot, ".warden", "config.yaml");
    const configText = await readText(configFile);
    if (configText === undefined)
        throw new RecordError(configFile, "", "not found. Next action: run warden init.");
    const config = parseConfig(configFile, configText);
    const packs = [];
    const seen = new Set();
    for (const entry of config.packs) {
        if (seen.has(entry.id)) {
            throw new RecordError(configFile, "/packs", `pack ${entry.id} is listed more than once`);
        }
        seen.add(entry.id);
        packs.push((await readPack(projectRoot, wardenRoot, entry.id, configFile)).pack);
    }
    return { config, packs: packs.sort((a, b) => a.layer - b.layer), root: projectRoot };
}
