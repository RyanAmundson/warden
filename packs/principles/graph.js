import { posix } from "node:path";
import { declaredExports, parsed } from "./code.js";

const stemOf = (file) => file.replace(/\.[mc]?[jt]sx?$/, "").replace(/\/index$/, "");

const unusedExports = (input) => {
  const { ts } = input;
  const files = parsed(input);
  const importers = new Map();
  const stems = new Map(files.map(({ file }) => [stemOf(file), file]));
  const starred = new Set();
  const star = (from, spec) => {
    if (!spec.startsWith(".")) return;
    const target = stems.get(stemOf(posix.normalize(posix.join(posix.dirname(from), spec))));
    if (target !== undefined) starred.add(target);
  };
  const use = (name, file) => importers.set(name, (importers.get(name) ?? new Set()).add(file));
  const namedFrom = (clause) => (clause !== undefined && ts.isNamedImports(clause) ? clause.elements : []);
  for (const { file, text, ast } of files) {
    for (const s of ast.statements) {
      if (ts.isImportDeclaration(s)) {
        for (const e of namedFrom(s.importClause?.namedBindings)) use((e.propertyName ?? e.name).text, file);
        const ns = s.importClause?.namedBindings;
        if (ns !== undefined && ts.isNamespaceImport(ns)) for (const m of text.matchAll(new RegExp(`(?<![\\w$])${ns.name.text.replaceAll("$", "\\$")}\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) use(m[1], file);
      }
      if (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined && s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) use((e.propertyName ?? e.name).text, file);
      if (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined && ts.isStringLiteral(s.moduleSpecifier) && (s.exportClause === undefined || ts.isNamespaceExport(s.exportClause))) star(file, s.moduleSpecifier.text);
    }
  }
  const imported = new Set();
  for (const [from, edges] of input.imports) for (const { target } of edges) if (target !== from) imported.add(target);
  const unused = (name, file) => {
    if (!imported.has(file) || starred.has(file)) return false;
    const by = importers.get(name);
    return by === undefined || (by.size === 1 && by.has(file));
  };
  return files
    .filter((f) => f.reported)
    .flatMap(({ file, ast }) =>
      declaredExports(ts, ast)
        .filter(({ name }) => unused(name, file))
        .map(({ name, line }) => ({ file, line, message: `${name} is exported, but no other file imports it.`, doThis: `Remove the export keyword from ${name}, or delete ${name} if this file does not use it either.` })),
    );
};

export default {
  "unused-exports": unusedExports,
};
