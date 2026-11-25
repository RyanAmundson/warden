// Shared helpers for the plugin-compliance rows. Pack code receives the
// TypeScript compiler as `ts` from Warden's adapter, so it imports no tool.
import { posix } from "node:path";

const SOURCE = /\.(?:[cm]?tsx?|[cm]?jsx?)$/;
const SKIPPED = ["node_modules", "dist", "coverage"];
// Tests, stories, fixtures, and declarations may fake the world that production code never touches.
const NON_PRODUCTION = [
  /\.(?:test|spec|stories|fixtures?)(?:\.helpers)?\.[cm]?[jt]sx?$/,
  /\.d\.[cm]?ts$/,
  /(?:^|\/)(?:__tests__|__fixtures__|testing|e2e|scripts)\//,
];

const under = (path, folder) => folder === "." ? path !== ".." && !path.startsWith("../") : path === folder || path.startsWith(`${folder}/`);

// The plugin folder that holds `file`: the most specific match of the `plugins` setting.
// An entry ending in "/*" names each folder directly inside it.
const folderOf = (file, plugins) => {
  let best;
  for (const entry of plugins) {
    let folder;
    if (entry === ".") folder = ".";
    else if (entry.endsWith("/*")) {
      const parent = entry.slice(0, -2);
      const rest = file.startsWith(`${parent}/`) ? file.slice(parent.length + 1).split("/") : [];
      if (rest.length > 1) folder = `${parent}/${rest[0]}`;
    } else if (under(file, entry)) folder = entry;
    if (folder !== undefined && (best === undefined || folder.length > best.length)) best = folder;
  }
  return best;
};

const parsed = new Map();

// Each plugin the files hold, with its own files and its parsed source files.
export function plugins({ files, read, ts, settings }) {
  const byFolder = new Map();
  for (const file of [...files].sort()) {
    const folder = folderOf(file, settings.plugins);
    if (folder === undefined) continue;
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(file);
  }
  const skipped = new Set([...SKIPPED, ...settings.skipFolders]);
  const nonProduction = [...NON_PRODUCTION, ...settings.nonProduction.map((source) => new RegExp(source))];
  return [...byFolder].map(([folder, own]) => {
    const rel = (file) => (folder === "." ? file : file.slice(folder.length + 1));
    const has = new Set(own.map(rel));
    const path = (name) => (folder === "." ? name : `${folder}/${name}`);
    const sources = own
      .filter((file) => SOURCE.test(file) && !posix.dirname(rel(file)).split("/").some((dir) => skipped.has(dir)))
      .map((file) => {
        const text = read(file);
        let hit = parsed.get(file);
        if (hit?.text !== text) {
          hit = { text, source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) };
          parsed.set(file, hit);
        }
        return { file, rel: rel(file), production: !nonProduction.some((re) => re.test(rel(file))), source: hit.source };
      });
    // A finding about a missing file names the plugin's package.json, or its first file.
    const anchor = has.has("package.json") ? path("package.json") : has.has("plugin.ts") ? path("plugin.ts") : own[0];
    return { folder, files: own, has, path, rel, sources, anchor };
  });
}

export const lineOf = (file, node) => file.source.getLineAndCharacterOfPosition(node.getStart(file.source)).line + 1;

// Whether an import or export loads no value: `import type`, or only `type` names.
const typeOnly = (ts, node) => {
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly || (!!node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly));
  }
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return !clause.name && !!bindings && ts.isNamedImports(bindings)
    && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
};

// Every module specifier a file names: imports, re-exports, `import()`, and `require()`.
export function specifiers(ts, file) {
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, line: lineOf(file, node), typeOnly: typeOnly(ts, node) });
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      found.push({ specifier: node.arguments[0].text, line: lineOf(file, node), typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return found;
}

// Each node of the files for which `match` names a gap, as a finding at its line.
export function each(ts, files, match, doThis) {
  const found = [];
  for (const file of files) {
    const visit = (node) => {
      const what = match(node, file);
      if (what) found.push({ file: file.file, line: lineOf(file, node), message: `${file.rel}: ${what}`, doThis });
      ts.forEachChild(node, visit);
    };
    visit(file.source);
  }
  return found;
}

export const relativeTarget = (file, specifier) => posix.normalize(posix.join(posix.dirname(file), specifier));

export const inside = under;

// A module and its subpaths: `fs` covers `fs/promises`.
export const namesModule = (specifier, names) => names.some((name) => specifier === name || specifier.startsWith(`${name}/`));
