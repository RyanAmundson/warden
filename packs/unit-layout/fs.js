import { matchesGlob, posix } from "node:path";

const ROOT_DOCS = new Set(["README.md", "AGENTS.md"]);
const CONTROL = new Set([".git", ".warden", ".claude", ".agents"]);

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
    if (/\.md$/i.test(file)) {
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

const documentLinks = ({ files, nonRegular = [], read, markdownLinks, unitStructure }) => {
  if (unitStructure === undefined) return [];
  const { units, ignoreCase } = unitStructure;
  const key = (path) => ignoreCase ? path.normalize("NFC").toLowerCase() : path;
  const documents = new Set([...ROOT_DOCS, ...units.map((unit) => unit.document)].map(key));
  const nonRegularEntries = new Set(nonRegular);
  const regularFiles = new Set(files.filter((file) => !nonRegularEntries.has(file)).map(key));
  const folders = new Set(["."]);
  for (const file of files) {
    for (let folder = posix.dirname(key(file)); !folders.has(folder); folder = posix.dirname(folder)) folders.add(folder);
  }
  const found = [];
  for (const file of files) {
    if (!documents.has(key(file)) || nonRegularEntries.has(file)) continue;
    for (const href of new Set(markdownLinks(read(file)))) {
      if (isExternal(href)) continue;
      const target = localTarget(file, href);
      if (target !== undefined) {
        const path = key(target.path);
        if (folders.has(path) || (!target.directory && regularFiles.has(path))) continue;
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

export default { "unit-layout": unitLayout, "document-links": documentLinks };
