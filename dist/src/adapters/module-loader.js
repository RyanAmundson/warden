import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
const TS = /\.[cm]?tsx?$/;
const RELATIVE = /^\.\.?\//;
const bundlerCandidates = (specifier) => {
    const withoutJs = specifier.replace(/\.[cm]?jsx?$/, "");
    return [`${withoutJs}.ts`, `${withoutJs}.tsx`, `${specifier}.ts`, `${specifier}.tsx`, `${specifier}.js`, `${specifier}/index.ts`, `${specifier}/index.tsx`, `${specifier}/index.js`];
};
registerHooks({
    resolve(specifier, context, next) {
        try {
            return next(specifier, context);
        }
        catch (cause) {
            if (!RELATIVE.test(specifier))
                throw cause;
            for (const candidate of bundlerCandidates(specifier)) {
                try {
                    return next(candidate, context);
                }
                catch {
                    continue;
                }
            }
            throw cause;
        }
    },
    load(url, context, next) {
        if (!url.startsWith("file:") || !TS.test(new URL(url).pathname))
            return next(url, context);
        const file = fileURLToPath(url);
        const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
            fileName: file,
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
        });
        return { format: "module", source: outputText, shortCircuit: true };
    },
});
const exportsAsData = (value, path = new Set()) => {
    if (typeof value === "function")
        return { $function: value.name ?? "" };
    if (typeof value === "bigint")
        return value.toString();
    if (typeof value !== "object" || value === null)
        return typeof value === "symbol" ? undefined : value;
    const json = value.toJSON;
    if (typeof json === "function")
        return exportsAsData(json.call(value), path);
    if (path.has(value))
        return "[Circular]";
    path.add(value);
    const data = Array.isArray(value)
        ? value.map((item) => exportsAsData(item, path) ?? null)
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, exportsAsData(item, path)]).filter(([, item]) => item !== undefined));
    path.delete(value);
    return data;
};
const file = process.argv[2];
if (file === undefined)
    throw new Error("module-loader needs the absolute path of the module to load");
const exported = (await import(pathToFileURL(file).href));
process.stdout.write(JSON.stringify(exportsAsData({ ...exported })));
