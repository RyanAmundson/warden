import { anchorOf, groupsIn } from "./fs.js";
import { conformanceOf, groupOf, inside, isCompositionRoot, isTest, sameModule, stem } from "./groups.js";

const importsOf = (imports, file) => imports.get(file) ?? [];

const dirOf = (file) => file.slice(0, file.lastIndexOf("/"));

const runsConformance = ({ files, all, imports, settings }) => {
  const tests = new Map();
  for (const file of all) {
    if (!isTest(file)) continue;
    const list = tests.get(dirOf(file)) ?? [];
    list.push(file);
    tests.set(dirOf(file), list);
  }
  return groupsIn(files, settings).flatMap((group) => {
    const suite = conformanceOf(group);
    const factories = group.files.filter((f) => /^(adapters\/[^/]+\/)?create$/.test(stem(f).slice(group.dir.length + 1)));
    return factories.flatMap((create) => {
      const dir = dirOf(create);
      const runs = (tests.get(dir) ?? []).some((test) => {
        const targets = importsOf(imports, test).map((e) => e.target);
        return targets.some((t) => sameModule(t, suite)) && targets.some((t) => sameModule(t, create));
      });
      if (runs) return [];
      return [{ file: create, message: `${create} has no test that runs ${suite}.`, doThis: `Add ${dir}/create.test.ts, which imports the conformance suite and create, and calls the suite with create.` }];
    });
  });
};

const itemOf = (file, collections) => {
  for (const collection of collections) {
    if (!file.startsWith(`${collection}/`)) continue;
    return `${collection}/${file.slice(collection.length + 1).split("/")[0]}`;
  }
  return undefined;
};

const sharedByTwoGroups = ({ files, all, imports, settings }) => {
  const items = new Map();
  for (const file of [...files].sort()) {
    const item = itemOf(file, settings.technicalCollections);
    if (item !== undefined && !items.has(item)) items.set(item, file);
  }
  const users = new Map([...items.keys()].map((item) => [item, new Set()]));
  for (const importer of all) {
    const group = groupOf(importer, settings);
    if (group === undefined || isTest(importer)) continue;
    for (const { target } of importsOf(imports, importer)) {
      const item = itemOf(target, settings.technicalCollections);
      if (item !== undefined && !inside(importer, item)) users.get(item)?.add(group.dir);
    }
  }
  return [...items].flatMap(([item, file]) => {
    const n = users.get(item).size;
    if (n >= 2) return [];
    const only = [...users.get(item)][0];
    return [{ file, message: `${item} is used by ${n} group${n === 1 ? "" : "s"}, and a shared item serves at least two.`, doThis: only === undefined ? `Delete ${item}, or use it from two groups.` : `Move ${item} into ${only}.` }];
  });
};

const cycles = (edges) => {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const component = new Map();
  let next = 0;
  const visit = (node) => {
    index.set(node, next);
    low.set(node, next);
    next += 1;
    stack.push(node);
    onStack.add(node);
    for (const to of edges.get(node)?.keys() ?? []) {
      if (!index.has(to)) {
        visit(to);
        low.set(node, Math.min(low.get(node), low.get(to)));
      } else if (onStack.has(to)) {
        low.set(node, Math.min(low.get(node), index.get(to)));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const members = [];
    for (;;) {
      const member = stack.pop();
      onStack.delete(member);
      members.push(member);
      if (member === node) break;
    }
    if (members.length > 1) for (const member of members) component.set(member, node);
  };
  for (const node of edges.keys()) if (!index.has(node)) visit(node);
  return component;
};

const acyclicGroups = ({ files, imports, settings }) => {
  const edges = new Map();
  for (const file of files) {
    const from = groupOf(file, settings);
    if (from === undefined || isTest(file) || isCompositionRoot(file, settings)) continue;
    for (const { target, line } of importsOf(imports, file)) {
      const to = groupOf(target, settings);
      if (to === undefined || to.dir === from.dir) continue;
      const out = edges.get(from.dir) ?? new Map();
      out.set(to.dir, [...(out.get(to.dir) ?? []), { file, line }]);
      edges.set(from.dir, out);
    }
  }
  const component = cycles(edges);
  return [...edges].flatMap(([from, out]) =>
    [...out]
      .filter(([to]) => component.has(from) && component.get(from) === component.get(to))
      .flatMap(([to, sites]) =>
        sites.map(({ file, line }) => ({
          file,
          line,
          message: `${from} imports ${to}, and the two groups depend on each other through a cycle.`,
          doThis: `Move what both groups need into one of them or into a third group, so ${from} and ${to} no longer import each other.`,
        })),
      ),
  );
};

export default {
  "runs-conformance": runsConformance,
  "shared-by-two-groups": sharedByTwoGroups,
  "acyclic-groups": acyclicGroups,
};
