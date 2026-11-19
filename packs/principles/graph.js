import { posix } from "node:path";
import { append, declaredExports, parsed } from "./code.js";

const stemOf = (file) => file.replace(/\.[mc]?[jt]sx?$/, "").replace(/\/index$/, "");

const unusedExports = (input) => {
  const { ts } = input;
  const files = parsed(input, input.all);
  const checked = new Set(input.files);
  const importers = new Map();
  const namespaceMembers = new Map();
  const stems = new Map(files.map(({ file }) => [stemOf(file), file]));
  const starred = new Set();
  const targetOf = (from, spec) => {
    const resolved = input.imports.get(from)?.find(({ specifier }) => specifier === spec);
    if (resolved !== undefined) return resolved.target;
    return spec.startsWith(".") ? stems.get(stemOf(posix.normalize(posix.join(posix.dirname(from), spec)))) : undefined;
  };
  const star = (from, spec) => {
    const target = targetOf(from, spec);
    if (target !== undefined) starred.add(target);
  };
  const use = (name, file) => importers.set(name, (importers.get(name) ?? new Set()).add(file));
  const namedFrom = (clause) => (clause !== undefined && ts.isNamedImports(clause) ? clause.elements : []);
  const bound = (pattern, file, spec) => {
    for (const e of pattern.elements) {
      const name = e.propertyName ?? e.name;
      if (e.dotDotDotToken === undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) use(name.text, file);
      else star(file, spec);
    }
  };
  const members = (name, text, file) => {
    for (const m of text.matchAll(new RegExp(`(?<![\\w$])${name.replaceAll("$", "\\$")}\\??\\.([A-Za-z_$][\\w$]*)`, "g"))) use(m[1], file);
  };
  const leftmost = (name) => (ts.isQualifiedName(name) ? leftmost(name.left) : name.text);
  const bare = (node) => (node !== undefined && ts.isParenthesizedExpression(node) ? bare(node.expression) : node);
  const loaded = (node) => {
    const call = bare(node);
    return call !== undefined && ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword && call.arguments[0] !== undefined && ts.isStringLiteralLike(call.arguments[0]) ? call : undefined;
  };
  const awaited = (node) => {
    const inner = bare(node);
    return inner !== undefined && ts.isAwaitExpression(inner) ? loaded(inner.expression) : undefined;
  };
  const dynamic = (file, ast) => {
    const named = new Set();
    const calls = [];
    const declarations = [];
    const identifiers = new Map();
    const receivers = new Set();
    const visit = (node, parent) => {
      if (ts.isIdentifier(node)) append(identifiers, node.text, { node, parent });
      if (ts.isCallExpression(node)) receivers.add(ts.skipOuterExpressions(node.expression));
      if (ts.isTaggedTemplateExpression(node)) receivers.add(ts.skipOuterExpressions(node.tag));
      if (ts.isVariableStatement(node) && !node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const { name, initializer } of node.declarationList.declarations) {
          const call = awaited(initializer);
          if (call !== undefined && ts.isIdentifier(name)) declarations.push({ name, call });
        }
      }
      const call = loaded(node);
      if (call !== undefined && call === node) calls.push(call);
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && awaited(node.initializer) !== undefined) {
        const from = awaited(node.initializer);
        named.add(from);
        bound(node.name, file, from.arguments[0].text);
      }
      if (ts.isPropertyAccessExpression(node) && awaited(node.expression) !== undefined) {
        named.add(awaited(node.expression));
        use(node.name.text, file);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "then" && loaded(node.expression.expression) !== undefined) {
        const from = loaded(node.expression.expression);
        const [callback] = node.arguments;
        const param = callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback.parameters[0]?.name : undefined;
        if (param !== undefined && ts.isObjectBindingPattern(param)) {
          named.add(from);
          bound(param, file, from.arguments[0].text);
        } else if (param !== undefined && ts.isIdentifier(param)) {
          named.add(from);
          members(param.text, callback.body.getText(ast), file);
        }
      }
      if (ts.isImportTypeNode(node)) {
        if (node.qualifier !== undefined) use(leftmost(node.qualifier), file);
        else if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) star(file, node.argument.literal.text);
      }
      ts.forEachChild(node, (child) => visit(child, node));
    };
    visit(ast);
    for (const { name, call } of declarations) {
      const target = targetOf(file, call.arguments[0].text);
      if (target === undefined || target === file) continue;
      const accesses = identifiers.get(name.text).filter(({ node }) => node !== name).map(({ node, parent }) => {
        if (receivers.has(parent)) return undefined;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === node) return parent.name.text;
        if (ts.isElementAccessExpression(parent) && parent.expression === node && ts.isStringLiteralLike(parent.argumentExpression)) return parent.argumentExpression.text;
        return undefined;
      });
      if (accesses.includes(undefined)) continue;
      named.add(call);
      const used = namespaceMembers.get(target) ?? new Set();
      for (const member of accesses) used.add(member);
      namespaceMembers.set(target, used);
    }
    for (const call of calls) if (!named.has(call)) star(file, call.arguments[0].text);
  };
  for (const { file, text, ast } of files) {
    if (text.includes("import(")) dynamic(file, ast);
    for (const s of ast.statements) {
      if (ts.isImportDeclaration(s)) {
        for (const e of namedFrom(s.importClause?.namedBindings)) use((e.propertyName ?? e.name).text, file);
        const ns = s.importClause?.namedBindings;
        if (ns !== undefined && ts.isNamespaceImport(ns)) members(ns.name.text, text, file);
      }
      if (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined && s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) use((e.propertyName ?? e.name).text, file);
      if (ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined && ts.isStringLiteral(s.moduleSpecifier) && (s.exportClause === undefined || ts.isNamespaceExport(s.exportClause))) star(file, s.moduleSpecifier.text);
    }
  }
  const imported = new Set();
  for (const [from, edges] of input.imports) for (const { target } of edges) if (target !== from) imported.add(target);
  const unused = (name, file) => {
    if (!imported.has(file) || starred.has(file) || namespaceMembers.get(file)?.has(name)) return false;
    const by = importers.get(name);
    return by === undefined || (by.size === 1 && by.has(file));
  };
  return files
    .filter((f) => f.reported && checked.has(f.file))
    .flatMap(({ file, ast }) =>
      declaredExports(ts, ast, input.settings.contractExports ?? [])
        .filter(({ name }) => unused(name, file))
        .map(({ name, line }) => ({ file, line, message: `${name} is exported, but no other file imports it.`, doThis: `Remove the export keyword from ${name}, or delete ${name} if this file does not use it either.` })),
    );
};

export default {
  "unused-exports": unusedExports,
};
