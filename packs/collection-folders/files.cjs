const cp = require("node:child_process");
const fs = require("node:fs");
const { join } = require("node:path");

module.exports = (root) => {
  const ls = cp.spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, LC_ALL: "C" } });
  if (ls.status !== 0 && !/not a git repository/.test(ls.stderr ?? "")) {
    console.log(ls.error?.code === "ENOENT" ? "git is not on PATH, so the files cannot be listed. Next action: install git so that it is on PATH." : `git ls-files failed: ${(ls.error?.message ?? ls.stderr).trim()}. Next action: fix this git error so that git ls-files succeeds in this folder.`);
    process.exit(2);
  }
  if (ls.status === 0) return ls.stdout.split("\0").filter((f) => f !== "" && fs.existsSync(join(root, f)));
  return fs.readdirSync(root, { recursive: true }).filter((f) => !f.split("/").some((s) => s === "node_modules" || s === ".git") && fs.lstatSync(join(root, f)).isFile());
};

module.exports.isCollection = (s) => /^\[.*\]$/.test(s);
