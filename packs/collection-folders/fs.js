const bracketed = (segment) => /^\[.*\]$/.test(segment);

const firstFiles = (files, dirOf) => {
  const first = new Map();
  for (const file of [...files].sort()) {
    for (const dir of dirOf(file)) if (!first.has(dir)) first.set(dir, file);
  }
  return first;
};

const holdsOnlyFolders = ({ files }) =>
  files
    .filter((file) => {
      const segments = file.split("/");
      return segments.length > 1 && bracketed(segments[segments.length - 2]);
    })
    .map((file) => ({ file, message: `${file} is a file directly inside a collection.`, doThis: "Move this file into an item folder of its collection." }));

const doNotNest = ({ files }) => {
  const nested = firstFiles(files, (file) => {
    const segments = file.split("/");
    const dirs = [];
    for (let i = 1; i < segments.length - 1; i++) if (bracketed(segments[i]) && bracketed(segments[i - 1])) dirs.push(segments.slice(0, i + 1).join("/"));
    return dirs;
  });
  return [...nested].map(([dir, file]) => ({ file, message: `${dir} is a collection directly inside a collection.`, doThis: `Remove the brackets from ${dir} so it becomes an item folder.` }));
};

const PLURAL_KEBAB = /^\[[a-z0-9]+(-[a-z0-9]+)*s\]$/;

const pluralKebabCase = ({ files }) => {
  const misnamed = firstFiles(files, (file) => {
    const segments = file.split("/");
    const dirs = [];
    for (let i = 0; i < segments.length - 1; i++) if (bracketed(segments[i]) && !PLURAL_KEBAB.test(segments[i])) dirs.push(segments.slice(0, i + 1).join("/"));
    return dirs;
  });
  return [...misnamed].map(([dir, file]) => ({ file, message: `${dir} is not a plural lowercase kebab-case collection name.`, doThis: `Rename ${dir} to lowercase kebab-case ending in s, such as [quality-gates].` }));
};

const itemsShareOneShape = ({ files }) => {
  const collections = new Map();
  for (const file of [...files].sort()) {
    const segments = file.split("/");
    for (let i = 0; i < segments.length - 2; i++) {
      if (!bracketed(segments[i])) continue;
      const collection = segments.slice(0, i + 1).join("/");
      const items = collections.get(collection) ?? new Map();
      const name = segments[i + 1];
      const item = items.get(name) ?? { first: file, entries: new Map() };
      const entry = segments[i + 2];
      item.entries.set(entry, entry === name || entry.startsWith(`${name}.`) ? `<item>${entry.slice(name.length)}` : entry);
      items.set(name, item);
      collections.set(collection, items);
    }
  }
  const found = [];
  for (const [collection, items] of collections) {
    if (items.size < 2) continue;
    const shape = (entries) => [...new Set(entries.values())].sort().join("/");
    const count = new Map();
    for (const { entries } of items.values()) count.set(shape(entries), (count.get(shape(entries)) ?? 0) + 1);
    const ranked = [...count].sort((x, y) => y[1] - x[1]);
    if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
    const want = new Set(ranked[0][0].split("/"));
    for (const [name, { first, entries }] of items) {
      const lacks = [...want].filter((x) => ![...entries].some(([real, compared]) => real === x || compared === x)).map((x) => x.replace("<item>", name));
      const extra = [...entries].filter(([real, compared]) => !want.has(real) && !want.has(compared)).map(([real]) => real);
      if (lacks.length + extra.length === 0) continue;
      const parts = [lacks.length > 0 ? `lacks [${lacks.join(", ")}]` : "", extra.length > 0 ? `has extra [${extra.join(", ")}]` : ""].filter((x) => x !== "");
      found.push({
        file: first,
        message: `${collection}/${name} differs from the shape most items in ${collection} share: ${parts.join(", ")}.`,
        doThis: `Give ${collection}/${name} the top-level files and folders its collection expects: ${[...want].map((x) => x.replace("<item>", name)).join(", ")}.`,
      });
    }
  }
  return found;
};

export default {
  "holds-only-folders": holdsOnlyFolders,
  "do-not-nest": doNotNest,
  "plural-kebab-case": pluralKebabCase,
  "items-share-one-shape": itemsShareOneShape,
};
