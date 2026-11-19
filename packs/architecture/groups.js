import { matchesGlob, posix } from "node:path";

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export const stem = (file) => file.replace(CODE, "");

export const sameModule = (a, b) => stem(a) === stem(b);

export const groupOf = (file, settings) => {
  const path = `/${file}`;
  for (const collection of settings.groupCollections) {
    const at = path.indexOf(`/${collection.collection}/`);
    if (at === -1) continue;
    const base = path.slice(1, at + collection.collection.length + 1);
    const rest = path.slice(at + collection.collection.length + 2);
    if (!rest.includes("/")) return undefined;
    const name = rest.split("/")[0];
    const suffixed = name.endsWith(collection.suffix);
    return {
      name,
      dir: `${base}/${name}`,
      port: `${base}/${collection.port.replaceAll("{name}", name)}`,
      suffix: collection.suffix,
      term: suffixed ? name.slice(0, name.length - collection.suffix.length) : undefined,
    };
  }
  return undefined;
};

export const conformanceOf = (group) => `${stem(group.port)}.conformance.ts`;

export const isCompositionRoot = (file, settings) => settings.compositionRoots.some((glob) => matchesGlob(file, glob));

export const isTest = (file) => /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec|config)\.[^/]+$/.test(file);


export const resolveFrom = (file, specifier) => (specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), specifier)) : undefined);

export const inside = (file, dir) => file === dir || file.startsWith(`${dir}/`);
