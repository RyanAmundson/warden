import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ErrorObject } from "ajv";
import { parse } from "yaml";
import schema from "../../schema/records.schema.json" with { type: "json" };
import { backslashFix } from "./paths.js";
import type { Pack, ProjectConfig, RecordSet } from "./types.js";

export const findWardenRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "packs")) || !existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("cannot locate the Warden package root");
    dir = parent;
  }
  return dir;
};

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

const SHAPES: Record<string, string> = {
  mustFail: "an example is a non-empty string or a map of relative paths to file contents",
  mustPass: "an example is a non-empty string or a map of relative paths to file contents",
  implementation: "an implementation is <adapter>:<target>, such as eslint:no-var",
};

function check(file: string, validate: typeof validateConfig, value: unknown): void {
  if (validate(value)) return;
  const shaped = (validate.errors ?? []).find((e) => ["anyOf", "pattern"].includes(e.keyword) && SHAPES[e.instancePath.split("/").at(-1) as string] !== undefined);
  if (shaped !== undefined) {
    const leaf = shaped.instancePath.split("/").at(-1) as string;
    const parent = shaped.instancePath.slice(0, -leaf.length - 1);
    throw new RecordError(file, shaped.instancePath, `${SHAPES[leaf]}. Next action: fix ${leaf} at ${parent} in ${file}, then run warden compile.`);
  }
  const error = (validate.errors ?? []).find((e) => e.keyword !== "if");
  if (error === undefined) throw new RecordError(file, "", "record failed validation");
  const { missingProperty } = error.params as { missingProperty?: string };
  const next = missingProperty === undefined ? "" : `. Next action: add ${missingProperty} at ${error.instancePath} in ${file}, then run warden compile.`;
  throw new RecordError(file, pointerOf(error), `${error.message ?? "invalid"}${next}`);
}

function refuseBackslashes(file: string, pointer: string, paths: string[]): void {
  paths.forEach((glob, i) => {
    if (!glob.includes("\\")) return;
    throw new RecordError(file, `${pointer}/${i}`, `path ${glob} holds a backslash, which Node's glob matcher does not read as an escape. Next action: write ${backslashFix(glob)} in place of ${glob} in ${file}, then run warden compile.`);
  });
}

export function parseConfig(file: string, text: string): ProjectConfig {
  const value = parseYaml(file, text);
  check(file, validateConfig, value);
  (value as ProjectConfig).packs.forEach((entry, i) => refuseBackslashes(file, `/packs/${i}/paths`, entry.paths));
  return value as ProjectConfig;
}

export async function readPack(projectRoot: string, wardenRoot: string, id: string, configFile: string): Promise<{ pack: Pack; source: "bundled" | "local" }> {
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
  const pack = value as Pack;
  if (pack.id !== id) {
    throw new RecordError(file, "/id", `pack id ${pack.id} does not match directory ${id}`);
  }
  pack.file = file;
  pack.practices.forEach((practice, i) => refuseBackslashes(file, `/practices/${i}/paths`, practice.paths));
  for (const practice of pack.practices) {
    practice.pack = pack.id;
    for (const g of practice.guardrails) g.packDir = resolve(dirname(file));
  }
  pack.capabilities ??= [];
  for (const capability of pack.capabilities) capability.pack = pack.id;
  return { pack, source: inBundled !== undefined ? "bundled" : "local" };
}

const settingsAjv = new Ajv({ useDefaults: true });

export function resolveSettings(pack: Pack, value: unknown, file: string, pointer: string): Record<string, unknown> | undefined {
  if (pack.settings === undefined) {
    if (value === undefined) return undefined;
    throw new RecordError(file, pointer, `pack ${pack.id} declares no settings. Next action: remove settings from pack ${pack.id} in ${file}, then run warden compile.`);
  }
  let validate: ReturnType<typeof settingsAjv.compile>;
  try {
    validate = settingsAjv.compile(pack.settings);
  } catch (cause) {
    throw new RecordError(pack.file, "/settings", `is not a valid JSON Schema: ${(cause as Error).message}. Next action: fix settings in ${pack.file}, then run warden compile.`);
  }
  const resolved = structuredClone(value ?? {}) as Record<string, unknown>;
  if (validate(resolved)) return resolved;
  const error = validate.errors?.[0];
  const extra = error?.keyword === "additionalProperties" ? (error.params as { additionalProperty: string }).additionalProperty : undefined;
  if (extra !== undefined) {
    throw new RecordError(file, `${pointer}${error?.instancePath ?? ""}/${extra}`, `${extra} is not a setting of pack ${pack.id}. Next action: remove or rename ${extra} in the settings${error?.instancePath ?? ""} of pack ${pack.id} in ${file} to a setting the schema in ${pack.file} declares, then run warden compile.`);
  }
  throw new RecordError(file, `${pointer}${error?.instancePath ?? ""}`, `${error?.message ?? "invalid"} for pack ${pack.id}. Next action: fix settings${error?.instancePath ?? ""} of pack ${pack.id} in ${file} to match the settings schema in ${pack.file}, then run warden compile.`);
}

export const exampleSet = (set: RecordSet): RecordSet => ({
  ...set,
  config: {
    ...set.config,
    packs: set.config.packs.map((entry) => {
      const pack = set.packs.find((p) => p.id === entry.id);
      if (pack?.settings === undefined) return entry;
      const examples = (pack.settings as { examples?: unknown[] }).examples;
      return { ...entry, settings: resolveSettings(pack, examples?.[0], pack.file, "/settings/examples/0") };
    }),
  },
});

export async function loadRecords(projectRoot: string, wardenRoot: string): Promise<RecordSet> {
  const configFile = join(projectRoot, ".warden", "config.yaml");
  const configText = await readText(configFile);
  if (configText === undefined) throw new RecordError(configFile, "", "not found. Next action: run warden init.");
  const config = parseConfig(configFile, configText);
  const packs: Pack[] = [];
  const seen = new Set<string>();
  for (const entry of config.packs) {
    if (seen.has(entry.id)) {
      throw new RecordError(configFile, "/packs", `pack ${entry.id} is listed more than once`);
    }
    seen.add(entry.id);
    const { pack } = await readPack(projectRoot, wardenRoot, entry.id, configFile);
    const settings = resolveSettings(pack, entry.settings, configFile, `/packs/${config.packs.indexOf(entry)}/settings`);
    if (settings !== undefined) entry.settings = settings;
    packs.push(pack);
  }
  return { config, packs: packs.sort((a, b) => a.layer - b.layer), root: projectRoot };
}
