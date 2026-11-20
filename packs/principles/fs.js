import { posix } from "node:path";
import { append, declaredExports, isTest, lineOf, parsed, sourceFiles } from "./code.js";

const WINDOW = 8;

const LIST_START = /^(import[\s{*]|export\s+(type\s+)?\{|export\s+\*)/;
const LIST_END = /(\bfrom\s*["'].*|^import\s*["'].*|\}\s*;?)$/;

const outsideLists = () => {
  let inList = false;
  return ({ text }) => {
    if (!inList && !LIST_START.test(text)) return true;
    inList = !LIST_END.test(text);
    return false;
  };
};

const withoutTypeDeclarations = (ts, file, text) => {
  if (!/\.[cm]?tsx?$/.test(file) || !/\b(?:interface|type)\b/.test(text)) return text;
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const parts = [];
  let cursor = 0;
  const visit = (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      const start = node.getStart(ast);
      const endsAtEof = node.end === ast.endOfFileToken.getFullStart();
      if (ast.parseDiagnostics.some((d) => d.length === 0
        ? d.start >= start && (d.start <= node.end || endsAtEof)
        : d.start < node.end && d.start + d.length > start)) return;
      const before = text.slice(cursor, start).replace(/[^\S\r\n\u2028\u2029]+$/, "");
      const breaks = text.slice(start, node.end).replace(/[^\r\n\u2028\u2029]/g, "");
      if (before === "" && parts.at(-1) === " ") parts.pop();
      parts.push(before, breaks || " ");
      cursor = node.end;
      while (/[^\S\r\n\u2028\u2029]/.test(text.charAt(cursor))) cursor++;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return parts.length === 0 ? text : parts.join("") + text.slice(cursor);
};

const duplicateBlocks = (input) => {
  const generatedPaths = input.settings.generatedPaths ?? [];
  const files = input.files.filter((file) => !generatedPaths.some((pattern) => posix.matchesGlob(file, pattern)));
  const ids = new Map();
  const seen = new Map();
  const found = [];
  const significant = (text) =>
    text
      .split("\n")
      .map((line, i) => ({ text: line.trim(), n: i + 1 }))
      .filter(outsideLists())
      .filter(({ text }) => /[A-Za-z0-9]/.test(text) && !/^(\/\/|\/\*|\*)/.test(text))
      .map(({ text, n }) => {
        if (!ids.has(text)) ids.set(text, ids.size);
        return { id: ids.get(text), n };
      });
  for (const { file, text } of sourceFiles(input, files).filter((f) => f.reported)) {
    const lines = significant(withoutTypeDeclarations(input.ts, file, text));
    let block;
    const flush = () => {
      if (block === undefined) return;
      const at = `${block.first.file}:${block.first.start}`;
      found.push({ file, line: block.start, endLine: block.end, message: `Lines ${block.start}-${block.end} repeat the block that starts at ${at}.`, doThis: `Move lines ${block.start}-${block.end} and the block at ${at} into one shared function, and call it from both places.` });
    };
    for (let i = 0; i + WINDOW <= lines.length; i++) {
      const key = lines.slice(i, i + WINDOW).map((l) => l.id).join(",");
      const start = lines[i].n;
      const end = lines[i + WINDOW - 1].n;
      const first = seen.get(key);
      if (first === undefined) seen.set(key, { file, start, end });
      if (first === undefined || (first.file === file && first.end >= start)) continue;
      if (block !== undefined && start <= block.end) block.end = end;
      else {
        flush();
        block = { start, end, first };
      }
    }
    flush();
  }
  return found;
};

const isPort = (file) => {
  const parts = file.split("/");
  return parts.length > 2 && /^\[.*\]$/.test(parts.at(-3)) && parts.at(-1).replace(/\.[^.]+$/, "") === parts.at(-2);
};

const typeName = (ts, type) => (type !== undefined && ts.isTypeReferenceNode(type) ? rightmostName(ts, type.typeName) : undefined);

const rightmostName = (ts, name) => (ts.isQualifiedName(name) ? name.right.text : name.text);

const returnsObject = (ts, body) => {
  const object = (node) => {
    if (node === undefined) return false;
    if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) return object(node.expression);
    if (ts.isConditionalExpression(node)) return object(node.whenTrue) || object(node.whenFalse);
    return ts.isObjectLiteralExpression(node);
  };
  const visit = (node) => {
    if (ts.isReturnStatement(node)) return object(node.expression) || undefined;
    if (ts.isFunctionLike(node)) return undefined;
    return ts.forEachChild(node, visit);
  };
  return body !== undefined && (ts.isBlock(body) ? ts.forEachChild(body, visit) === true : object(body));
};

const methodBody = (ts, ast, node, owner) => {
  if (node.body !== undefined) return node.body;
  if (owner === undefined || !ts.isMethodDeclaration(node)) return undefined;
  const propertyName = (name) => {
    const key = ts.isComputedPropertyName(name) ? name.expression : name;
    if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return key.text;
    return name.getText(ast);
  };
  const name = propertyName(node.name);
  const isStatic = (m) => m.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
  return owner.members.find((member) =>
    ts.isMethodDeclaration(member) && member.body !== undefined &&
    propertyName(member.name) === name && isStatic(member) === isStatic(node),
  )?.body;
};

const literalImplementations = (ts, files, names) => {
  const wanted = new RegExp(`(?<![\\w$])(${[...names].map((n) => n.replaceAll("$", "\\$")).join("|")})(?![\\w$])`);
  const found = new Set();
  for (const { file, ast, text } of files) {
    if (isTest(file) || !wanted.test(text)) continue;
    const add = (name) => {
      if (names.has(name)) found.add(name);
    };
    const visit = (node, parent) => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) add(typeName(ts, node.type));
      if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) {
        const name = typeName(ts, node.type);
        if (names.has(name) && returnsObject(ts, methodBody(ts, ast, node, parent !== undefined && ts.isClassLike(parent) ? parent : undefined))) add(name);
      }
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)) add(typeName(ts, node.type));
      if (ts.isSatisfiesExpression(node) && ts.isObjectLiteralExpression(node.expression)) add(typeName(ts, node.type));
      ts.forEachChild(node, (child) => visit(child, node));
    };
    visit(ast);
  }
  return found;
};

const singleImplementation = (input) => {
  const { ts } = input;
  const files = parsed(input);
  const declared = new Map();
  const classes = new Map();
  const rightmost = (expr) => (ts.isPropertyAccessExpression(expr) ? expr.name.text : ts.isIdentifier(expr) ? expr.text : undefined);
  for (const { file, ast, reported } of files) {
    for (const s of ast.statements) {
      if (reported && ts.isInterfaceDeclaration(s)) append(declared, s.name.text, { file, line: lineOf(ast, s), port: isPort(file) });
      if (!ts.isClassDeclaration(s)) continue;
      for (const h of s.heritageClauses ?? []) {
        if (h.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const t of h.types) {
          const name = rightmost(t.expression);
          if (name !== undefined) append(classes, name, { at: `${file}:${lineOf(ast, s)}`, test: !reported });
        }
      }
    }
  }
  const candidates = [...declared].filter(([name, ds]) => ds.length === 1 && !ds[0].port && (classes.get(name) ?? []).length === 1 && !classes.get(name)[0].test);
  const literals = candidates.length === 0 ? new Map() : literalImplementations(ts, files, new Set(candidates.map(([name]) => name)));
  return candidates
    .filter(([name]) => !literals.has(name))
    .map(([name, [d]]) => {
      const at = classes.get(name)[0].at;
      return { file: d.file, line: d.line, message: `Interface ${name} has one implementation, the class at ${at}.`, doThis: `Delete interface ${name} and use the class at ${at} as the type, until a second implementation exists.` };
    });
};

const duplicateExports = (input) => {
  const homes = new Map();
  for (const { file, ast } of parsed(input).filter((f) => f.reported)) {
    if (/(^|\/)create\.[^/]+$/.test(file)) continue;
    for (const { name, line } of declaredExports(input.ts, ast, input.settings.contractExports ?? [])) append(homes, name, { file, line });
  }
  return [...homes]
    .filter(([, hs]) => hs.length > 1)
    .flatMap(([name, [first, ...rest]]) => {
      const doThis = `Find which declaration owns ${name}, then import it from that file. Rename declarations that mean something different. If a contract requires each file to export ${name}, ask the project owner to add ${name} to contractExports in the settings of pack principles in .warden/config.yaml, then run warden compile.`;
      return rest.map(({ file, line }) => ({ file, line, message: `${name} is also exported from ${first.file}:${first.line}.`, doThis }));
    });
};

export default {
  "duplicate-blocks": duplicateBlocks,
  "single-implementation": singleImplementation,
  "duplicate-exports": duplicateExports,
};
