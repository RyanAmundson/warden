import { conformanceOf, groupAncestors, sameModule, stem } from "./groups.js";

export const groupsIn = (files, settings, { allAncestors = false } = {}) => {
  const groups = new Map();
  for (const file of [...files].sort()) {
    for (const group of groupAncestors(file, settings, allAncestors)) {
      const known = groups.get(group.dir) ?? { ...group, files: [] };
      known.files.push(file);
      groups.set(group.dir, known);
      if (!allAncestors) break;
    }
  }
  return [...groups.values()];
};

export const anchorOf = (group) => group.files.find((f) => sameModule(f, group.port)) ?? group.files[0];

const conformancePresent = ({ files, all, settings }) => {
  const present = new Set(all.map(stem));
  return groupsIn(files, settings)
    .filter((group) => !present.has(stem(conformanceOf(group))))
    .map((group) => ({
      file: anchorOf(group),
      message: `Group ${group.name} has no conformance suite.`,
      doThis: `Add ${conformanceOf(group)}, which exports the tests every implementation of ${group.port} must pass.`,
    }));
};

export const kebab = (id) => id.toLowerCase().replaceAll(" ", "-");

const groupNamedByTerm = ({ files, settings, terms }) =>
  groupsIn(files, settings).flatMap((group) => {
    const term = group.term;
    const banned = term === undefined ? undefined : terms.find((t) => t.bans.some((b) => kebab(b) === term));
    if (term !== undefined && banned === undefined && terms.some((t) => kebab(t.id) === term)) return [];
    const message =
      term === undefined
        ? `Group ${group.name} does not end with ${group.suffix}.`
        : banned !== undefined
          ? `Group ${group.name} is named ${term}, which Term ${banned.id} bans.`
          : `Group ${group.name} is named ${term}, which is no defined Term.`;
    const doThis =
      term === undefined
        ? `Rename the folder to ${group.name}${group.suffix}.`
        : banned !== undefined
          ? `Rename the folder to ${kebab(banned.id)}${group.suffix}.`
          : `Define Term ${term} in the project pack, or rename the folder after a defined Term.`;
    return [{ file: anchorOf(group), message, doThis }];
  });

export default {
  "conformance-present": conformancePresent,
  "group-named-by-term": groupNamedByTerm,
};
