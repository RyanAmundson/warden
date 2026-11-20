import { matchesGlob, posix } from "node:path";

const ROOT_DOCS = new Set(["README.md", "AGENTS.md"]);
const CONTROL = new Set([".git", ".warden", ".claude", ".agents"]);
const MARKDOWN = /\.(?:md|markdown|mdown|mkdn)$/i;

const documentPaths = (units, key) => new Set([...ROOT_DOCS, ...units.map((unit) => unit.document)].map(key));

const unitLayout = ({ files, nonRegular = [], read, markdownSections, unitStructure }) => {
  if (unitStructure === undefined) return [];
  const { units, ignoreCase, owners } = unitStructure;
  const key = (path) => ignoreCase ? path.normalize("NFC").toLowerCase() : path;
  const found = [];
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const documents = new Set();
  const nonRegularEntries = new Set(nonRegular);
  const missing = new Set();
  for (const file of files) {
    const folder = posix.dirname(file);
    const unit = byId.get(owners[file]);
    const top = file.split("/", 1)[0].toLowerCase();
    if (CONTROL.has(top) && unit?.folder.split("/", 1)[0].toLowerCase() !== top) continue;
    const doc = unit !== undefined && key(file) === key(unit.document);
    if (doc) {
      documents.add(unit.id);
      if (nonRegularEntries.has(file)) {
        found.push({
          file, message: `Unit ${unit.id} needs a regular Markdown document at ${file}.`,
          doThis: `Replace ${file} with a regular Markdown document.`,
        });
        continue;
      }
      const actual = markdownSections(read(file));
      const required = unit.kindRecord.sections;
      if (actual.length !== required.length || required.some((heading, i) => actual[i] !== heading)) {
        found.push({
          file, message: `Unit ${unit.id} needs these level-two sections in order: ${required.join(", ")}.`,
          doThis: `Set the level-two headings in ${file} to ${required.join(", ")} in that order. Use deeper headings within a section.`,
        });
      }
      continue;
    }
    if (folder === "." && ROOT_DOCS.has(file) && !nonRegularEntries.has(file)) continue;
    if (MARKDOWN.test(file)) {
      found.push({
        file,
        message: unit === undefined ? `${file} has no owning Unit.` : `Unit ${unit.id} already has a document at ${unit.document}.`,
        doThis: unit === undefined ? `Declare an owning Unit for ${folder} and move the documentation into its declared document.` : `Move the documentation into ${unit.document} and remove ${file}.`,
      });
      continue;
    }
    if (unit === undefined) {
      const unowned = nonRegularEntries.has(file) ? file : folder;
      if (unowned !== "." && !missing.has(key(unowned))) {
        missing.add(key(unowned));
        found.push({ file, message: `${unowned} has no owning Unit.`, doThis: `Declare an owning Unit or move ${file} into the Unit that owns it.` });
      }
      continue;
    }
    const layout = unit.kindRecord.layout;
    const relative = posix.relative(key(unit.folder), key(file));
    if (layout !== undefined && !layout.some((glob) => matchesGlob(relative, key(glob)))) {
      found.push({
        file, message: `${file} is outside the layout for Unit kind ${unit.kind}.`,
        doThis: `Move ${file} to a path allowed by the layout of ${unit.kind}, or have the project owner amend the layout and run warden compile.`,
      });
    }
  }
  for (const unit of units) {
    if (documents.has(unit.id)) continue;
    found.push({
      file: "", message: `Unit ${unit.id} is missing its document at ${unit.document}.`,
      doThis: `Create ${unit.document} with the required level-two headings: ${unit.kindRecord.sections.join(", ")}.`,
    });
  }
  return found;
};

const isExternal = (href) => /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href);

const localTarget = (file, href) => {
  const pathname = href.split(/[?#]/, 1)[0];
  if (pathname === "") return { path: file, directory: false };
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const target = decoded.startsWith("/") ? posix.normalize(decoded.slice(1)) : posix.join(posix.dirname(file), decoded);
  return { path: target.replace(/\/$/, "") || ".", directory: decoded.endsWith("/") };
};

const termTarget = (href) => {
  try {
    return decodeURIComponent(href.slice("term:".length));
  } catch {
    return undefined;
  }
};

const documentLinks = ({ files, nonRegular = [], read, markdownLinks, markdownAnchors, terms, unitStructure }) => {
  if (unitStructure === undefined) return [];
  const { units, ignoreCase } = unitStructure;
  const key = (path) => ignoreCase ? path.normalize("NFC").toLowerCase() : path;
  const documents = documentPaths(units, key);
  const termIds = new Set(terms.map(({ id }) => id));
  const nonRegularEntries = new Set(nonRegular);
  const regularFiles = new Map(files.filter((file) => !nonRegularEntries.has(file)).map((file) => [key(file), file]));
  const folders = new Set(["."]);
  for (const file of files) {
    for (let folder = posix.dirname(key(file)); !folders.has(folder); folder = posix.dirname(folder)) folders.add(folder);
  }
  const found = [];
  const anchors = new Map();
  const hasAnchor = (file, fragment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(fragment);
    } catch {
      return false;
    }
    if (!anchors.has(file)) anchors.set(file, new Set(markdownAnchors(read(file))));
    return anchors.get(file).has(decoded);
  };
  for (const file of files) {
    if (!documents.has(key(file)) || nonRegularEntries.has(file)) continue;
    for (const href of new Set(markdownLinks(read(file)))) {
      if (/^term:/i.test(href)) {
        if (termIds.has(termTarget(href))) continue;
        found.push({
          file,
          message: `The link ${href} does not name a configured Term.`,
          doThis: `In ${file}, point ${href} to the exact Term ID from a configured pack. Percent-encode spaces and special characters.`,
        });
        continue;
      }
      if (isExternal(href)) continue;
      const target = localTarget(file, href);
      if (target !== undefined) {
        const path = key(target.path);
        if (folders.has(path)) continue;
        const destination = target.directory ? undefined : regularFiles.get(path);
        if (destination !== undefined) {
          const hash = href.indexOf("#");
          const fragment = hash < 0 ? "" : href.slice(hash + 1);
          if (fragment === "" || !MARKDOWN.test(destination) || hasAnchor(destination, fragment)) continue;
          found.push({
            file,
            message: `The link ${href} in ${file} does not name a heading or anchor in ${destination}.`,
            doThis: `In ${file}, update ${href} to point to the intended heading or anchor.`,
          });
          continue;
        }
      }
      found.push({
        file,
        message: `The link ${href} in ${file} does not name a regular file or folder in the repository.`,
        doThis: `In ${file}, update ${href} to point to the intended file or folder.`,
      });
    }
  }
  return found;
};

const normalizeProse = (text) => text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
const sentenceParts = (text) => normalizeProse(text).split(/(?<=[.!?]) /);
const definitionKey = (text) => text.replace(/[.!?]+$/, "");

const termDefinitions = ({ files, nonRegular = [], read, markdownProse, unitStructure }) => {
  if (unitStructure === undefined) return [];
  const { units, ignoreCase, termDefinitions } = unitStructure;
  const key = (path) => ignoreCase ? path.normalize("NFC").toLowerCase() : path;
  const documents = documentPaths(units, key);
  const nonRegularEntries = new Set(nonRegular);
  const definitions = new Map();
  const labels = new Set();
  let maxSentences = 0;
  for (const { id, definition } of termDefinitions) {
    const sentences = sentenceParts(markdownProse(definition, true).join(" "));
    const normalized = definitionKey(sentences.join(" "));
    if (normalized === "") continue;
    labels.add(normalizeProse(id));
    const ids = definitions.get(normalized) ?? [];
    ids.push(id);
    definitions.set(normalized, ids);
    maxSentences = Math.max(maxSentences, sentences.length);
  }
  const found = [];
  for (const file of files) {
    if (!documents.has(key(file)) || nonRegularEntries.has(file)) continue;
    const duplicates = new Set();
    for (const block of markdownProse(read(file))) {
      const parts = sentenceParts(block);
      for (let start = 0; start < parts.length; start++) {
        let text = "";
        for (let end = start; end < Math.min(parts.length, start + maxSentences); end++) {
          text = end === start ? parts[end] : `${text} ${parts[end]}`;
          const normalized = definitionKey(text);
          for (const id of definitions.get(normalized) ?? []) duplicates.add(id);
          for (const { index } of normalized.matchAll(/: /g)) {
            if (!labels.has(normalized.slice(0, index))) continue;
            for (const id of definitions.get(normalized.slice(index + 2)) ?? []) duplicates.add(id);
          }
        }
      }
    }
    for (const id of duplicates) {
      found.push({
        file,
        message: `${file} duplicates the definition of Term ${id}.`,
        doThis: `In ${file}, replace the repeated definition with a link to term:${encodeURIComponent(id)}.`,
      });
    }
  }
  return found;
};

export default { "unit-layout": unitLayout, "document-links": documentLinks, "term-definitions": termDefinitions };
