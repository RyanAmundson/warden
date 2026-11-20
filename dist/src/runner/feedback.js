import { dirname, resolve } from "node:path";
import { runIt } from "../adapters/cmd.js";
import { PARSE_ERROR } from "../adapters/types.js";
const sourceName = (file) => {
    const script = /^\.\/package\.json#scripts\/(.+)$/.exec(file)?.[1];
    return script === undefined ? file : `the "${script}" script in package.json`;
};
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
const patternOf = (dir) => dir
    .replace(/[*?[\]\\]/g, "\\$&")
    .replace(/^[!#]/, "\\$&")
    .replace(/ +$/, (spaces) => spaces.replaceAll(" ", "\\ "));
const nextAction = (failures, set, notes) => {
    if (notes.tampered?.some((t) => t.detail === "no-allowed-signers") === true) {
        return "reinstall Warden from a release that ships its allowed_signers file, then run warden check again.";
    }
    const restore = notes.tampered?.find((t) => t.restore !== undefined)?.restore;
    const others = (notes.tampered ?? []).filter((t) => t.restore === undefined);
    if (restore !== undefined && others.every((t) => [t.file, ...(t.sources ?? [])].every((f) => restore.paths.includes(f)))) {
        const unstage = restore.unstage.length === 0 ? "" : `git --literal-pathspecs rm -q -f --cached --ignore-unmatch -- ${shellWords(restore.unstage)} && `;
        const stray = restore.stray.length === 0 ? "" : `${unstage}git --literal-pathspecs clean -ff -x -- ${shellWords(restore.stray)} && `;
        const back = restore.known.length === 0 ? "" : `git --literal-pathspecs restore --source=${restore.base} --staged --worktree -- ${shellWords(restore.known)} && `;
        const commit = restore.aliased ? "git commit --allow-empty -m 'Restore .warden files changed without an allowed signature'" : `git --literal-pathspecs commit --only --allow-empty -m 'Restore .warden files changed without an allowed signature' -- ${shellWords(restore.paths)}`;
        return `run ${stray}${back}${commit} to restore the .warden/ files changed without an allowed signature to the merge base, then run warden check again.`;
    }
    if (others.some((t) => t.detail === "base-moved")) {
        return "revert the base change in .warden/config.yaml and run warden compile.";
    }
    const weakened = others.find((t) => t.detail === "weakened-kind");
    if (weakened !== undefined)
        return `restore kind ${weakened.was} on ${weakened.guardrail} and run warden compile.`;
    if (others.some((t) => t.detail === "typescript-config-drift")) {
        return "restore the locked TypeScript configuration, or have a trusted signer run warden compile and commit the updated configuration and lock.";
    }
    if (others.length > 0) {
        const sources = others.flatMap((t) => t.sources ?? []);
        if (sources.length === 0) {
            const strays = [...new Set(others.filter((t) => t.untracked === true).map((t) => t.file))];
            const reverts = [...new Set(others.filter((t) => t.untracked !== true).map((t) => t.file))];
            return [...(strays.length === 0 ? [] : [`delete ${strays.join(", ")}`]), ...(reverts.length === 0 ? [] : [`revert your change to ${reverts.map(sourceName).join(", ")}`])].join(", then ") + ".";
        }
        const files = [...new Set([...sources, ...others.filter((t) => t.sources === undefined && t.file !== ".warden/lock.json").map((t) => t.file)])];
        return `revert your change to ${files.map(sourceName).join(", ")}, then run warden compile.`;
    }
    if ((notes.hidden ?? []).length > 0) {
        if (notes.base === undefined)
            throw new Error("a hidden note needs the base to name the next command");
        const files = notes.hidden?.map((f) => `'${f.replaceAll("'", "'\\''")}'`).join(" ") ?? "";
        return `run git update-index --no-skip-worktree -- ${files}, then git update-index --no-assume-unchanged -- ${files}, then run warden check --base ${notes.base}.`;
    }
    if ((notes.unstaged ?? []).length > 0) {
        if (notes.base === undefined)
            throw new Error("an unstaged note needs the base to name the next command");
        return `run git add${(notes.sparse ?? "off") === "off" ? "" : " --sparse"} -- ${shellWords(notes.unstaged ?? [])}, then run warden check --base ${notes.base}.`;
    }
    const parse = failures.filter((v) => v.guardrail === PARSE_ERROR).sort(byLocation)[0];
    if (parse !== undefined)
        return `fix the syntax error at ${parse.file}:${parse.line}.`;
    if (notes.repeated !== undefined) {
        const command = `warden dispute ${shellWords([notes.repeated.guardrail, resolve(set.root, notes.repeated.file)])}`;
        return `stop editing this file and run ${command} with --reason and --attempt describing what you tried, then continue with other work.`;
    }
    const located = failures.filter((v) => v.file !== "");
    const legacy = failures.find((v) => v.file === "" && ownerOf(set, v.guardrail)?.guardrail.implementation.startsWith("cmd:") === true);
    if (located.length === 0 && legacy !== undefined) {
        const { guardrail } = ownerOf(set, legacy.guardrail);
        return runIt(guardrail);
    }
    if (located.length === 0 && failures.length === 1 && failures[0]?.doThis !== undefined)
        return failures[0].doThis;
    if (located.length === 0 && failures.some((failure) => failure.doThis !== undefined))
        return 'follow "Do this" for the project findings above.';
    const outside = [...new Set(failures.map((v) => v.file).filter((f) => notes.outside?.includes(f) === true))].sort();
    if (outside.length > 0) {
        const dirs = [...new Set(outside.map((f) => (dirname(f) === "." ? f : dirname(f))))];
        const sparse = notes.sparse ?? "off";
        const bring = sparse === "cone" && dirs.every((d) => d === d.trim())
            ? `git sparse-checkout add --skip-checks -- ${shellWords(dirs)}`
            : sparse === "patterns"
                ? `git sparse-checkout add -- ${shellWords(dirs.map(patternOf))}`
                : `git update-index --no-skip-worktree -- ${shellWords(outside)}, then git checkout -- ${shellWords(outside)}`;
        return `run ${bring} to bring ${outside.join(", ")} onto disk, then change the code at the lines above to match "Do this".`;
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
    const lines = tampered.map((t) => `TAMPERED ${t.file}  ${t.detail}${t.guardrail === undefined ? "" : ` ${t.guardrail}`}`);
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
