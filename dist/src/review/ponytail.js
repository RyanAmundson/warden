import { posix } from "node:path";
import { reviewError, reviewPrompt } from "./brief.js";
const SHAPE = `Reviewed head: <full commit id>
<file>:L<first>[-<last>]: <delete|stdlib|native|yagni|shrink>: <what to cut>. <replacement>.
net: -<N> lines possible.`;
const INSTRUCTIONS = "Use the ponytail:ponytail-review skill to review only unnecessary complexity. Include a repository-relative file even for a single-file change. For a finding still open from the previous round, append [earlier N] to the end of its line. If there are no findings, replace the finding and net lines with Lean already. Ship.";
const FINDING = /^(.+):L([1-9]\d*)(?:-([1-9]\d*))?: (delete|stdlib|native|yagni|shrink): (.+?)\. (.+)$/;
const normalize = (report, scope) => {
    const rows = report.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const reviewedHead = /^Reviewed head: (\S+)$/.exec(rows.shift() ?? "")?.[1] ?? "";
    if (reviewedHead !== scope.head) {
        return reviewError(reviewedHead, "The Ponytail report does not name the requested head", `the reviewer reviews ${scope.head} and starts its report with Reviewed head: ${scope.head}.`);
    }
    if (rows.length === 1 && rows[0] === "Lean already. Ship.")
        return { verdict: "pass", reviewedHead, findings: [] };
    const invalid = (title) => reviewError(reviewedHead, title, "the report uses the Ponytail finding and net lines from the review brief.");
    if (!/^net: -\d+ lines possible\.$/.test(rows.pop() ?? "") || rows.length === 0) {
        return invalid("The Ponytail report has no complete findings or clean verdict");
    }
    const findings = [];
    for (const row of rows) {
        const marker = row.indexOf(" [earlier");
        const match = FINDING.exec(marker === -1 ? row : row.slice(0, marker));
        if (match === null)
            return invalid("The Ponytail report has an unreadable finding");
        const [, file, first, last, tag, title, correction] = match;
        const normalized = posix.normalize(file);
        if (normalized === "." || normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
            return invalid("The Ponytail report has a finding outside the repository");
        }
        const line = Number(first);
        const endLine = last === undefined ? undefined : Number(last);
        if (!Number.isSafeInteger(line) || (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line))) {
            return invalid("The Ponytail report has an invalid line range");
        }
        const earlier = marker === -1 ? undefined : Number(/^ \[earlier ([1-9]\d*)\]$/.exec(row.slice(marker))?.[1]);
        if (earlier !== undefined && (!Number.isSafeInteger(earlier) || scope.previousHead === undefined || (scope.previous !== undefined && !scope.previous.some((finding) => finding.n === earlier)))) {
            return invalid("The Ponytail report refers to an unknown previous finding");
        }
        findings.push({
            n: findings.length + 1,
            severity: "minor",
            title: `${tag}: ${title}`,
            file: normalized,
            line,
            ...(endLine === undefined ? {} : { endLine }),
            reproducesOn: earlier === undefined ? ["head"] : ["head", "previous"],
            spec: false,
            ...(earlier === undefined ? {} : { earlier }),
            flaky: false,
            correction: correction,
        });
    }
    return { verdict: "fail", reviewedHead, findings };
};
export const ponytailReview = {
    id: "ponytail-review",
    invocation: (rule, scope) => ({
        tool: "Agent",
        input: {
            description: `Ponytail review of ${scope.head.slice(0, 12)}`,
            subagent_type: "general-purpose",
            model: rule.model,
            prompt: reviewPrompt(scope, SHAPE, INSTRUCTIONS),
        },
    }),
    normalize,
};
