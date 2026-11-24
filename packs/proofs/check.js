import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { findSpecs, main } from "./cases.js";

const BUILD_TIMEOUT_MS = 50_000;
const ESCAPES = [
  [/\bsorry\b/, "leaves a proof unfinished with sorry"],
  [/\badmit\b/, "leaves a proof unfinished with admit"],
  [/^\s*(?:@\[[^\]]*\]\s*)?(?:(?:private|protected|noncomputable|unsafe)\s+)*axiom\s/, "assumes an unproved axiom"],
];

// Blanks comments, nested block comments, and string literals, keeping line breaks, so the
// escape scan sees only code.
export function codeOnly(text) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const two = text.slice(i, i + 2);
    if (depth > 0) {
      if (two === "/-") { depth += 1; i += 1; out += "  "; continue; }
      if (two === "-/") { depth -= 1; i += 1; out += "  "; continue; }
      out += text[i] === "\n" ? "\n" : " ";
    } else if (two === "/-") {
      depth = 1; i += 1; out += "  ";
    } else if (two === "--") {
      while (i < text.length && text[i] !== "\n") { out += " "; i += 1; }
      if (i < text.length) out += "\n";
    } else if (text[i] === '"') {
      out += " ";
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) {
        if (text[i] === "\\") { out += " "; i += 1; }
        out += text[i] === "\n" ? "\n" : " ";
      }
      out += " ";
    } else {
      out += text[i];
    }
  }
  return out;
}

export function escapes(file, text) {
  const found = [];
  codeOnly(text).split("\n").forEach((line, index) => {
    for (const [pattern, says] of ESCAPES) {
      if (pattern.test(line)) found.push(`${file}:${index + 1}: ${says}`);
    }
  });
  return found;
}

// Lean diagnostics look like `path/File.lean:12:4: error: ...`. Build errors and sorry
// warnings are findings; anything else from a failed build is a setup problem.
export function interpretBuild(project, result) {
  if (result.error) throw new Error(`lake build in ${project}: ${result.error.message}`);
  const output = `${result.stdout}\n${result.stderr}`;
  // Lake prints either `File.lean:3:8: error: text` or `error: File.lean:3:8: text`. The
  // indented lines after it carry the goal or counterexample, so keep a few of them.
  const head = (line) => {
    const after = /([^\s:]+\.lean):(\d+):\d+:\s*(error|warning):\s*(.*)$/.exec(line);
    if (after) return { file: after[1], at: after[2], kind: after[3], text: [after[4]] };
    const before = /(error|warning):\s*([^\s:]+\.lean):(\d+):\d+:\s*(.*)$/.exec(line);
    return before && { file: before[2], at: before[3], kind: before[1], text: [before[4]] };
  };
  const LAKE_LINE = /^(?:[✖⚠✔ℹ]|\[\d+\/\d+\]|info:|error: build failed|Some required targets|- \S+$|Build completed)/;
  const diagnostics = [];
  let open = false;
  for (const line of output.split(/\r?\n/)) {
    const found = head(line);
    if (found) {
      diagnostics.push({ ...found, file: found.file.replace(/^(?:\.\/)+/, "") });
      open = true;
    } else if (LAKE_LINE.test(line.trim())) {
      open = false;
    } else if (open && line.trim() !== "" && diagnostics.at(-1).text.length < 12) {
      diagnostics.at(-1).text.push(line.trim());
    }
  }
  const findings = diagnostics
    .filter(({ kind, text }) => kind === "error" || /declaration uses [`']sorry[`']/.test(text[0]))
    .map(({ file, at, text }) => `${join(project, file)}:${at}: ${text.filter(Boolean).join(" ")}`);
  if (findings.length > 0) return [...new Set(findings)];
  if (result.status === 0) return [];
  const last = output.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
  throw new Error(`lake build in ${project} stopped without a Lean diagnostic: ${last.slice(0, 600)}`);
}

export async function check() {
  const { project = "proofs" } = JSON.parse(process.env.WARDEN_SETTINGS ?? "{}");
  if (typeof project !== "string" || project === "" || isAbsolute(project)) throw new Error("Set the proofs pack's project to a project-relative folder");
  const root = realpathSync(process.cwd());
  const where = join(root, project);
  if (!existsSync(where) || !lstatSync(where).isDirectory()) throw new Error(`Add a Lean 4 Lake project at ${project}`);
  const inside = relative(root, realpathSync(where));
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Keep the Lean project inside the repository");
  if (!["lakefile.toml", "lakefile.lean"].some((f) => existsSync(join(where, f)))) throw new Error(`Add lakefile.toml or lakefile.lean to ${project}`);
  if (!existsSync(join(where, "lean-toolchain"))) throw new Error(`Pin the Lean version in ${project}/lean-toolchain`);
  const sources = findSpecs(where, [".lean"]).filter((f) => !f.startsWith("lakefile"));
  if (sources.length === 0) throw new Error(`Add the Lean sources of the proofs to ${project}`);
  const scanned = sources.flatMap((file) => escapes(join(project, file), readFileSync(join(where, file), "utf8")));
  const result = spawnSync("lake", ["build"], {
    cwd: where,
    env: { ...process.env, LEAN_ABORT_ON_PANIC: "1" },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: BUILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error?.code === "ENOENT") throw new Error("Install Lean with elan so lake is on PATH");
  if (result.signal === "SIGKILL") throw new Error(`lake build in ${project} ran past ${BUILD_TIMEOUT_MS / 1000} seconds`);
  return [...new Set([...scanned, ...interpretBuild(project, result)])];
}

if (import.meta.main) await main(check);
