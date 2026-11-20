import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const TLC_SHA256 = "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88";
const TLC_VIOLATIONS = new Map([
  [10, [2104]],
  [11, [2114]],
  [12, [2107, 2110]],
  [13, [2108, 2112, 2116]],
  [14, [2132]],
]);
const TLC_TIMEOUT_MS = 20_000;

const firstLine = (text) => text?.trim().split(/\r?\n/, 1)[0];

const diagnostics = (output) => [...output.matchAll(/^@!@!@STARTMSG (\d+):[12] @!@!@\r?\n([^\r\n]+)/gm)];

export function interpretTlc(model, result) {
  if (result.error) throw new Error(`${model}.tla: ${result.error.message}`);
  if (result.status === 0) return { code: 0 };
  const messages = diagnostics(result.stdout);
  const counterexample = messages.find(([, code]) => TLC_VIOLATIONS.get(result.status)?.includes(Number(code)));
  if (counterexample) {
    const states = [...result.stdout.matchAll(/^@!@!@STARTMSG \d+:4 @!@!@\r?\n([\s\S]*?)\r?\n@!@!@ENDMSG \d+ @!@!@/gm)];
    const trace = states.slice(-2).map(([, state]) => state);
    return { code: 1, message: [...trace, `${model}.tla: ${counterexample[2]}`].join("\n") };
  }
  const parser = result.stdout.match(/\*\*\*Parse Error\*\*\*\r?\n([^\r\n]+)(?:\r?\n(Encountered [^\r\n]+))?/);
  const semantic = result.stdout.match(/^\*\*\* Errors: \d+\r?\n([\s\S]*?)(?=^@!@!@STARTMSG)/m)?.[1];
  const semanticDetail = semantic?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" ");
  const detail = parser ? parser.slice(1).filter(Boolean).join(" ") : semanticDetail || (messages[0]?.[2] ?? firstLine(result.stderr));
  const reason = detail?.trim() || `TLC exited with status ${result.status ?? result.signal}`;
  throw new Error(`${model}.tla: TLC stopped without a model verdict. ${reason.slice(0, 600)}`);
}

const regularBytes = (file) => {
  if (!lstatSync(file).isFile()) throw new Error(`Use a regular file at ${file}`);
  return readFileSync(file);
};

function run() {
  const { model } = JSON.parse(process.env.WARDEN_SETTINGS ?? "{}");
  if (typeof model !== "string" || !/^(?:[\w-]+\/)*[A-Za-z][A-Za-z0-9_]*$/.test(model)) {
    throw new Error("Set the tla pack's model to a project-relative module path without the .tla extension");
  }
  const jar = process.env.WARDEN_TLC_JAR;
  if (!jar || !isAbsolute(jar)) throw new Error("Set WARDEN_TLC_JAR to the absolute path of the official TLC 1.7.4 JAR");
  const jarBytes = regularBytes(realpathSync(jar));
  if (createHash("sha256").update(jarBytes).digest("hex") !== TLC_SHA256) {
    throw new Error("The JAR at WARDEN_TLC_JAR does not match the pinned official TLC 1.7.4 release");
  }
  const root = realpathSync(process.cwd());
  const directory = realpathSync(resolve(root, dirname(model)));
  const parent = relative(root, directory);
  if (parent === ".." || parent.startsWith(`..${sep}`) || isAbsolute(parent)) {
    throw new Error("Keep the model directory inside the project");
  }
  const module = basename(model);
  const modules = readdirSync(directory).filter((file) => file.endsWith(".tla"));
  if (!modules.includes(`${module}.tla`)) throw new Error(`Add the selected module at ${model}.tla`);
  const config = `${module}.cfg`;
  const scratch = mkdtempSync(join(tmpdir(), "warden-tlc-"));
  try {
    const tool = join(scratch, "tla2tools.jar");
    writeFileSync(tool, jarBytes);
    for (const file of [...modules, config]) writeFileSync(join(scratch, file), regularBytes(join(directory, file)));
    const result = spawnSync("java", [
      "-Xmx512m", "-XX:+UseParallelGC", `-Duser.home=${scratch}`, "-cp", tool, "tlc2.TLC",
      "-tool", "-workers", "1", "-metadir", join(scratch, "states"), "-config", config, `${module}.tla`,
    ], {
      cwd: scratch,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: TLC_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const verdict = interpretTlc(model, result);
    if (verdict.message !== undefined) console.log(verdict.message);
    return verdict.code;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(`${error.message.replace(/\.$/, "")}. Next action: check the TLC JAR, Java on PATH, and the selected model and configuration.`);
    process.exitCode = 2;
  }
}
