import { withPackDir } from "../adapters/cmd.js";
import { PARSE_ERROR } from "../adapters/types.js";
const EXAMPLE_LINES = 15;
const ownerOf = (set, id) => {
    for (const practice of set.packs.flatMap((p) => p.practices)) {
        const guardrail = practice.guardrails.find((g) => g.id === id);
        if (guardrail !== undefined)
            return { practice, guardrail };
    }
    return undefined;
};
const byLocation = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
const shellWords = (words) => words.map((f) => `'${f.replaceAll("'", "'\\''")}'`).join(" ");
const nextAction = (failures, set, notes) => {
    if (notes.tampered?.some((t) => t.detail === "no-allowed-signers") === true) {
        return "reinstall Warden from a release that ships its allowed_signers file, then run warden check again.";
    }
    const signed = notes.tampered?.find((t) => (t.commits ?? []).length > 0);
    if (signed !== undefined) {
        const stash = (signed.dirty ?? []).length === 0 ? "" : `git stash push -u -- ${shellWords(signed.dirty ?? [])} && `;
        const groups = [];
        for (const { commit, parent } of signed.commits ?? []) {
            const last = groups[groups.length - 1];
            if (last?.parent === parent)
                last.commits.push(commit);
            else
                groups.push({ parent, commits: [commit] });
        }
        const revert = groups.map((g) => `git revert --no-edit -X ours -m ${g.parent} ${g.commits.join(" ")}`).join(" && ");
        return `run ${stash}${revert} to undo the commits that changed .warden/ without an allowed signature, then run warden check again.`;
    }
    if (notes.tampered?.some((t) => t.detail === "base-moved") === true) {
        return "revert the base change in .warden/config.yaml and run warden compile.";
    }
    const weakened = notes.tampered?.find((t) => t.detail === "weakened-kind");
    if (weakened !== undefined)
        return `restore kind ${weakened.was} on ${weakened.guardrail} and run warden compile.`;
    if (notes.tampered !== undefined && notes.tampered.length > 0) {
        const sources = notes.tampered.flatMap((t) => t.sources ?? []);
        if (sources.length === 0)
            return `revert your change to ${[...new Set(notes.tampered.map((t) => t.file))].join(", ")}.`;
        const files = [...new Set([...sources, ...notes.tampered.filter((t) => t.sources === undefined && t.file !== ".warden/lock.json").map((t) => t.file)])];
        return `revert your change to ${files.join(", ")}, then run warden compile.`;
    }
    if ((notes.unstaged ?? []).length > 0) {
        if (notes.base === undefined)
            throw new Error("an unstaged note needs the base to name the next command");
        return `run git add -- ${shellWords(notes.unstaged ?? [])}, then run warden check --base ${notes.base}.`;
    }
    const parse = failures.filter((v) => v.guardrail === PARSE_ERROR).sort(byLocation)[0];
    if (parse !== undefined)
        return `fix the syntax error at ${parse.file}:${parse.line}.`;
    if (notes.repeated !== undefined) {
        return "stop editing this file; in your reply, name the rule and file, quote its Do this line, and say why it does not fit; then continue with other work.";
    }
    const located = failures.filter((v) => v.file !== "");
    const legacy = failures.find((v) => v.file === "" && ownerOf(set, v.guardrail)?.guardrail.implementation.startsWith("cmd:") === true);
    if (located.length === 0 && legacy !== undefined) {
        const { guardrail } = ownerOf(set, legacy.guardrail);
        return `run \`${withPackDir(guardrail.implementation.slice(guardrail.implementation.indexOf(":") + 1), guardrail.packDir)}\` and fix what it reports.`;
    }
    if (failures.length > 0) {
        return 'change the code at the lines above to match "Do this". Do not edit .warden/ or generated config; that is recorded as tampering.';
    }
    const killed = notes.killed?.[0];
    if (killed !== undefined)
        return `run \`${killed.command}\` directly to see why it does not finish.`;
    if ((notes.overBudget ?? []).length > 0)
        return "continue your task; nothing in your code failed.";
    return null;
};
const indent = (text) => text.split("\n").join(`\n${" ".repeat(12)}`);
export function formatFeedback(failures, set, format, notes = {}) {
    const items = [...failures]
        .sort(byLocation)
        .map((v) => {
        const owner = ownerOf(set, v.guardrail);
        const mustPass = owner?.guardrail.mustPass;
        const example = typeof mustPass === "string" ? mustPass.replace(/\n+$/, "").split("\n").slice(0, EXAMPLE_LINES).join("\n") : undefined;
        return {
            file: v.file,
            line: v.line,
            guardrail: v.guardrail,
            practice: owner?.practice.id ?? v.guardrail,
            rule: owner?.practice.statement ?? v.message,
            message: v.message,
            doThis: v.doThis ?? example,
            why: owner === undefined ? undefined : `warden explain ${owner.practice.id}`,
        };
    });
    const timing = (label, list, reason) => list.map(({ guardrail, ms, budgetMs }) => {
        const owner = ownerOf(set, guardrail);
        return {
            label,
            guardrail,
            practice: owner?.practice.id ?? guardrail,
            rule: owner?.practice.statement,
            reason: reason(Math.round(ms), budgetMs !== undefined ? `the ${budgetMs} ms shared` : owner === undefined ? "its" : `its ${owner.guardrail.budgetMs} ms`),
            why: owner === undefined ? undefined : `warden explain ${owner.practice.id}`,
        };
    });
    const slow = [
        ...timing("FAIL project", notes.killed ?? [], (ms, budget) => `stopped at ${ms} ms: did not finish within ${budget} budget`),
        ...timing("WARDEN DEFECT", notes.overBudget ?? [], (ms, budget) => `finished in ${ms} ms, over ${budget} budget; its result counted and the overrun is recorded as a Warden defect`),
    ];
    const next = nextAction(failures, set, notes);
    const tampered = notes.tampered ?? [];
    if (format === "json") {
        return JSON.stringify({ failures: items, tampered, unstaged: notes.unstaged, repeated: notes.repeated, overBudget: notes.overBudget, killed: notes.killed, next });
    }
    const lines = tampered.map((t) => `TAMPERED ${t.file}  ${t.detail}`);
    lines.push(...(notes.unstaged ?? []).map((f) => `UNSTAGED ${f}  the commit tier judges what you stage; this working copy differs from the index`));
    for (const item of items) {
        lines.push(`FAIL ${item.file === "" ? "project" : `${item.file}:${item.line}`}  ${item.practice}`);
        lines.push(`  Rule:     ${item.rule}`);
        if (item.file === "" || !item.message.includes(item.rule))
            lines.push(`  Output:   ${indent(item.message)}`);
        if (item.doThis !== undefined)
            lines.push(`  Do this:  ${indent(item.doThis)}`);
        if (item.why !== undefined)
            lines.push(`  Why:      ${item.why}`);
    }
    for (const item of slow) {
        lines.push(`${item.label}  ${item.practice}`);
        if (item.rule !== undefined)
            lines.push(`  Rule:     ${item.rule}`);
        lines.push(`  Reason:   ${item.reason}`);
        if (item.why !== undefined)
            lines.push(`  Why:      ${item.why}`);
    }
    if (notes.repeated !== undefined) {
        lines.push(`Same failure ${notes.repeated.n} times: ${notes.repeated.guardrail} in ${notes.repeated.file}.`);
    }
    if (next !== null)
        lines.push(`Next action: ${next}`);
    return lines.join("\n");
}
