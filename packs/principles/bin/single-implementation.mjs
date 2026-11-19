import ts from "typescript";
import { append, lineOf, parsed, report, usage } from "./project.mjs";

usage();

const files = parsed();
const declared = new Map();
const implementers = new Map();

const isPort = (file) => {
  const parts = file.split("/");
  return parts.length > 2 && /^\[.*\]$/.test(parts.at(-3)) && parts.at(-1).replace(/\.[^.]+$/, "") === parts.at(-2);
};

const rightmost = (expr) => (ts.isPropertyAccessExpression(expr) ? expr.name.text : ts.isIdentifier(expr) ? expr.text : undefined);

for (const { file, ast } of files) {
  for (const s of ast.statements) {
    if (ts.isInterfaceDeclaration(s)) append(declared, s.name.text, { file, line: lineOf(ast, s), port: isPort(file) });
    if (!ts.isClassDeclaration(s)) continue;
    for (const h of s.heritageClauses ?? []) {
      if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue;
      for (const t of h.types) {
        const name = rightmost(t.expression);
        if (name !== undefined) append(implementers, name, `${file}:${lineOf(ast, s)}`);
      }
    }
  }
}

const violations = [...declared]
  .filter(([name, ds]) => ds.length === 1 && !ds[0].port && (implementers.get(name) ?? []).length === 1)
  .map(([name, [d]]) => `${d.file}:${d.line}: interface ${name} has one implementation, the class at ${implementers.get(name)[0]}`)
  .sort();

report(violations, "interface(s) with one implementation", "delete each listed interface and use its class as the type, until a second implementation exists.");
