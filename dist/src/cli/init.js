import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { compile } from "../compiler/compile.js";
import { RecordError, loadRecords } from "../records/load.js";
import { initAction, listPacks } from "./packs.js";
import { measureBaseline, writeBaseline } from "../runner/baseline.js";
import { verifyBase } from "../runner/changed.js";
import { registerProject } from "../runner/daemon.js";
import { HOOKS_DIR, doctor, formatDoctor, hooksUnused } from "../runner/doctor.js";
const CONFIG_PATH = ".warden/config.yaml";
const configText = (project, packs, base) => [
    `project: ${JSON.stringify(project)}`,
    `base: ${JSON.stringify(base)}`,
    "packs:",
    ...packs.flatMap((id) => [`  - id: ${id}`, '    paths: ["**/*.{ts,tsx,js,mjs}"]']),
    "tierBudgetMs:",
    "  edit: 2000",
    "  commit: 10000",
    "  boundary: 120000",
    "loopBreakerRepeats: 3",
    "",
].join("\n");
const selectPacks = async (root, wardenRoot, requested) => {
    const available = await listPacks(root, wardenRoot);
    const known = available.map((r) => r.id);
    const action = `Next action: ${initAction(available)}.`;
    if (requested.includes(""))
        throw new Error(`empty pack id in the --packs list. ${action}`);
    const unknown = requested.filter((id) => !known.includes(id));
    if (unknown.length > 0)
        throw new Error(`unknown pack ${unknown.join(", ")}; available packs are ${known.join(", ")}. ${action}`);
    const dup = requested.find((id, i) => requested.indexOf(id) !== i);
    if (dup !== undefined)
        throw new Error(`pack ${dup} is listed more than once. ${action}`);
    if (!requested.includes("core"))
        throw new Error(`core is required because it carries the rules that protect every other rule. Next action: run warden init --packs core,${requested.join(",")}.`);
    return requested;
};
export async function runInit(root, wardenRoot, requested = ["core"], base = "main") {
    if (existsSync(join(root, CONFIG_PATH)))
        throw new RecordError(join(root, ".warden"), "", "already exists; init refuses to overwrite it");
    verifyBase(root, base, ({ tracking }) => `run warden init --base ${tracking ?? "<an existing branch>"}`);
    const packs = await selectPacks(root, wardenRoot, requested);
    const warden = join(root, ".warden");
    const wardenExisted = existsSync(warden);
    const extra = wardenExisted ? readdirSync(warden).filter((e) => e !== "packs").map((e) => `.warden/${e}`) : [];
    if (extra.length > 0)
        throw new Error(`.warden already holds ${extra.join(", ")}, and init must not delete files it did not create. Next action: move or delete ${extra.join(", ")}, then run warden init again.`);
    try {
        await initialize(root, wardenRoot, packs, base);
    }
    catch (cause) {
        if (wardenExisted)
            for (const entry of readdirSync(warden))
                if (entry !== "packs")
                    rmSync(join(warden, entry), { recursive: true, force: true });
        if (!wardenExisted)
            rmSync(warden, { recursive: true, force: true });
        throw cause;
    }
    if (hooksUnused(root))
        execFileSync("git", ["config", "core.hooksPath", HOOKS_DIR], { cwd: root });
    registerProject(root);
    return runDoctor(root, wardenRoot);
}
async function initialize(root, wardenRoot, packs, base) {
    mkdirSync(join(root, ".warden"), { recursive: true });
    writeFileSync(join(root, CONFIG_PATH), configText(basename(root), packs, base));
    const compiled = await compile(root, wardenRoot);
    if (compiled.findings.length > 0) {
        throw new RecordError(CONFIG_PATH, "", compiled.findings.map((f) => f.message).join("; "));
    }
    const set = await loadRecords(root, wardenRoot);
    const guardrails = set.packs.flatMap((p) => p.practices.flatMap((x) => x.guardrails.filter((g) => g.kind !== "instruction")));
    const { baseline, files, unparsed } = await measureBaseline(set, guardrails);
    if (unparsed.length > 0)
        throw new RecordError("", "", `cannot baseline files that do not parse: ${unparsed.join(", ")}. Next action: fix the syntax error, then run warden init again.`);
    writeBaseline(root, baseline);
    const total = Object.values(baseline).reduce((n, e) => n + Object.values(e).reduce((a, b) => a + b, 0), 0);
    process.stdout.write(`Initialized .warden in ${root}: ${guardrails.length} Guardrails, ${total} existing violations baselined across ${files} files.\n`);
}
export async function runDoctor(root, wardenRoot) {
    const health = await doctor(await loadRecords(root, wardenRoot), true);
    process.stdout.write(`${formatDoctor(health)}\n`);
    return health.next === undefined ? 0 : 2;
}
