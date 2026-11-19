const DECLARATION = /\.d\.[mc]?ts$/;
const TEST = /\.(test|spec|stories)\.[^/]+$/;

const FRAMEWORK_EXPORTS = new Set(["metadata", "generateMetadata", "viewport", "generateViewport", "generateStaticParams", "generateImageMetadata", "generateSitemaps", "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime", "preferredRegion", "maxDuration", "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "config", "middleware", "loader", "action", "clientLoader", "clientAction", "meta", "links", "headers", "handle", "shouldRevalidate", "ErrorBoundary", "HydrateFallback", "Layout", "load", "prerender", "ssr", "csr", "trailingSlash", "entries"]);

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

export const isTest = (file) => TEST.test(file);

export const sourceFiles = ({ files, read }, list = files) =>
  [...list]
    .filter((f) => CODE.test(f) && !DECLARATION.test(f))
    .sort()
    .map((file) => ({ file, text: read(file), reported: !TEST.test(file) }));

export const parsed = (input, list = input.files) => sourceFiles(input, list).map((f) => ({ ...f, ast: input.ts.createSourceFile(f.file, f.text, input.ts.ScriptTarget.Latest) }));

export const append = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

export const lineOf = (ast, node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;

export const declaredExports = (ts, ast, allowed = []) => {
  const has = (node, kind) => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === kind);
  const exported = (node) => has(node, ts.SyntaxKind.ExportKeyword) && !has(node, ts.SyntaxKind.DefaultKeyword);
  const out = [];
  for (const s of ast.statements) {
    if (ts.isVariableStatement(s) && exported(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, line: lineOf(ast, d) });
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && s.name !== undefined && exported(s)) out.push({ name: s.name.text, line: lineOf(ast, s) });
    if (ts.isExportDeclaration(s) && s.moduleSpecifier === undefined && s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) if (e.name.text !== "default") out.push({ name: e.name.text, line: lineOf(ast, e) });
  }
  const names = new Set([...FRAMEWORK_EXPORTS, ...allowed]);
  return out.filter((e) => !names.has(e.name) && names.add(e.name));
};
