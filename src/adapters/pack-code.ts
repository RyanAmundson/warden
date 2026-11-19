import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Node as TsNode } from "typescript";
import { packFiles } from "../compiler/lock.js";
import { RecordError } from "../records/load.js";
import type { Guardrail } from "../records/types.js";

export const targetOf = (g: Guardrail): string => g.implementation.slice(g.implementation.indexOf(":") + 1);

const confined = new Set<string>();

const BUILTINS = new Set(builtinModules);

const UNSAFE_BUILTINS = new Set(["vm", "child_process", "module", "worker_threads"]);

const DYNAMIC = new Set(["eval", "Function", "createRequire", "getBuiltinModule", "constructor", "binding", "_linkedBinding", "dlopen", "mainModule"]);

const RELATIVE = /^\.\.?(\/|$)/;

async function refuseEscapes(packDir: string, entry: string, packFile: string, pointer: string): Promise<void> {
  if (confined.has(entry)) return;
  await packFiles(dirname(packDir), basename(packDir));
  const { default: ts } = await import("typescript");
  const inside = (path: string): boolean => path.startsWith(`${packDir}${sep}`);
  if (!inside(entry)) {
    throw new RecordError(packFile, pointer, `${entry} is outside the pack folder ${packDir}, so the lock cannot see it. Next action: replace the link with the file itself inside ${packDir}, then run warden compile.`);
  }
  const refuse = (message: string, action: string): never => {
    throw new RecordError(packFile, pointer, `${message}. Next action: ${action}, then run warden compile.`);
  };
  const outside = (file: string, spec: string): never =>
    refuse(`${file} imports ${spec}, which is outside the pack folder ${packDir}, so the lock cannot see it`, `move what ${spec} provides into ${packDir} and import it by a relative path inside that folder`);
  const seen = new Set<string>();
  const pending = [entry];
  const follow = (file: string, spec: string, how: "import" | "require"): void => {
    const name = spec.replace(/^node:/, "").split("/")[0] as string;
    if (spec.startsWith("node:") || BUILTINS.has(spec)) {
      if (UNSAFE_BUILTINS.has(name)) refuse(`${file} imports ${spec}, which can run code the lock does not hash`, `remove ${spec} from ${file}`);
      if (!spec.startsWith("node:")) refuse(`${file} imports the built-in ${spec} without the node: prefix`, `import it as node:${spec} in ${file}`);
      return;
    }
    if (!RELATIVE.test(spec) || !inside(resolve(dirname(file), spec))) outside(file, spec);
    let target = resolve(dirname(file), spec);
    if (how === "require") {
      try {
        target = createRequire(file).resolve(spec);
      } catch {
        refuse(`${file} requires ${spec}, which names no file that Node can load`, `make ${spec} in ${file} name a file inside ${packDir}`);
      }
    } else if (!existsSync(target)) {
      refuse(`${file} imports ${spec}, which names no file`, `make ${spec} in ${file} name a file inside ${packDir}, with its extension`);
    } else if (statSync(target).isDirectory()) {
      refuse(`${file} imports the folder ${spec}, which Node's ES module loader refuses`, `import the file inside it by its full name, such as ${spec}/index.js, in ${file}`);
    }
    const real = realpathSync(target);
    if (!inside(real)) outside(file, spec);
    pending.push(real);
  };
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const ext = extname(file);
    if (ext === ".json") continue;
    if (![".js", ".mjs", ".cjs"].includes(ext)) refuse(`${file} is loaded as pack code but is not JavaScript or JSON, so Warden cannot check what it loads`, `replace ${file} with a .js file`);
    const literal = (node: TsNode | undefined): string | undefined => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined);
    const visit = (node: TsNode): void => {
      const parent = node.parent;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
        follow(file, literal(node.moduleSpecifier) as string, "import");
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const how = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : "require";
        const spec = literal(node.arguments[0]);
        if (spec === undefined) refuse(`${file} calls ${how}() with a computed path, which Warden cannot follow`, `pass ${how}() a fixed relative path inside ${packDir}`);
        follow(file, spec as string, how);
      } else if (ts.isIdentifier(node)) {
        const named = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node;
        if (DYNAMIC.has(node.text)) refuse(`${file} uses ${node.text}, which can run code the lock does not hash`, `remove ${node.text} from ${file}`);
        if (!named && node.text === "require" && !(ts.isCallExpression(parent) && parent.expression === node)) {
          refuse(`${file} uses require other than to call it with a fixed path`, `call require with a fixed relative path in ${file}`);
        }
        if (!named && node.text === "module" && !(ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "exports")) {
          refuse(`${file} uses module other than as module.exports, which can load code the lock does not hash`, `use module.exports or export in ${file}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  }
  confined.add(entry);
}

export async function packCode<T>(g: Guardrail, adapter: string): Promise<T> {
  const target = targetOf(g);
  const [namespace, name] = target.split("/", 2) as [string, string | undefined];
  const packFile = g.packDir === undefined ? "pack.yaml" : join(g.packDir, "pack.yaml");
  const pointer = `/guardrails/${g.id}/implementation`;
  const pack = g.packDir === undefined ? undefined : basename(g.packDir);
  if (name === undefined || namespace !== pack) {
    throw new RecordError(packFile, pointer, `${adapter}:${target} names no code shipped by this pack. Next action: set implementation of Guardrail ${g.id} to ${adapter}:${pack ?? "<pack>"}/<name> in ${packFile}, then run warden compile.`);
  }
  const file = join(g.packDir as string, `${adapter}.js`);
  if (!existsSync(file)) {
    throw new RecordError(packFile, pointer, `pack ${pack} ships no ${adapter}.js. Next action: add ${file} whose default export maps ${name} to its implementation, then run warden compile.`);
  }
  await refuseEscapes(realpathSync(g.packDir as string), realpathSync(file), packFile, pointer);
  const shipped = ((await import(pathToFileURL(file).href)) as { default?: Record<string, unknown> }).default ?? {};
  if (!Object.hasOwn(shipped, name)) {
    throw new RecordError(packFile, pointer, `${file} exports no ${name}. Next action: add ${name} to the default export of ${file}, then run warden compile.`);
  }
  return shipped[name] as T;
}
