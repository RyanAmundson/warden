import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { LOCK_PATH, readLock } from "../compiler/lock.js";
import { loadRecords } from "../records/load.js";
import { heartbeatProblem } from "../runner/daemon.js";
import { wardenHome } from "../runner/evidence.js";
const exec = promisify(execFile);
const editor = "Read,Glob,Grep,Edit,Write,MultiEdit";
const toolPrefix = "mcp__warden__";
const guidance = "Use Warden's list_checks to discover validation checks. After editing, use Warden's validate tool. If a check is missing, ask the user to register it in a Warden pack.";
const quote = (word) => "'" + word.replaceAll("'", "'\\''") + "'";
const cli = (wardenRoot) => join(wardenRoot, "bin/warden.js");
function requireDaemon() {
    const problem = heartbeatProblem();
    if (problem !== undefined)
        throw new Error(problem);
}
function inside(root, path) {
    const location = relative(realpathSync(root), realpathSync(path));
    return location !== ".." && !location.startsWith(".." + sep) && !isAbsolute(location);
}
export async function runLocalSession(root, wardenRoot, print) {
    if (!existsSync(join(root, LOCK_PATH))) {
        throw new Error("Warden policy is missing. Next action: run warden init in this checkout.");
    }
    requireDaemon();
    if ([wardenRoot, wardenHome(), process.execPath].some((path) => inside(root, path))) {
        throw new Error("The agent can edit files inside this checkout. Next action: use a Node and Warden install and a Warden state directory outside the project.");
    }
    const node = process.execPath;
    const bin = cli(wardenRoot);
    const command = [node, bin].map(quote).join(" ");
    const hook = (args) => [{ matcher: "^(Edit|Write|MultiEdit)$", hooks: [{ type: "command", command: command + " " + args, onFailure: "block" }] }];
    const settings = JSON.stringify({ hooks: {
            PreToolUse: hook("guard --local-session"),
            PostToolUse: hook("check --format agent --hook claude"),
            SessionEnd: [{ hooks: [{ type: "command", command: command + " session-end" }] }],
        } });
    const mcp = JSON.stringify({ mcpServers: { warden: { command: node, args: [bin, "local-session-tools"] } } });
    const args = [
        "--restricted", "--setting-sources", "", "--disable-slash-commands", "--strict-mcp-config",
        "--settings", settings, "--mcp-config", mcp, "--tools", editor,
        "--allowedTools", editor + "," + toolPrefix + "list_checks," + toolPrefix + "validate",
        "--permission-mode", "dontAsk", "--append-system-prompt", guidance,
    ];
    if (print)
        args.push("--print", "--no-session-persistence", "--output-format", "stream-json", "--verbose");
    const env = { ...process.env };
    delete env["WARDEN_DAEMON"];
    const child = spawn("claude", args, { cwd: root, stdio: "inherit", env });
    return new Promise((resolve, reject) => {
        child.once("error", (cause) => reject(cause.code === "ENOENT"
            ? new Error("Claude Code is unavailable. Next action: install Claude Code 2.1.328 or later and put claude on PATH.")
            : cause));
        child.once("exit", (code) => resolve(code ?? 2));
    });
}
const tierNames = ["edit", "boundary"];
const tools = [
    {
        name: "list_checks", description: "List the enabled Warden checks you can run on this checkout.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "validate", description: "Run a registered Warden check on this checkout.",
        inputSchema: {
            type: "object", properties: { check: { type: "string" }, tier: { type: "string", enum: tierNames } },
            required: ["check"], additionalProperties: false,
        },
    },
];
async function checks(root, wardenRoot) {
    const set = await loadRecords(root, wardenRoot);
    return set.packs.flatMap((pack) => pack.practices.flatMap((practice) => practice.guardrails
        .filter((check) => check.kind !== "instruction")
        .map((check) => ({ id: check.id, pack: pack.id, purpose: practice.statement, tiers: tierNames.filter((tier) => check.runs.includes(tier)) }))
        .filter((check) => check.tiers.length > 0)));
}
function object(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("Expected an object.");
    return value;
}
async function validate(root, wardenRoot, input) {
    const { check, tier = "edit" } = input;
    if (Object.keys(input).some((key) => key !== "check" && key !== "tier") ||
        typeof check !== "string" || (tier !== "edit" && tier !== "boundary")) {
        throw new Error("Provide a registered check ID and, optionally, tier edit or boundary.");
    }
    requireDaemon();
    const available = await checks(root, wardenRoot);
    if (!available.some((entry) => entry.id === check && entry.tiers.includes(tier))) {
        throw new Error(`Check "${check}" is unavailable at the ${tier} tier. Run list_checks or ask the user to register it.`);
    }
    const { base, tierBudgetMs } = readLock(root).config;
    const args = [cli(wardenRoot), "check", "--base", base, "--rule", check, "--tier", tier, "--format", "json"];
    const options = { cwd: root, maxBuffer: 1024 * 1024, timeout: tierBudgetMs[tier] + 15_000 };
    try {
        const { stdout } = await exec(process.execPath, args, options);
        return { check, tier, exit: 0, report: JSON.parse(stdout) };
    }
    catch (cause) {
        const error = cause;
        if (error.killed === true || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            const detail = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "exceeded the output limit" : "timed out";
            return { check, tier, exit: 2, report: {}, error: `The Warden check ${detail}.`,
                next: "Ask the user to inspect the registered check and its budget." };
        }
        if (error.code !== 1 && error.code !== 2)
            throw cause;
        const report = error.stdout?.trim() ? object(JSON.parse(error.stdout)) : {};
        delete report["next"];
        return { check, tier, exit: error.code, report, ...(error.stderr?.trim() && { error: error.stderr.trim() }),
            next: "Use the findings to make corrections, then rerun the Warden validate tool." };
    }
}
export async function runLocalSessionTools(root, wardenRoot) {
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    const respond = (id, payload) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
    for await (const line of input) {
        let request;
        try {
            request = object(JSON.parse(line));
        }
        catch {
            respond(null, { error: { code: -32700, message: "Expected a JSON-RPC request." } });
            continue;
        }
        const id = request["id"];
        if (id === undefined)
            continue;
        const params = request["params"] === undefined ? {} : request["params"];
        let result;
        switch (request["method"]) {
            case "initialize":
                result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "warden", version: "1.0.0" } };
                break;
            case "ping":
                result = {};
                break;
            case "tools/list":
                result = { tools };
                break;
            case "tools/call":
                try {
                    const { name, arguments: args = {} } = object(params);
                    const parsed = object(args);
                    if (name === "list_checks" && Object.keys(parsed).length === 0) {
                        result = { content: [{ type: "text", text: JSON.stringify(await checks(root, wardenRoot)) }] };
                    }
                    else if (name === "validate") {
                        const report = await validate(root, wardenRoot, parsed);
                        result = { content: [{ type: "text", text: JSON.stringify(report) }], isError: report.exit !== 0 };
                    }
                    else {
                        throw new Error("Available tools: list_checks and validate.");
                    }
                }
                catch (cause) {
                    result = { content: [{ type: "text", text: cause.message }], isError: true };
                }
                break;
            default:
                respond(id, { error: { code: -32601, message: "Unknown method." } });
                continue;
        }
        respond(id, { result });
    }
}
