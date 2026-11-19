import { existsSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { RecordError } from "../records/load.js";
import type { Guardrail } from "../records/types.js";

export const targetOf = (g: Guardrail): string => g.implementation.slice(g.implementation.indexOf(":") + 1);

const confined = new Set<string>();

const BUILTINS = new Set(builtinModules);

async function refuseEscapes(packDir: string, entry: string, packFile: string, pointer: string): Promise<void> {
  const { default: ts } = await import("typescript");
  if (confined.has(entry)) return;
  if (!entry.startsWith(`${packDir}${sep}`)) {
    throw new RecordError(packFile, pointer, `${entry} is outside the pack folder ${packDir}, so the lock cannot see it. Next action: replace the link with the file itself inside ${packDir}, then run warden compile.`);
  }
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { fileName } of ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles) {
      if (fileName.startsWith("node:") || BUILTINS.has(fileName)) continue;
      const named = resolve(dirname(file), fileName);
      const target = existsSync(named) ? realpathSync(named) : named;
      if (!fileName.startsWith(".") || !target.startsWith(`${packDir}${sep}`)) {
        throw new RecordError(packFile, pointer, `${file} imports ${fileName}, which is outside the pack folder ${packDir}, so the lock cannot see it. Next action: move what ${fileName} provides into ${packDir} and import it by a relative path inside that folder, then run warden compile.`);
      }
      if (existsSync(target)) pending.push(target);
    }
  }
  confined.add(entry);
}

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
  await refuseEscapes(realpathSync(g.packDir as string), realpathSync(file), packFile, pointer);
  const shipped = ((await import(pathToFileURL(file).href)) as { default?: Record<string, unknown> }).default ?? {};
  if (!Object.hasOwn(shipped, name)) {
    throw new RecordError(packFile, pointer, `${file} exports no ${name}. Next action: add ${name} to the default export of ${file}, then run warden compile.`);
  }
  return shipped[name] as T;
}
