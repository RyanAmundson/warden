import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { matchesPath, pathCaseKey } from "./paths.js";
import type { RecordSet, UnitDeclaration, UnitKind } from "./types.js";

export interface Unit extends UnitDeclaration {
  document: string;
}

interface Collection {
  collection: string;
  suffix: string;
  port: string;
}

interface ArchitectureGroups {
  groupsIn(files: string[], settings: { groupCollections: Collection[] }, options: { allAncestors: boolean }): { name: string; dir: string; term?: string; port: string; files: string[] }[];
  kebab(id: string): string;
}

export function declaredUnits(set: RecordSet): (Unit & { kindRecord: UnitKind })[] | undefined {
  return set.config.units?.map((unit) => {
    const kindRecord = set.config.unitKinds![unit.kind]!;
    return { ...unit, document: posix.join(unit.folder, kindRecord.document), kindRecord };
  });
}

export function unitLookup<T extends Unit>(units: readonly T[], ignoreCase: boolean): (path: string) => T | undefined {
  const byFolder = new Map(units.map((unit) => [pathCaseKey(unit.folder, ignoreCase), unit]));
  return (path) => {
    let folder = pathCaseKey(path, ignoreCase);
    while (folder !== ".") {
      const owner = byFolder.get(folder);
      if (owner !== undefined) return owner;
      folder = posix.dirname(folder);
    }
    return byFolder.get(".");
  };
}

export async function loadUnits(set: RecordSet, wardenRoot: string): Promise<Unit[]> {
  const declared = declaredUnits(set);
  if (declared !== undefined) return declared;
  const architecture = set.config.packs.find((pack) => pack.id === "architecture");
  const collections = (architecture?.settings?.groupCollections ?? []) as Collection[];
  if (architecture === undefined || collections.length === 0) return [];

  const { groupsIn, kebab } = await import(pathToFileURL(join(wardenRoot, "packs/architecture/fs.js")).href) as ArchitectureGroups;
  const { projectFiles } = await import("../runner/baseline.js");
  const files = projectFiles(set.root, ["**"]);
  const inScope = (file: string): boolean => architecture.paths.length === 0 || architecture.paths.some((glob) => matchesPath(file, glob));
  const terms = new Map(set.packs.flatMap((pack) => pack.terms.map(({ id }) => [kebab(id), id] as const)));
  const units = new Map<string, Unit>();
  for (const collection of collections) {
    for (const group of groupsIn(files, { groupCollections: [collection] }, { allAncestors: true })) {
      if (units.has(group.dir) || (!inScope(group.port) && !group.files.some(inScope))) continue;
      const term = group.term === undefined ? undefined : terms.get(group.term);
      units.set(group.dir, { id: group.name, kind: collection.collection, folder: group.dir, document: `${group.dir}/CONTRACT.md`, ...(term === undefined ? {} : { term }) });
    }
  }
  return [...units.values()];
}
