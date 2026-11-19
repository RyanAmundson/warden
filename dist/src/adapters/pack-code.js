import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isOsJunk, packFiles } from "../compiler/lock.js";
import { RecordError } from "../records/load.js";
export const targetOf = (g) => g.implementation.slice(g.implementation.indexOf(":") + 1);
const confined = new Set();
const BUILTINS = new Set(builtinModules);
const RELATIVE = /^\.\.?(\/|$)/;
async function refuseEscapes(packDir, entry, packFile, pointer) {
    if (confined.has(entry))
        return;
    const sources = new Set((await packFiles(dirname(packDir), basename(packDir))).map((key) => join(dirname(packDir), key)));
    const { default: ts } = await import("typescript");
    const inside = (path) => path.startsWith(`${packDir}${sep}`);
    if (!inside(entry)) {
        throw new RecordError(packFile, pointer, `${entry} is outside the pack folder ${packDir}, so the lock cannot see it. Next action: replace the link with the file itself inside ${packDir}, then run warden compile.`);
    }
    const refuse = (message, action) => {
        throw new RecordError(packFile, pointer, `${message}. Next action: ${action}, then run warden compile.`);
    };
    const outside = (file, spec) => refuse(`${file} imports ${spec}, which is outside the pack folder ${packDir}, so the lock cannot see it`, `move what ${spec} provides into ${packDir} and import it by a relative path inside that folder`);
    const refuseJunk = (message) => refuse(message, "rename the file to a name that is not OS junk, and point the code at the new name");
    const seen = new Set();
    const pending = [entry];
    const follow = (file, spec, how) => {
        if (spec.startsWith("node:") || BUILTINS.has(spec))
            return;
        if (!RELATIVE.test(spec) || !inside(resolve(dirname(file), spec)))
            outside(file, spec);
        let target = resolve(dirname(file), spec);
        if (how === "require") {
            try {
                target = createRequire(file).resolve(spec);
            }
            catch {
                refuse(`${file} requires ${spec}, which names no file that Node can load`, `make ${spec} in ${file} name a file inside ${packDir}`);
            }
        }
        else if (!existsSync(target)) {
            refuse(`${file} imports ${spec}, which names no file`, `make ${spec} in ${file} name a file inside ${packDir}, with its extension`);
        }
        else if (statSync(target).isDirectory()) {
            refuse(`${file} imports the folder ${spec}, which Node's ES module loader refuses`, `import the file inside it by its full name, such as ${spec}/index.js, in ${file}`);
        }
        const real = realpathSync(target);
        if (!inside(real))
            outside(file, spec);
        if (isOsJunk(basename(real)) || isOsJunk(basename(target)) || !sources.has(real))
            refuseJunk(`${file} loads ${spec}, which is an OS junk file that the lock does not hash`);
        pending.push(real);
    };
    while (pending.length > 0) {
        const file = pending.pop();
        if (seen.has(file) || !/\.[cm]?js$/.test(file))
            continue;
        seen.add(file);
        const literal = (node) => (node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined);
        const visit = (node) => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
                follow(file, literal(node.moduleSpecifier), "import");
            }
            else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
                const spec = literal(node.arguments[0]);
                if (spec !== undefined)
                    follow(file, spec, node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import" : "require");
            }
            if (ts.isStringLiteralLike(node) && isOsJunk(basename(node.text))) {
                refuseJunk(`${file} names ${node.text}, an OS junk file that the lock does not hash`);
            }
            ts.forEachChild(node, visit);
        };
        visit(ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
    }
    confined.add(entry);
}
export async function packEntry(g, adapter) {
    const target = targetOf(g);
    const [namespace, name] = target.split("/", 2);
    const packFile = g.packDir === undefined ? "pack.yaml" : join(g.packDir, "pack.yaml");
    const pointer = `/guardrails/${g.id}/implementation`;
    const pack = g.packDir === undefined ? undefined : basename(g.packDir);
    if (name === undefined || namespace !== pack) {
        throw new RecordError(packFile, pointer, `${adapter}:${target} names no code shipped by this pack. Next action: set implementation of Guardrail ${g.id} to ${adapter}:${pack ?? "<pack>"}/<name> in ${packFile}, then run warden compile.`);
    }
    const packDir = g.packDir;
    const file = join(packDir, `${adapter}.js`);
    if (!existsSync(file)) {
        throw new RecordError(packFile, pointer, `pack ${pack} ships no ${adapter}.js. Next action: add ${file} whose default export maps ${name} to its implementation, then run warden compile.`);
    }
    const real = realpathSync(file);
    await refuseEscapes(realpathSync(packDir), real, packFile, pointer);
    return { file, real, name, namespace, guardrail: g.id, implementation: g.implementation, packDir, packFile, pointer };
}
