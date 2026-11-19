const located = (f) => (f.file === undefined ? "" : ` (${f.file}${f.line === undefined ? "" : `:${f.line}`})`);
export const reviewPrompt = (scope, shape, instructions) => {
    const later = scope.previousHead !== undefined;
    const parts = [
        "You are an independent reviewer. Do not edit any file, commit, or push; report findings only.",
        `Head: ${scope.head}\nBase: ${scope.base}`,
        later
            ? `This is a later round. Review only each previous finding below and the fix diff ${scope.previousHead}..${scope.head}.`
            : `This is round 1. Review the whole change ${scope.base}..${scope.head}.`,
        `Requirements:\n${scope.requirements.map((r) => `- ${r}`).join("\n")}`,
        `Upheld Practices:\n${scope.upholds.map((u) => `- ${u.id}: ${u.statement}`).join("\n")}`,
    ];
    if (later)
        parts.push(`Previous findings:\n${(scope.previous ?? []).map((f) => `${f.n}. ${f.title}${located(f)}`).join("\n")}`);
    if (instructions !== undefined)
        parts.push(instructions);
    parts.push(`Report in exactly this shape:\n\n${shape}`);
    return parts.join("\n\n");
};
export const reviewError = (reviewedHead, title, correction) => ({
    verdict: "fail",
    reviewedHead,
    findings: [{ n: 1, severity: "environment", title, reproducesOn: [], spec: false, flaky: false, correction }],
});
