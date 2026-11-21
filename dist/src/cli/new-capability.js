import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { isAlias, isSeq, parseDocument, visit } from "yaml";
import { checkConsistency } from "../compiler/consistency.js";
import { checkCommands } from "../compiler/skills.js";
import { RecordError, checkCapability, loadRecords, readText } from "../records/load.js";
export async function runNewCapability(root, wardenRoot, packId, declaration) {
    const control = join(root, ".warden");
    const config = join(control, "config.yaml");
    const lock = join(control, "capability-scaffold.lock");
    if (!lstatSync(control, { throwIfNoEntry: false })?.isDirectory()) {
        throw new RecordError(control, "", "A Capability needs a real .warden directory. Next action: initialize the checkout with warden init or restore its .warden directory.");
    }
    let lockFd;
    try {
        lockFd = openSync(lock, "wx", 0o600);
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        throw new RecordError(lock, "", "Another Capability scaffold holds this lock. Next action: wait for the other scaffold process to finish, then retry. If it already exited, remove this leftover lock first.");
    }
    const stopped = new AbortController();
    const stop = () => stopped.abort(new Error("Capability scaffolding was interrupted. Next action: run the scaffold command again."));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
        writeFileSync(lockFd, `${process.pid}\n`);
        const useLocal = "Select an enabled .warden/packs/<id>/pack.yaml with --pack.";
        if (packId === "" || packId === "." || packId === ".." || basename(packId) !== packId || packId.includes("\\")) {
            throw new RecordError(config, "/packs", `Use a local pack ID. Next action: ${useLocal}`);
        }
        const dir = join(control, "packs", packId);
        const file = join(dir, "pack.yaml");
        const mode = lstatSync(file, { throwIfNoEntry: false });
        if (mode === undefined) {
            throw new RecordError(config, "/packs", `Capability records belong in local packs. Next action: ${useLocal}`);
        }
        if (!mode.isFile() || mode.nlink !== 1 || realpathSync(file) !== join(realpathSync(root), ".warden", "packs", packId, "pack.yaml")) {
            throw new RecordError(file, "", "The local pack needs a regular file it owns. Next action: restore a regular pack.yaml file and retry.");
        }
        const original = readFileSync(file, "utf8");
        const configSource = await readText(config);
        if (configSource === undefined)
            throw new RecordError(config, "", "Project config is missing. Next action: run warden init.");
        const set = await loadRecords(root, wardenRoot);
        const pack = set.packs.find(({ id }) => id === packId);
        if (pack?.file !== file) {
            throw new RecordError(config, "/packs", `The local pack is disabled. Next action: ${useLocal}`);
        }
        checkCapability(file, declaration);
        const amended = parseDocument(original);
        const existing = amended.get("capabilities", true);
        const records = pack.capabilities.map(({ pack: _pack, ...record }) => record);
        if (isSeq(existing)) {
            if (existing.anchor !== undefined) {
                visit(amended, {
                    Alias: (_, alias) => {
                        if (alias.resolve(amended) !== existing)
                            return;
                        const copy = amended.createNode(records);
                        copy.comment = alias.comment;
                        copy.commentBefore = alias.commentBefore;
                        return copy;
                    },
                });
            }
            amended.addIn(["capabilities"], declaration);
        }
        else {
            const list = amended.createNode([...records, declaration]);
            if (isAlias(existing)) {
                list.comment = existing.comment;
                list.commentBefore = existing.commentBefore;
            }
            amended.set("capabilities", list);
        }
        const output = amended.toString();
        const capability = { ...declaration, pack: pack.id };
        const nextPack = { ...pack, capabilities: [...pack.capabilities, capability] };
        const next = { ...set, packs: set.packs.map((entry) => entry === pack ? nextPack : entry) };
        const prior = new Map();
        for (const finding of checkConsistency(set, new Map())) {
            const key = JSON.stringify(finding);
            prior.set(key, (prior.get(key) ?? 0) + 1);
        }
        const finding = checkConsistency(next, new Map()).find((entry) => {
            const key = JSON.stringify(entry);
            const count = prior.get(key) ?? 0;
            if (count === 0)
                return true;
            prior.set(key, count - 1);
            return false;
        });
        if (finding !== undefined) {
            const correction = {
                "duplicate-capability": "choose an unused Capability ID",
                "same-purpose": "choose a Term that no Capability serves",
                "undefined-serves": "choose a Term declared by an enabled pack",
                "undefined-upheld": "use Practices declared by enabled packs in --upholds",
            };
            throw new RecordError(file, "/capabilities", `Capability ${declaration.id} conflicts with the project records (${finding.code}). Next action: ${correction[finding.code] ?? "run warden new " + declaration.kind + " --help"}.`);
        }
        const [badCommand] = await checkCommands({ ...set, packs: [{ ...pack, capabilities: [capability] }] }, wardenRoot);
        if (badCommand !== undefined) {
            throw new RecordError(file, "/capabilities", badCommand.message);
        }
        stopped.signal.throwIfAborted();
        if (readFileSync(config, "utf8") !== configSource || readFileSync(file, "utf8") !== original) {
            throw new RecordError(file, "", "The project config or pack changed during scaffolding. Next action: rerun the scaffold with the updated records.");
        }
        const temp = mkdtempSync(join(dir, ".capability-"));
        try {
            const staged = join(temp, "pack.yaml");
            writeFileSync(staged, output, { mode: mode.mode & 0o777, flush: true });
            renameSync(staged, file);
        }
        finally {
            rmSync(temp, { recursive: true, force: true });
        }
        process.stdout.write(`${declaration.id}\t${relative(root, file)}\n`);
        return 0;
    }
    finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        closeSync(lockFd);
        unlinkSync(lock);
    }
}
