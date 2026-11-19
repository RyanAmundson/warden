import { isAbsolute, relative, resolve, sep } from "node:path";
import { loadRecords } from "../records/load.js";
import { deriveUnits } from "../records/units.js";

export async function runWhere(root: string, wardenRoot: string, query: string): Promise<number> {
  const units = await deriveUnits(await loadRecords(root, wardenRoot), wardenRoot);
  const named = units.filter((unit) => unit.id === query || unit.term === query);
  if (named.length > 1) {
    process.stderr.write(`More than one Unit matches ${query}. Next action: run warden where with a path under one of these folders: ${named.map(({ folder }) => folder).sort().join(", ")}.\n`);
    return 2;
  }
  const path = relative(root, resolve(query));
  const projectPath = path.split(sep).join("/");
  const within = !isAbsolute(path) && projectPath !== ".." && !projectPath.startsWith("../");
  const unit = named[0] ?? (within ? units
    .filter(({ folder }) => projectPath === folder || projectPath.startsWith(`${folder}/`))
    .sort((a, b) => b.folder.length - a.folder.length)[0] : undefined);
  process.stdout.write(unit === undefined ? `No Unit for ${query}.\n` : `${unit.id}\t${unit.document}\n`);
  return 0;
}
