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
export const withPackDir = (command, packDir) => (packDir === undefined ? command : command.replace(/\$\{?WARDEN_PACK_DIR\}?/g, () => packDir));
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
