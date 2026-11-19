import { posix } from "node:path";
import { reviewError, reviewPrompt } from "./brief.js";
const CHECKS = [
    "Backgrounds and surfaces",
    "Overflow and clipping",
    "Alignment and fill",
    "Spacing tokens",
    "Shared controls",
    "Selection and toggle controls",
    "Nested navigation",
    "Interaction states",
    "Motion and reduced motion",
    "Empty, loading, and error states",
    "Working controls",
    "Data shown",
    "Visual encodings",
];
const SHAPE = `Reviewed head: <full commit id>
| Screen | Check | Result | Screenshot | Source | Correction |
| --- | --- | --- | --- | --- | --- |
| <screen name> | <check name> | PASS or FAIL | <screenshot path> | <repo-relative file>:<line> | <fix on FAIL, use - on PASS> |
`;
const INSTRUCTIONS = [
    "Use the ui-qa skill. Render the real UI from the requested head and follow its visual-testing instructions. Check the full matrix on every round, including 360–480, 1280, and 1920 px, relevant realistic states, and all scroll regions. Inspect the screenshots and compare any available design reference.",
    `For each affected screen, report one row per check and repeat the screen name in every row. Use these exact check names: ${CHECKS.join("; ")}. A verified absence of an affected control or state may pass with the screenshot and source that demonstrate it. Include an actionable correction on each failure. Below the table, record the tested pages, browser setup, viewport sizes, states, and limits from the visual-testing instructions. If the skill, requested UI, or screenshot tooling cannot be run, replace the table with one Environment: <reason> line.`,
].join("\n\n");
const HEADER = "| Screen | Check | Result | Screenshot | Source | Correction |";
const SEPARATOR = /^\|(?:\s*:?-{3,}:?\s*\|){6}$/;
const normalize = (report, scope) => {
    const rows = report.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
    const reviewedHead = /^Reviewed head: (\S+)$/.exec(rows.shift() ?? "")?.[1] ?? "";
    if (reviewedHead !== scope.head) {
        return reviewError(reviewedHead, "The UI QA report does not name the requested head", `the reviewer renders ${scope.head} and starts the report with Reviewed head: ${scope.head}.`);
    }
    const environment = rows.length === 1 ? /^Environment: (.+)$/.exec(rows[0] ?? "")?.[1] : undefined;
    if (environment !== undefined)
        return reviewError(reviewedHead, environment, "restore the environment the reviewer needs to render and inspect the UI, then rerun the full UI QA gate.");
    const invalid = (title) => reviewError(reviewedHead, title, "the reviewer returns the full UI QA checklist with screenshot paths, source locations, and a correction for every failed check.");
    if (rows.shift() !== HEADER || !SEPARATOR.test(rows.shift() ?? ""))
        return invalid("The UI QA report has no checklist table");
    const notes = rows.findIndex((row) => !row.startsWith("|"));
    if (notes !== -1 && rows.splice(notes).some((row) => row.startsWith("|"))) {
        return invalid("The UI QA report has checklist rows after its evidence notes");
    }
    const screens = new Map();
    const findings = [];
    for (const row of rows) {
        const columns = row.split("|").map((cell) => cell.trim());
        const [, screen, name, result, screenshot, source, correction] = columns;
        if (columns.length !== 8 || columns[0] !== "" || columns[7] !== "" || !screen || name === undefined || !CHECKS.includes(name)) {
            return invalid("The UI QA report has an unknown or repeated checklist row");
        }
        const checked = screens.get(screen) ?? new Set();
        const check = `${screen} · ${name}`;
        if (checked.has(name))
            return invalid(`The UI QA report repeats ${check}`);
        const location = /^(.*):([1-9]\d*)$/.exec(source ?? "");
        const file = posix.normalize(location?.[1] ?? "");
        const line = Number(location?.[2]);
        if (screenshot === undefined || screenshot === "" || screenshot === "-" || !Number.isSafeInteger(line) || file === "." || file === ".." || file.startsWith("../") || posix.isAbsolute(file)) {
            return invalid(`The UI QA report has no screenshot or valid source location for ${check}`);
        }
        if (result === "FAIL" && correction !== undefined && correction !== "" && correction !== "-") {
            findings.push({
                n: findings.length + 1, severity: "important", title: check, file, line,
                reproducesOn: ["head"], spec: true, flaky: false, correction, evidence: [screenshot],
            });
        }
        else if (result !== "PASS" || correction !== "-") {
            return invalid(`The UI QA report has no valid result or correction for ${check}`);
        }
        checked.add(name);
        screens.set(screen, checked);
    }
    if (screens.size === 0)
        return invalid("The UI QA report has no screen results");
    for (const [screen, checked] of screens) {
        const missing = CHECKS.find((name) => !checked.has(name));
        if (missing !== undefined)
            return invalid(`The UI QA report has no result for ${screen} · ${missing}`);
    }
    return { verdict: findings.length === 0 ? "pass" : "fail", reviewedHead, findings };
};
export const uiQaReview = {
    id: "ui-qa",
    invocation: (rule, scope) => ({
        tool: "Agent",
        input: {
            description: `UI QA of ${scope.head.slice(0, 12)}`,
            subagent_type: "general-purpose",
            model: rule.model,
            prompt: reviewPrompt(scope, SHAPE, INSTRUCTIONS, "full"),
        },
    }),
    normalize,
};
