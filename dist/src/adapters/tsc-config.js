import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
export const PROJECT_TSCONFIG = "tsconfig.json";
export const GENERATED_TSCONFIG = ".warden/generated/tsconfig.json";
export const TSC_CONFIG_SOURCE = "tsconfig:";
export class TscConfigError extends Error {
    file;
    constructor(file, message) {
        super(message);
        this.file = file;
    }
}
const configDrift = (file) => new TscConfigError(file, "TypeScript configuration differs from the signed Warden lock. Next action: restore the locked configuration, or have a trusted signer recompile and commit the approved change.");
const decode = (bytes) => {
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
        return bytes.toString("utf16le", 2);
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
        return bytes.subarray(2, bytes.length & ~1).swap16().toString("utf16le");
    return bytes.toString("utf8", bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0);
};
export function readTscConfig(tsc, root, project, locked, collect = false) {
    const sources = {};
    const attest = locked !== undefined || collect;
    const physicalRoot = attest ? realpathSync(root) : root;
    const packageAliases = new Map();
    const logicalPath = (path) => {
        let logical = path;
        let matchedLength = 0;
        for (const [physical, original] of packageAliases) {
            if (physical.length <= matchedLength || !path.startsWith(`${physical}${sep}`))
                continue;
            logical = resolve(original, relative(physical, path));
            matchedLength = physical.length;
        }
        return logical;
    };
    const unread = new Set(Object.keys(locked?.sources ?? {}));
    let fatal;
    let readError;
    const config = tsc.getParsedCommandLineOfConfigFile(resolve(root, project), undefined, {
        ...tsc.sys,
        getCurrentDirectory: () => root,
        ...(collect ? { readDirectory: () => [] } : {}),
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => { fatal = diagnostic; },
        realpath(path) {
            const physical = tsc.sys.realpath?.(path) ?? path;
            if (attest && physical !== path) {
                const logical = logicalPath(path);
                const parts = logical.split(sep);
                const packageStart = parts.lastIndexOf("node_modules") + 1;
                if (packageStart > 0 && packageStart < parts.length) {
                    const packageEnd = packageStart + (parts[packageStart]?.startsWith("@") ? 2 : 1);
                    const logicalPackage = parts.slice(0, packageEnd).join(sep);
                    const physicalPackage = tsc.sys.realpath?.(logicalPackage) ?? logicalPackage;
                    if (physical === resolve(physicalPackage, relative(logicalPackage, logical))) {
                        packageAliases.set(physicalPackage, logicalPackage);
                    }
                    else {
                        readError ??= new TscConfigError(path, "TypeScript resolves this package config through a file symlink, so Warden cannot lock its relative inputs portably. Next action: link the package directory or use the actual config path in extends, then run warden compile.");
                    }
                }
            }
            return physical;
        },
        readFile(path) {
            if (!attest)
                return tsc.sys.readFile(path);
            const logical = logicalPath(path);
            const local = relative(root, logical);
            const name = (local.startsWith(`..${sep}`) ? relative(physicalRoot, logical) : local).split(sep).join("/");
            const key = `${TSC_CONFIG_SOURCE}${name}`;
            let bytes;
            try {
                bytes = readFileSync(path);
            }
            catch (cause) {
                const code = cause.code;
                if (code !== "ENOENT" && code !== "ENOTDIR") {
                    readError ??= cause;
                    return undefined;
                }
            }
            const source = bytes?.toString("latin1");
            if (locked !== undefined) {
                const generated = name === GENERATED_TSCONFIG;
                const want = generated ? locked.generated : locked.sources[key];
                const actual = bytes === undefined ? undefined : createHash("sha256").update(generated ? bytes : bytes.toString("latin1")).digest("hex");
                if (want !== actual || (generated && actual === undefined)) {
                    readError ??= configDrift(path);
                    return undefined;
                }
            }
            unread.delete(key);
            if (collect && source !== undefined)
                sources[key] = source;
            return bytes === undefined ? undefined : decode(bytes);
        },
    });
    if (readError !== undefined)
        throw readError;
    const [unreadConfig] = unread;
    if (unreadConfig !== undefined)
        throw configDrift(resolve(root, unreadConfig.slice(TSC_CONFIG_SOURCE.length)));
    return { config, fatal, sources };
}
export async function tscConfigSources(root) {
    const { default: tsc } = await import("typescript");
    const { config, fatal, sources } = readTscConfig(tsc, root, PROJECT_TSCONFIG, undefined, true);
    const problem = fatal ?? config?.errors.find((diagnostic) => diagnostic.code !== 18003);
    if (problem !== undefined) {
        const path = problem.file?.fileName ?? resolve(root, PROJECT_TSCONFIG);
        throw new TscConfigError(path, `TS${problem.code}: ${tsc.flattenDiagnosticMessageText(problem.messageText, " ")} Next action: fix the TypeScript configuration, then run warden compile.`);
    }
    return sources;
}
