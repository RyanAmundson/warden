import { spawn } from "node:child_process";
const killGroup = (pid) => {
    try {
        process.kill(-pid, "SIGKILL");
    }
    catch (cause) {
        if (cause.code !== "ESRCH")
            throw cause;
    }
};
export const spawnBudgeted = (file, args, cwd, budgetMs, shell = false, env = {}) => new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(file, args, { cwd, shell, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let output = "";
    let killed = false;
    child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        output += chunk.toString();
    });
    const timer = budgetMs === undefined
        ? undefined
        : setTimeout(() => {
            killed = true;
            killGroup(child.pid);
        }, budgetMs);
    child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
    });
    child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, output, code, signal, killed, ms: performance.now() - start });
    });
});
export const OUTPUT_LINES = 20;
export const PACK_DIR = "WARDEN_PACK_DIR";
export const PACK_VAR = /\$(?:\{WARDEN_PACK_DIR\}|WARDEN_PACK_DIR(?![A-Za-z0-9_]))/g;
const shellWord = (path) => (/^[\w./-]+$/.test(path) ? path : `'${path.replaceAll("'", "'\\''")}'`);
export const withPackDir = (command, packDir) => {
    if (packDir === undefined)
        return command;
    let out = "";
    let quote;
    for (let i = 0; i < command.length;) {
        const rest = command.slice(i);
        const found = quote === "'" ? null : new RegExp(`^${PACK_VAR.source}`).exec(rest);
        if (found !== null) {
            out += quote === '"' ? packDir.replace(/["\\$`]/g, "\\$&") : shellWord(packDir);
            i += found[0].length;
            continue;
        }
        const c = command[i];
        if (c === "\\" && quote !== "'") {
            out += rest.slice(0, 2);
            i += 2;
            continue;
        }
        if ((c === '"' || c === "'") && (quote === undefined || quote === c))
            quote = quote === undefined ? c : undefined;
        out += c;
        i += 1;
    }
    return out;
};
const tail = (output) => output.trimEnd().split("\n").filter((l) => l !== "").slice(-OUTPUT_LINES);
const runOne = async (g, ctx) => {
    const run = g.implementation.slice(g.implementation.indexOf(":") + 1);
    const command = withPackDir(run, g.packDir);
    const { code, killed, ms, output } = await spawnBudgeted(run, [], ctx.root, ctx.unbudgeted === true ? undefined : g.budgetMs, true, g.packDir === undefined ? {} : { [PACK_DIR]: g.packDir });
    if (killed)
        return { guardrail: g.id, status: "killed", violations: [], ms, command };
    if (code === 0)
        return { guardrail: g.id, status: "pass", violations: [], ms };
    return {
        guardrail: g.id,
        status: "fail",
        violations: [{ guardrail: g.id, file: "", line: 0, message: [`${command} exited with ${code}`, ...tail(output)].join("\n") }],
        ms,
    };
};
export const cmdAdapter = {
    id: "cmd",
    emit: () => ({}),
    run: (gs, _files, ctx) => Promise.all(gs.map((g) => runOne(g, ctx))),
};
