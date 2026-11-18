import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv, type ErrorObject } from "ajv";
import { parse } from "yaml";
import schema from "../../schema/records.schema.json" with { type: "json" };
import type { Pack, ProjectConfig, RecordSet } from "./types.js";

export class RecordError extends Error {
  constructor(
    public readonly file: string,
    public readonly pointer: string,
    public readonly message: string,
  ) {
    super(`${file} ${pointer}: ${message}`);
    this.name = "RecordError";
  }
}

const ajv = new Ajv();
ajv.addSchema(schema);
const validateConfig = ajv.getSchema("records#/$defs/config")!;
const validatePack = ajv.getSchema("records#/$defs/pack")!;

function pointerOf(error: ErrorObject): string {
  const params = error.params as { additionalProperty?: string; missingProperty?: string };
  const leaf = params.additionalProperty ?? params.missingProperty;
  return leaf === undefined ? error.instancePath : `${error.instancePath}/${leaf}`;
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

function parseYaml(file: string, text: string): unknown {
  try {
    return parse(text);
  } catch (cause) {
    throw new RecordError(file, "", (cause as Error).message);
  }
}

function check(file: string, validate: typeof validateConfig, value: unknown): void {
  if (validate(value)) return;
  const error = (validate.errors ?? []).find((e) => e.keyword !== "if");
  if (error === undefined) throw new RecordError(file, "", "record failed validation");
  throw new RecordError(file, pointerOf(error), error.message ?? "invalid");
}

async function readRecord(file: string, validate: typeof validateConfig): Promise<unknown> {
  const text = await readText(file);
  if (text === undefined) throw new RecordError(file, "", "file not found");
  const value = parseYaml(file, text);
  check(file, validate, value);
  return value;
}

export async function loadRecords(projectRoot: string, wardenRoot: string): Promise<RecordSet> {
  const configFile = join(projectRoot, ".warden", "config.yaml");
  const config = (await readRecord(configFile, validateConfig)) as ProjectConfig;
  const packs: Pack[] = [];
  const seen = new Set<string>();
  for (const entry of config.packs) {
    if (seen.has(entry.id)) {
      throw new RecordError(configFile, "/packs", `pack ${entry.id} is listed more than once`);
    }
    seen.add(entry.id);
    const bundled = join(wardenRoot, "packs", entry.id, "pack.yaml");
    const local = join(projectRoot, ".warden", "packs", entry.id, "pack.yaml");
    const [inBundled, inLocal] = await Promise.all([readText(bundled), readText(local)]);
    if (inBundled !== undefined && inLocal !== undefined) {
      throw new RecordError(configFile, "/packs", `pack ${entry.id} exists in both ${bundled} and ${local}`);
    }
    const file = inBundled !== undefined ? bundled : local;
    const text = inBundled ?? inLocal;
    if (text === undefined) {
      throw new RecordError(configFile, "/packs", `pack ${entry.id} not found in ${bundled} or ${local}`);
    }
    const value = parseYaml(file, text);
    check(file, validatePack, value);
    const pack = value as Pack;
    if (pack.id !== entry.id) {
      throw new RecordError(file, "/id", `pack id ${pack.id} does not match directory ${entry.id}`);
    }
    for (const practice of pack.practices) practice.pack = pack.id;
    packs.push(pack);
  }
  return { config, packs, root: projectRoot };
}
