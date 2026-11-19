import { matchesGlob, posix } from "node:path";

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export const stem = (file) => file.replace(CODE, "");

export const sameModule = (a, b) => stem(a) === stem(b);

export function* groupAncestors(file, settings, all = false) {
  const path = `/${file}`;
  for (const collection of settings.groupCollections) {
    const marker = `/${collection.collection}/`;
    for (let at = path.indexOf(marker); at !== -1; at = path.indexOf(marker, at + 1)) {
      const start = at + marker.length;
      const end = path.indexOf("/", start);
      if (end === -1) {
        if (!all) return;
        break;
      }
      const name = path.slice(start, end);
      const base = path.slice(1, start - 1);
      yield {
        name,
        dir: `${base}/${name}`,
        port: `${base}/${collection.port.replaceAll("{name}", name)}`,
        suffix: collection.suffix,
        term: name.endsWith(collection.suffix) ? name.slice(0, name.length - collection.suffix.length) : undefined,
      };
    }
  }
}

export const groupOf = (file, settings) => groupAncestors(file, settings).next().value;

export const conformanceOf = (group) => `${stem(group.port)}.conformance.ts`;

export const matchesPath = (file, glob) => (glob.startsWith("!") ? !matchesGlob(file, glob.slice(1)) : matchesGlob(file, glob));

export const isCompositionRoot = (file, settings) => settings.compositionRoots.some((glob) => matchesPath(file, glob));

export const isTest = (file) => /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec|config)\.[^/]+$/.test(file);

export const resolveFrom = (file, specifier) => (specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), specifier)) : undefined);

export const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`);
