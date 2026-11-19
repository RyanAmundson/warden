import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { RecordError } from "../records/load.js";
import type { Guardrail } from "../records/types.js";

export const targetOf = (g: Guardrail): string => g.implementation.slice(g.implementation.indexOf(":") + 1);

export async function packCode<T>(g: Guardrail, adapter: string): Promise<T> {
  const target = targetOf(g);
  const [namespace, name] = target.split("/", 2) as [string, string | undefined];
  const packFile = g.packDir === undefined ? "pack.yaml" : join(g.packDir, "pack.yaml");
  const pointer = `/guardrails/${g.id}/implementation`;
  const pack = g.packDir === undefined ? undefined : basename(g.packDir);
  if (name === undefined || namespace !== pack) {
    throw new RecordError(packFile, pointer, `${adapter}:${target} names no code shipped by this pack. Next action: set implementation of Guardrail ${g.id} to ${adapter}:${pack ?? "<pack>"}/<name> in ${packFile}, then run warden compile.`);
  }
  const file = join(g.packDir as string, `${adapter}.js`);
  if (!existsSync(file)) {
    throw new RecordError(packFile, pointer, `pack ${pack} ships no ${adapter}.js. Next action: add ${file} whose default export maps ${name} to its implementation, then run warden compile.`);
  }
  const shipped = ((await import(pathToFileURL(file).href)) as { default?: Record<string, unknown> }).default ?? {};
  if (!(name in shipped)) {
    throw new RecordError(packFile, pointer, `${file} exports no ${name}. Next action: add ${name} to the default export of ${file}, then run warden compile.`);
  }
  return shipped[name] as T;
}
