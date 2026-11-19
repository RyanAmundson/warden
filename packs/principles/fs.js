import { append, declaredExports, lineOf, parsed, sourceFiles } from "./code.js";

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

const duplicateBlocks = (input) => {
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
  for (const { file, text } of sourceFiles(input).filter((f) => f.reported)) {
    const lines = significant(text);
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

const singleImplementation = (input) => {
  const { ts } = input;
  const declared = new Map();
  const implementers = new Map();
  const rightmost = (expr) => (ts.isPropertyAccessExpression(expr) ? expr.name.text : ts.isIdentifier(expr) ? expr.text : undefined);
  for (const { file, ast, reported } of parsed(input)) {
    for (const s of ast.statements) {
      if (reported && ts.isInterfaceDeclaration(s)) append(declared, s.name.text, { file, line: lineOf(ast, s), port: isPort(file) });
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
  return [...declared]
    .filter(([name, ds]) => ds.length === 1 && !ds[0].port && (implementers.get(name) ?? []).length === 1)
    .map(([name, [d]]) => ({ file: d.file, line: d.line, message: `Interface ${name} has one implementation, the class at ${implementers.get(name)[0]}.`, doThis: `Delete interface ${name} and use the class at ${implementers.get(name)[0]} as the type, until a second implementation exists.` }));
};

const duplicateExports = (input) => {
  const homes = new Map();
  for (const { file, ast } of parsed(input).filter((f) => f.reported)) {
    if (/(^|\/)create\.[^/]+$/.test(file)) continue;
    for (const { name, line } of declaredExports(input.ts, ast)) append(homes, name, { file, line });
  }
  return [...homes]
    .filter(([, hs]) => hs.length > 1)
    .flatMap(([name, [first, ...rest]]) =>
      rest.map(({ file, line }) => ({ file, line, message: `${name} is also exported from ${first.file}:${first.line}.`, doThis: `Import ${name} from ${first.file} instead of declaring it here, or rename it here if it means something different.` })),
    );
};

export default {
  "duplicate-blocks": duplicateBlocks,
  "single-implementation": singleImplementation,
  "duplicate-exports": duplicateExports,
};
