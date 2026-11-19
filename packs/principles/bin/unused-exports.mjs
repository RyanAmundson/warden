import { posix } from "node:path";
import ts from "typescript";
import { declaredExports, parsed, report, usage } from "./project.mjs";

usage();

const files = parsed();
const importers = new Map();

const stems = new Map(files.map(({ file }) => [file.replace(/\.[^./]+$/, "").replace(/\/index$/, ""), file]));
const starred = new Set();

const star = (from, spec) => {
  if (!spec.startsWith(".")) return;
  const target = stems.get(posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.[mc]?[jt]sx?$/, "").replace(/\/index$/, ""));
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

const unused = (name, file) => {
  if (starred.has(file)) return false;
  const by = importers.get(name);
  return by === undefined || (by.size === 1 && by.has(file));
};

const violations = files.filter((f) => f.reported).flatMap(({ file, ast }) =>
  declaredExports(ast)
    .filter(({ name }) => unused(name, file))
    .map(({ name, line }) => `${file}:${line}: ${name} is exported, but no other file imports it`),
);

report(violations, "export(s) that no other file imports", "remove the export keyword from each listed name, or delete it if this file does not use it either.");
