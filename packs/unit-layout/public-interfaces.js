import { posix } from "node:path";

const compiler = (ts, files, read, key, ignoreCase, entries) => {
  const directories = new Set(["/"]);
  for (const file of files.keys()) {
    for (let folder = posix.dirname(`/${file}`); !directories.has(folder); folder = posix.dirname(folder)) {
      directories.add(folder);
    }
  }
  const lookup = (path) => files.get(key(posix.relative("/", path)));
  const readFile = (path) => {
    const file = lookup(path);
    return file === undefined ? undefined : read(file);
  };
  const host = {
    getSourceFile: (path, languageVersion) => {
      const source = readFile(path);
      return source === undefined ? undefined : ts.createSourceFile(path, source, languageVersion, true);
    },
    getDefaultLibFileName: () => "",
    writeFile: () => { throw new Error("Public interface checking does not emit files."); },
    getCurrentDirectory: () => "/",
    getCanonicalFileName: key,
    useCaseSensitiveFileNames: () => !ignoreCase,
    getNewLine: () => "\n",
    fileExists: (path) => lookup(path) !== undefined,
    readFile,
    directoryExists: (path) => directories.has(key(path)),
  };
  const options = {
    allowJs: true, noLib: true, types: [], module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve,
  };
  const resolution = ts.createModuleResolutionCache("/", key, options);
  const program = ts.createProgram(entries.map((file) => `/${file}`), options, host);
  const checker = program.getTypeChecker();
  const readExports = (file) => {
    const entry = program.getSourceFile(`/${file}`);
    const issues = new Set();
    const visited = new Set();
    const visit = (source) => {
      if (visited.has(source)) return;
      visited.add(source);
      const path = lookup(source.fileName);
      if (!ts.isExternalModule(source) || source.statements.some((statement) => ts.isExportAssignment(statement) && statement.isExportEquals)) {
        issues.add(`${path} must use ES module exports. Use export {} for an empty public entry.`);
      }
      if (program.getSyntacticDiagnostics(source).length > 0) issues.add(`${path} has syntax errors.`);
      const wildcards = source.statements.filter((statement) =>
        ts.isExportDeclaration(statement) && statement.exportClause === undefined
        && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier));
      for (const statement of wildcards) {
        const specifier = statement.moduleSpecifier.text;
        const resolved = specifier.startsWith("./") || specifier.startsWith("../")
          ? ts.resolveModuleName(specifier, source.fileName, options, host, resolution).resolvedModule : undefined;
        const target = resolved === undefined ? undefined : program.getSourceFile(resolved.resolvedFileName);
        if (target === undefined) {
          issues.add(`${path} cannot resolve wildcard export ${JSON.stringify(specifier)} to a regular project file.`);
          continue;
        }
        visit(target);
      }
      if (wildcards.length > 1) {
        for (const diagnostic of program.getSemanticDiagnostics(source)) {
          if (diagnostic.code !== 2308) continue;
          issues.add(`${path} has ambiguous wildcard exports. ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
        }
      }
    };
    visit(entry);
    const symbol = checker.getSymbolAtLocation(entry);
    const names = symbol === undefined ? [] : checker.getExportsOfModule(symbol).map((item) => item.getName());
    return { names: names.sort(), issues };
  };
  return readExports;
};

export const publicInterfaces = (input) => {
  const { files, nonRegular = [], read, markdownSections, markdownListLabels, unitStructure } = input;
  if (unitStructure === undefined) return [];
  const { units, ignoreCase, owners } = unitStructure;
  const declared = units.filter((unit) => unit.publicEntry !== undefined);
  if (declared.length === 0) return [];
  const key = (path) => ignoreCase ? path.normalize("NFC").toLowerCase() : path;
  const excluded = new Set(nonRegular);
  const regular = new Map(files.filter((file) => !excluded.has(file)).map((file) => [key(file), file]));
  const found = [];
  const ready = [];
  for (const unit of declared) {
    const entryPath = posix.join(unit.folder, unit.publicEntry);
    const entry = regular.get(key(entryPath));
    if (entry === undefined || owners[entry] !== unit.id) {
      found.push({
        file: entry ?? "", message: `Unit ${unit.id} needs a regular public entry it owns at ${entryPath}.`,
        doThis: `Create ${entryPath} in Unit ${unit.id}, or set publicEntry to a file that the Unit owns and run warden compile.`,
      });
      continue;
    }
    const document = regular.get(key(unit.document));
    const contents = document === undefined || owners[document] !== unit.id ? "" : read(document);
    if (!markdownSections(contents).includes("Interfaces")) {
      found.push({
        file: document ?? "", message: `Unit ${unit.id} needs a regular document with an Interfaces section at ${unit.document}.`,
        doThis: `Add a level-two Interfaces heading to the Unit document at ${unit.document}.`,
      });
      continue;
    }
    ready.push({ entry, document, contents });
  }
  if (ready.length === 0) return found;
  const readExports = compiler(input.ts, regular, read, key, ignoreCase, ready.map(({ entry }) => entry));
  for (const { entry, document, contents } of ready) {
    const { names, issues } = readExports(entry);
    for (const message of issues) {
      found.push({ file: entry, message, doThis: "Fix the public entry or its re-exports, then update Interfaces with the resulting public names." });
    }
    if (issues.size > 0) continue;
    const documented = new Set(markdownListLabels(contents, "Interfaces"));
    for (const name of names) {
      if (documented.has(name)) continue;
      found.push({
        file: document, message: `${entry} exports ${JSON.stringify(name)}, which Interfaces does not list.`,
        doThis: `Start a list item in the Interfaces section with ${JSON.stringify(name)} formatted as inline code.`,
      });
    }
  }
  return found;
};
