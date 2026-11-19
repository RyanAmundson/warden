import { reviewError, reviewPrompt } from "./brief.js";
export const REPORT_SHAPE = `Verdict: PASS | FAIL
Reviewed head: <full commit id>

### <Critical|Important|Minor|Environment> <n>. <title>
- Where: <file>:<line>
- Reproduces on: <head, base, previous>
- Spec: yes | no
- Earlier: <n of the previous finding, only when it is not fixed>
- Flaky: yes | no
- Correction condition: <what makes it pass>`;
const REPRODUCES = ["head", "base", "previous"];
const YES_NO = /^(yes|no)$/;
const field = (f, name, value) => {
    if (name === "Where") {
        const m = /^(.*):(\d+)$/.exec(value);
        f.file = m === null ? value : m[1];
        if (m !== null)
            f.line = Number(m[2]);
        return true;
    }
    if (name === "Reproduces on") {
        f.reproducesOn = value.split(",").map((v) => v.trim());
        return f.reproducesOn.every((v) => REPRODUCES.includes(v));
    }
    if (name === "Earlier") {
        f.earlier = Number(value);
        return /^\d+$/.test(value);
    }
    if (name === "Spec" || name === "Flaky") {
        f[name === "Spec" ? "spec" : "flaky"] = value === "yes";
        return YES_NO.test(value);
    }
    f.correction = value;
    return true;
};
const unreadable = (n, label) => `finding ${n} gives ${label} in the form REPORT_SHAPE gives it.`;
const normalize = (report, scope) => {
    let verdict;
    let reviewedHead = "";
    let problem;
    const findings = [];
    for (const line of report.replaceAll("\r", "").split("\n").map((l) => l.trim())) {
        const v = /^Verdict: (PASS|FAIL)$/.exec(line);
        const h = /^Reviewed head: (\S+)$/.exec(line);
        const heading = /^### (Critical|Important|Minor|Environment) (\d+)\. (.+)$/.exec(line);
        const m = /^- (Where|Reproduces on|Spec|Earlier|Flaky|Correction condition): (.+)$/.exec(line);
        const last = findings[findings.length - 1];
        if (v !== null)
            verdict = v[1] === "PASS" ? "pass" : "fail";
        else if (h !== null)
            reviewedHead = h[1];
        else if (heading !== null)
            findings.push({ n: Number(heading[2]), severity: heading[1].toLowerCase(), title: heading[3], reproducesOn: [], spec: false, flaky: false, correction: "" });
        else if (m !== null && last !== undefined && !field(last, m[1], m[2]))
            problem ??= [`Finding ${last.n} has an unreadable ${m[1]}: ${m[2]}`, unreadable(last.n, m[1])];
    }
    const uncorrected = findings.find((f) => f.correction === "");
    if (uncorrected !== undefined)
        problem ??= [`Finding ${uncorrected.n} has no Correction condition`, unreadable(uncorrected.n, "Correction condition")];
    if (verdict === undefined)
        return reviewError(reviewedHead, "The report has no Verdict line", "the report starts with Verdict: PASS or Verdict: FAIL, as REPORT_SHAPE gives it.");
    if (reviewedHead === "")
        return reviewError(reviewedHead, "The report has no Reviewed head line", `the report gives Reviewed head: ${scope.head} after its Verdict line.`);
    if (reviewedHead !== scope.head)
        return reviewError(reviewedHead, `The report reviewed ${reviewedHead}, not ${scope.head}`, `the reviewer reviews ${scope.head} and reports Reviewed head: ${scope.head}.`);
    if (problem !== undefined)
        return reviewError(reviewedHead, ...problem);
    if (verdict === "fail" && findings.length === 0)
        return reviewError(reviewedHead, "The report says FAIL but no finding could be read", "each finding starts with a line of the form ### <Critical|Important|Minor|Environment> <n>. <title>, as REPORT_SHAPE gives it.");
    return { verdict, reviewedHead, findings };
};
export const superpowersReview = {
    id: "superpowers-review",
    invocation: (rule, scope) => ({
        tool: "Agent",
        input: { description: `Independent review of ${scope.head.slice(0, 12)}`, subagent_type: "general-purpose", model: rule.model, prompt: reviewPrompt(scope, REPORT_SHAPE) },
    }),
    normalize,
};
