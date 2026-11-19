import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { projectFiles } from "../runner/baseline.js";
import { matchesPath } from "./paths.js";
import type { RecordSet, UnitDeclaration } from "./types.js";

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

export async function loadUnits(set: RecordSet, wardenRoot: string): Promise<Unit[]> {
  const { units: declared, unitKinds } = set.config;
  if (declared !== undefined) {
    return declared.map((unit) => ({ ...unit, document: posix.join(unit.folder, unitKinds![unit.kind]!.document) }));
  }
  const architecture = set.config.packs.find((pack) => pack.id === "architecture");
  const collections = (architecture?.settings?.groupCollections ?? []) as Collection[];
  if (architecture === undefined || collections.length === 0) return [];

  const { groupsIn, kebab } = await import(pathToFileURL(join(wardenRoot, "packs/architecture/fs.js")).href) as ArchitectureGroups;
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
