import { resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import ts from "typescript";

export interface TscRequest {
  cwd: string;
  project: string;
}

export interface TscReply {
  stdout: string;
  code: number;
}

let reusedFor = "";
const parsed = new Map<string, { text: string; file: ts.SourceFile }>();

const check = ({ cwd, project }: TscRequest): TscReply => {
  const format = (ds: readonly ts.Diagnostic[]): string =>
    ts.formatDiagnostics(ds, { getCanonicalFileName: (f) => f, getCurrentDirectory: () => cwd, getNewLine: () => "\n" });
  let fatal: ts.Diagnostic | undefined;
  const config = ts.getParsedCommandLineOfConfigFile(resolve(cwd, project), undefined, {
    ...ts.sys,
    getCurrentDirectory: () => cwd,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      fatal = d;
    },
  });
  if (config === undefined) return { stdout: format(fatal === undefined ? [] : [fatal]), code: 1 };
  const key = JSON.stringify(config.options);
  if (key !== reusedFor) {
    parsed.clear();
    reusedFor = key;
  }
  const host = ts.createCompilerHost(config.options);
  const read = host.getSourceFile;
  host.getCurrentDirectory = () => cwd;
  host.getSourceFile = (fileName, version, onError, create) => {
    if (!fileName.includes("/node_modules/")) return read(fileName, version, onError, create);
    const text = host.readFile(fileName);
    const at = `${fileName}\0${JSON.stringify(version)}`;
    const hit = parsed.get(at);
    if (hit !== undefined && hit.text === text) return hit.file;
    const file = read(fileName, version, onError, create);
    if (file !== undefined && text !== undefined) parsed.set(at, { text, file });
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
    if (all.length === fromConfig) all.push(...program.getSemanticDiagnostics());
  }
  const diagnostics = ts.sortAndDeduplicateDiagnostics(all);
  const files = program.getSourceFiles().map((f) => `${f.fileName}\n`);
  return { stdout: format(diagnostics) + files.join(""), code: diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error) ? 1 : 0 };
};

parentPort?.on("message", (request: TscRequest) => parentPort?.postMessage(check(request)));
