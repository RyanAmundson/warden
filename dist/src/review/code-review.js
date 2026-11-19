import { Ajv } from "ajv";
import { posix } from "node:path";
import { reviewError, reviewPrompt } from "./brief.js";
const PR_URL = /^https:\/\/github\.com\/([a-z\d][a-z\d-]*)\/([\w.-]+)\/pull\/[1-9]\d*$/i;
export const isPullRequestUrl = (value) => value !== undefined && PR_URL.test(value) && new URL(value).pathname === value.slice("https://github.com".length);
const CLEAN = "No issues found. Checked for bugs and CLAUDE.md compliance.";
const SHAPE = `Return one JSON object without Markdown fences:
{
  "pullRequest": "<pull request URL>",
  "reviewedBase": "<verified merge-base SHA>",
  "reviewedHead": "<verified full head SHA>",
  "nativeSummary": "<actual terminal summary from code-review:code-review>",
  "findings": [
    { "title": "<validated issue>", "file": "<repository-relative path>",
      "line": <first head line>, "endLine": <last head line, optional>,
      "source": "<exact excerpt of nativeSummary identifying this issue>",
      "correction": "<what would fix the issue>", "earlier": <matching previous finding number, optional> }
  ]
}
Use an empty findings array only with the exact clean terminal summary: ${CLEAN}
If the review was skipped, invalidated, or a finding cannot be located, return an object with "error" describing why the review could not be completed. Preserve the native summary if you have it.`;
const line = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonempty = { type: "string", pattern: "\\S" };
const valid = new Ajv().compile({
    type: "object", additionalProperties: false,
    required: ["pullRequest", "reviewedBase", "reviewedHead", "nativeSummary", "findings"],
    properties: {
        pullRequest: nonempty, reviewedBase: nonempty, reviewedHead: nonempty, nativeSummary: nonempty,
        findings: {
            type: "array",
            items: {
                type: "object", additionalProperties: false,
                required: ["title", "file", "line", "source", "correction"],
                properties: { title: nonempty, file: nonempty, line, endLine: line, source: nonempty, correction: nonempty, earlier: line },
            },
        },
    },
});
const sourcePath = (file) => !posix.isAbsolute(file) && !file.includes("\0") &&
    file.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
const readReport = (report) => {
    try {
        return JSON.parse(report);
    }
    catch {
        return undefined;
    }
};
export const codeReviewBase = (report) => {
    const body = readReport(report);
    return valid(body) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(body.reviewedBase) ? body.reviewedBase : undefined;
};
const normalize = (report, scope) => {
    const invalid = (head, title) => reviewError(head, title, "rerun the native read-only Code Review invocation and save its exact scope, summary, and findings as JSON.");
    const body = readReport(report);
    if (body === undefined)
        return invalid("", "The Code Review report is unreadable");
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
        return invalid("", `Code Review did not complete: ${body.error}`);
    }
    if (!valid(body))
        return invalid("", "The Code Review report lacks required scope or finding evidence");
    const { pullRequest, reviewedBase, reviewedHead, nativeSummary } = body;
    if (pullRequest !== scope.pullRequest || reviewedBase !== scope.base || reviewedHead !== scope.head) {
        return invalid(reviewedHead, "The Code Review report names a different pull request, merge base, or head");
    }
    const clean = nativeSummary.trim() === CLEAN;
    if (clean !== (body.findings.length === 0))
        return invalid(reviewedHead, "The Code Review summary and findings disagree");
    const committed = clean ? undefined : scope.committedChanges?.(reviewedBase, reviewedHead);
    const findings = [];
    for (const { title, file, line, endLine, source, correction, earlier } of body.findings) {
        if (!sourcePath(file) || (endLine !== undefined && endLine < line) || !nativeSummary.includes(source)) {
            return invalid(reviewedHead, "The Code Review finding has an invalid location or lacks matching native evidence");
        }
        if (!committed?.[file]?.some(([first, last]) => line >= first && (endLine ?? line) <= last)) {
            return invalid(reviewedHead, `The Code Review location ${file}:${line} is outside the added or modified lines of the committed pull request`);
        }
        if (earlier !== undefined && (scope.previousHead === undefined || (scope.previous !== undefined && !scope.previous.some((f) => f.n === earlier)))) {
            return invalid(reviewedHead, "The Code Review report refers to an unknown previous finding");
        }
        findings.push({
            n: findings.length + 1, severity: "important", title, file, line, correction, evidence: [source],
            ...(endLine === undefined ? {} : { endLine }),
            ...(earlier === undefined ? {} : { earlier }),
            reproducesOn: earlier === undefined ? ["head"] : ["head", "previous"],
            spec: false, flaky: false,
        });
    }
    return { verdict: clean ? "pass" : "fail", reviewedHead, findings };
};
export const codeReview = {
    id: "code-review",
    invocation: (rule, scope) => {
        if (!isPullRequestUrl(scope.pullRequest))
            throw new Error("Code Review needs a GitHub pull request URL");
        const instructions = [
            `Use gh read-only to verify the pull request URL ${scope.pullRequest}, its headRefOid, and its baseRefOid. Verify that the merge base of baseRefOid and headRefOid is ${scope.base} and that headRefOid is ${scope.head}. Stop if the commits are unavailable or differ from this scope. If the merge base has changed, give its verified SHA and tell the caller to rerun the brief with that --base.`,
            `Run the code-review:code-review skill on ${scope.pullRequest} without --comment. Keep this review read-only. Never post comments, reviews, or other GitHub updates.`,
            "Capture the terminal summary. Read the pull request metadata again and discard the report if either commit changed during the review. If the skill skipped the review, report the reason as an error.",
            "For each native finding, verify its file and location against the pull request diff at the reviewed head. Give one added or modified head line for the location, or a range entirely within one added or modified block. If any finding lacks a verifiable location or correction, report it as an error and preserve the native summary. Use earlier only for findings that match the previous findings listed above.",
        ].join("\n");
        return {
            tool: "Agent",
            input: {
                description: `GitHub Code Review of ${scope.head.slice(0, 12)}`,
                subagent_type: "general-purpose",
                model: rule.model,
                prompt: reviewPrompt(scope, SHAPE, instructions, "full"),
            },
        };
    },
    normalize,
};
