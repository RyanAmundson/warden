export const fields = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
export function readExternalReport(raw, commit, tracked) {
    const { version, commit: checkedCommit, files, warnings, findings } = fields(raw);
    if (version !== 1 || !Array.isArray(files) || files.length === 0 || !Array.isArray(findings) ||
        typeof warnings !== "number" || !Number.isSafeInteger(warnings) || warnings < 0) {
        throw new Error("Expected a version 1 Warden report with checked files, a warning count, and findings.");
    }
    if (checkedCommit !== commit)
        throw new Error("Report commit does not match the checked snapshot.");
    const seen = new Set();
    for (const file of files) {
        if (typeof file !== "string" || !tracked.has(file) || seen.has(file)) {
            throw new Error("Report repeats or names a file outside the checked commit.");
        }
        seen.add(file);
    }
    return {
        files: [...seen], warnings,
        findings: findings.map((item) => {
            const { file, line, rule, message } = fields(item);
            if (typeof file !== "string" || !seen.has(file) || typeof line !== "number" || !Number.isSafeInteger(line) ||
                line < 0 || typeof rule !== "string" || rule.trim() === "" || typeof message !== "string" || message.trim() === "") {
                throw new Error("Each finding needs a checked file, a nonnegative line number, a rule ID, and a message.");
            }
            return { file, line, rule, message };
        }),
    };
}
