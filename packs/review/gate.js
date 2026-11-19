import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";

const root = realpathSync(process.cwd());
const temp = realpathSync(tmpdir());
const base = process.env.WARDEN_BASE;
const scratchPrefix = `warden-gate-${createHash("sha256").update(root).digest("hex").slice(0, 16)}-`;
const gitEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete gitEnv[key];

const quote = (word) => /^[\w./-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'";
const gate = (ref) => `warden check --rule review-gate --tier boundary --base ${ref}`;
const again = gate(base ? quote(base) : "<base>");
const message = (code, reason, action) => ({ code, reason, action });

function git(args, cwd = root) {
  return spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: gitEnv, encoding: "utf8", maxBuffer: 16 * 1024 ** 2 });
}

function mustGit(args) {
  const result = git(args);
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  return result.stdout;
}

function words(command) {
  const tokens = command.match(/(?:[^\s'"\\|&;<>()`$]+|'[^']*'|"[^"\\`$]*"|\\[^\n])+|\s+|./g) ?? [];
  if (tokens.some((token) => /^[|&;<>()`$'"\\]$/.test(token))) throw new Error(`invalid command ${command}`);
  return tokens.filter((token) => !/^\s+$/.test(token)).map((token) =>
    token.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, (_, single, double, escaped) => single ?? double ?? escaped));
}

function run(command, args, cwd, env) {
  const [file, ...flags] = words(command);
  if (!file) throw new Error("empty command");
  return spawnSync(file, [...flags, ...args], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause.code !== "ESRCH") throw cause;
    return false;
  }
}

function removeWorktree(scratch) {
  const work = join(scratch, "base");
  const link = join(work, "node_modules");
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  const registered = () => mustGit(["worktree", "list", "--porcelain", "-z"]).split("\0").includes(`worktree ${work}`);
  if (registered()) {
    const removal = git(["worktree", "remove", "--force", "--", work]);
    if (removal.status !== 0 && registered()) throw new Error(removal.error?.message ?? removal.stderr.trim());
  }
  rmSync(scratch, { recursive: true, force: true });
}

function removeAbandoned() {
  for (const entry of readdirSync(temp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(scratchPrefix)) continue;
    const owner = /^(\d+)-[a-zA-Z0-9]+$/.exec(entry.name.slice(scratchPrefix.length));
    if (owner !== null && !alive(Number(owner[1]))) removeWorktree(join(temp, entry.name));
  }
}

function snapshotEnv(scratch, snapshot) {
  const home = join(scratch, snapshot);
  mkdirSync(home);
  return { ...gitEnv, HOME: home, WARDEN_HOME: join(home, "warden"), GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
}

function testPath(directory, file, create = false) {
  const parts = file.split("/");
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    if (create && !existsSync(directory)) mkdirSync(directory);
    if (!lstatSync(directory).isDirectory()) throw new Error(`the test path ${file} crosses a non-directory entry`);
  }
  return join(directory, parts.at(-1));
}

function changedTests(commit, globs) {
  const tracked = mustGit(["diff", "--name-only", "-z", "--diff-filter=ACMR", commit, "--"]);
  const untracked = mustGit(["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set((tracked + untracked).split("\0"))].filter((file) => globs.some((glob) => matchesGlob(file, glob)) && lstatSync(testPath(root, file)).isFile()).sort();
}

function requireRun(result, command, target) {
  if (result.error || result.signal !== null || result.status === null || result.status === 126 || result.status === 127) {
    throw new Error(`could not run ${command} on ${target}: ${result.error?.message ?? result.signal ?? result.status}`);
  }
  return result.status;
}

function testStatus(command, files, cwd, env, snapshot) {
  const status = requireRun(run(command, files, cwd, env), command, snapshot);
  if (status !== 0 && status !== 1) throw new Error(`the test command on ${snapshot} exited ${status}; a test failure must exit 1`);
  return status;
}

function check() {
  if (!base) return message(2, "WARDEN_BASE is missing.", `run ${again} with an existing base branch`);
  const resolved = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  if (resolved.error) throw resolved.error;
  if (resolved.status !== 0) return message(2, `${base} is not a commit.`, `run git fetch origin ${quote(base)}, then run ${again}`);
  const commit = resolved.stdout.trim();
  removeAbandoned();
  const { tests, test, build } = JSON.parse(process.env.WARDEN_SETTINGS ?? "{}");
  const files = changedTests(commit, tests);
  if (files.length === 0) return message(1, "No test file changed.", `add a test under ${tests.join(", ")} that fails on ${quote(base)}, then run ${again}`);
  const scratch = mkdtempSync(join(temp, `${scratchPrefix}${process.pid}-`));
  try {
    const changeEnv = snapshotEnv(scratch, "change-home");
    if (build !== undefined) {
      if (requireRun(run(build.command, [], root, changeEnv), build.command, "the change") !== 0) {
        return message(1, "The build failed on the change.", `run ${build.command}, fix the build, then run ${again}`);
      }
      const unstaged = mustGit(["--literal-pathspecs", "diff", "--name-only", "-z", "--", build.output]);
      const untracked = mustGit(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", build.output]);
      if (unstaged !== "" || untracked !== "") {
        return message(1, "The built output differs from the index.", `run git add -- ${quote(build.output)}, then run ${again}`);
      }
    }
    const testLine = [test, ...files.map(quote)].join(" ");
    if (testStatus(test, files, root, changeEnv, "the change") !== 0) {
      return message(1, "The tests failed on the change.", `run ${testLine}, fix the failing tests, then run ${again}`);
    }
    const work = join(scratch, "base");
    mustGit(["worktree", "add", "--quiet", "--detach", "--", work, commit]);
    const modules = join(root, "node_modules");
    if (existsSync(modules)) symlinkSync(modules, join(work, "node_modules"), "dir");
    for (const file of files) {
      const target = testPath(work, file, true);
      rmSync(target, { force: true });
      copyFileSync(testPath(root, file), target);
    }
    const baseEnv = snapshotEnv(scratch, "base-home");
    if (build !== undefined && requireRun(run(build.command, [], work, baseEnv), build.command, "the base") !== 0) {
      return message(2, "The base build failed.", `choose a base that builds with ${build.command}, then run ${gate("<base>")}`);
    }
    if (testStatus(test, files, work, baseEnv, "the base") === 0) {
      return message(1, "The copied tests all pass on the base.", `change ${files.map(quote).join(", ")} so a test fails on ${quote(base)}, then run ${again}`);
    }
    return undefined;
  } finally {
    removeWorktree(scratch);
  }
}

try {
  const result = check();
  if (result !== undefined) {
    console.error(`${result.reason} Next action: ${result.action}.`);
    process.exitCode = result.code;
  }
} catch (cause) {
  console.error(`The review gate could not finish: ${cause.message}. Next action: fix the reported environment error, then run ${again}.`);
  process.exitCode = 2;
}
