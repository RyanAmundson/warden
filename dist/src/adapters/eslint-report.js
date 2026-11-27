import { isAbsolute, relative, sep } from "node:path";
const fields = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
export function readESLintReport(raw, root, tracked) {
    if (!Array.isArray(raw) || raw.length === 0)
        throw new Error("Expected a nonempty ESLint JSON report.");
    const seen = new Set();
    const files = [];
    const findings = [];
    let warnings = 0;
    for (const entry of raw) {
        const { filePath, messages, errorCount, warningCount } = fields(entry);
        if (typeof filePath !== "string" || !isAbsolute(filePath) || !Array.isArray(messages)) {
            throw new Error("Each ESLint entry needs an absolute file path and a messages array.");
        }
        const file = relative(root, filePath).split(sep).join("/");
        if (!tracked.has(file) || seen.has(file))
            throw new Error(`ESLint report repeats or names a file outside the checked commit: ${file}.`);
        seen.add(file);
        let fileErrors = 0;
        let fileWarnings = 0;
        let ignored = false;
        for (const diagnostic of messages) {
            const { severity, ruleId, line, message, fatal } = fields(diagnostic);
            if ((severity !== 1 && severity !== 2) || typeof message !== "string" ||
                (ruleId !== null && typeof ruleId !== "string") ||
                (line !== undefined && (typeof line !== "number" || !Number.isSafeInteger(line) || line < 0))) {
                throw new Error(`Invalid ESLint diagnostic in ${file}.`);
            }
            if (fatal === true)
                throw new Error(`ESLint could not check ${file}: ${message}`);
            if (severity === 1) {
                fileWarnings++;
                ignored = ruleId === null && line === undefined && message.startsWith("File ignored ");
            }
            else {
                fileErrors++;
                findings.push({ file, line: typeof line === "number" ? line : 0, rule: ruleId ?? "eslint", message });
            }
        }
        if (fileErrors !== errorCount || fileWarnings !== warningCount)
            throw new Error(`ESLint diagnostic counts disagree for ${file}.`);
        if (messages.length === 1 && ignored)
            continue;
        files.push(file);
        warnings += fileWarnings;
    }
    if (files.length === 0)
        throw new Error("ESLint did not check any tracked files.");
    return { files, warnings, findings };
}
