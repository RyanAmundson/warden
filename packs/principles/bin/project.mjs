import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const DECLARATION = /\.d\.[mc]?ts$/;
const TEST = /\.(test|spec|stories)\.[^/]+$/;

const FRAMEWORK_EXPORTS = new Set(["metadata", "generateMetadata", "viewport", "generateViewport", "generateStaticParams", "generateImageMetadata", "generateSitemaps", "dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime", "preferredRegion", "maxDuration", "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "config", "middleware", "loader", "action", "clientLoader", "clientAction", "meta", "links", "headers", "handle", "shouldRevalidate", "ErrorBoundary", "HydrateFallback", "Layout", "load", "prerender", "ssr", "csr", "trailingSlash", "entries"]);

export const usage = () => {
  const [script, ...args] = process.argv.slice(1);
  if (args.length === 0) return;
  console.log(`${script} takes no arguments and got ${args.join(" ")}. Next action: run node "${script}" with no arguments from the project root.`);
  process.exit(2);
};

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = dir === "." ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".git" ? [] : walk(path);
    return e.isFile() ? [path] : [];
  });

const listed = () => {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (inside.stdout?.trim() !== "true") return walk(".");
  const files = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (files.status !== 0) {
    console.log(`git ls-files failed: ${files.stderr.trim()}. Next action: run git ls-files in the project root and fix what it reports.`);
    process.exit(2);
  }
  return files.stdout.split("\0").filter((f) => f !== "" && existsSync(f));
};

export const sourceFiles = () =>
  listed()
    .filter((f) => SOURCE.test(f) && !DECLARATION.test(f))
    .sort()
    .map((file) => ({ file, text: readFileSync(file, "utf8"), reported: !TEST.test(file) }));

export const parsed = () => sourceFiles().map((f) => ({ ...f, ast: ts.createSourceFile(f.file, f.text, ts.ScriptTarget.Latest) }));

export const append = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

export const lineOf = (ast, node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;

const has = (node, kind) => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : []).some((m) => m.kind === kind);

const exported = (node) => has(node, ts.SyntaxKind.ExportKeyword) && !has(node, ts.SyntaxKind.DefaultKeyword);

export const declaredExports = (ast) => {
  const out = [];
  for (const s of ast.statements) {
    if (ts.isVariableStatement(s) && exported(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push({ name: d.name.text, line: lineOf(ast, d) });
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && s.name !== undefined && exported(s)) out.push({ name: s.name.text, line: lineOf(ast, s) });
    if (ts.isExportDeclaration(s) && s.moduleSpecifier === undefined && s.exportClause !== undefined && ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) if (e.name.text !== "default") out.push({ name: e.name.text, line: lineOf(ast, e) });
  }
  const names = new Set(FRAMEWORK_EXPORTS);
  return out.filter((e) => !names.has(e.name) && names.add(e.name));
};

export const report = (violations, summary, action) => {
  if (violations.length === 0) process.exit(0);
  console.log([...violations, `${violations.length} ${summary}. Next action: ${action}`].join("\n"));
  process.exit(1);
};
