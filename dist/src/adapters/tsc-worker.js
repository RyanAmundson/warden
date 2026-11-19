import { resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import ts from "typescript";
const parameterNames = (file) => {
    const out = [];
    const visit = (node) => {
        if (ts.isParameter(node))
            out.push([node.name.getStart(file), node.name.end]);
        const types = node.typeParameters;
        if (types !== undefined)
            out.push([types.pos - 1, types.end]);
        if (ts.isInferTypeNode(node))
            out.push([node.getStart(file), node.end]);
        ts.forEachChild(node, visit);
    };
    visit(file);
    return out;
};
const atParameter = (d) => d.file !== undefined && d.start !== undefined && parameterNames(d.file).some(([from, to]) => d.start >= from && d.start < to);
const registry = ts.createDocumentRegistry();
export const parseKey = (options) => registry.getKeyForCompilationSettings(options);
let reusedFor = "";
const parsed = new Map();
const check = ({ cwd, project, parameterCodes }) => {
    const format = (ds) => ts.formatDiagnostics(ds, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => cwd, getNewLine: () => "\n" });
    let fatal;
    const config = ts.getParsedCommandLineOfConfigFile(resolve(cwd, project), undefined, {
        ...ts.sys,
        getCurrentDirectory: () => cwd,
        onUnRecoverableConfigFileDiagnostic: (d) => {
            fatal = d;
        },
    });
    if (config === undefined)
        return { stdout: format(fatal === undefined ? [] : [fatal]), code: 1, parameters: [] };
    const key = parseKey(config.options);
    if (key !== reusedFor) {
        parsed.clear();
        reusedFor = key;
    }
    const host = ts.createCompilerHost(config.options);
    const read = host.getSourceFile;
    host.getCurrentDirectory = () => cwd;
    host.getSourceFile = (fileName, version, onError, create) => {
        if (!fileName.includes("/node_modules/"))
            return read(fileName, version, onError, create);
        const text = host.readFile(fileName);
        const at = `${fileName}\0${JSON.stringify(version)}`;
        const hit = parsed.get(at);
        if (hit !== undefined && hit.text === text)
            return hit.file;
        const file = read(fileName, version, onError, create);
        if (file !== undefined && text !== undefined)
            parsed.set(at, { text, file });
        return file;
    };
    const program = ts.createProgram({
        rootNames: config.fileNames,
        options: config.options,
        host,
        projectReferences: config.projectReferences,
        configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(config),
    });
    const all = [...program.getConfigFileParsingDiagnostics()];
    const fromConfig = all.length;
    all.push(...program.getSyntacticDiagnostics());
    if (all.length === fromConfig) {
        all.push(...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics());
        if (all.length === fromConfig)
            all.push(...program.getSemanticDiagnostics());
    }
    const diagnostics = ts.sortAndDeduplicateDiagnostics(all);
    const files = program.getSourceFiles().map((f) => `${f.fileName}\n`);
    const parameters = diagnostics.filter((d) => parameterCodes.includes(d.code) && atParameter(d)).map((d) => format([d]).slice(0, format([d]).indexOf("): ") + 1));
    return { stdout: format(diagnostics) + files.join(""), code: diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error) ? 1 : 0, parameters };
};
parentPort?.on("message", (request) => parentPort?.postMessage(check(request)));
