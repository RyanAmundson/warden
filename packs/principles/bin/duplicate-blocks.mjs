import { report, sourceFiles, usage } from "./project.mjs";

usage();

const WINDOW = 8;
const ids = new Map();
const seen = new Map();
const violations = [];

const significant = (text) =>
  text
    .split("\n")
    .map((line, i) => ({ text: line.trim(), n: i + 1 }))
    .filter(({ text }) => /[A-Za-z0-9]/.test(text) && !/^(\/\/|\/\*|\*)/.test(text))
    .map(({ text, n }) => {
      if (!ids.has(text)) ids.set(text, ids.size);
      return { id: ids.get(text), n };
    });

for (const { file, text } of sourceFiles()) {
  const lines = significant(text);
  let block;
  const flush = () => {
    if (block !== undefined) violations.push(`${file}:${block.start}-${block.end}: lines ${block.start}-${block.end} repeat the block that starts at ${block.first.file}:${block.first.start}`);
  };
  for (let i = 0; i + WINDOW <= lines.length; i++) {
    const key = lines.slice(i, i + WINDOW).map((l) => l.id).join(",");
    const start = lines[i].n;
    const end = lines[i + WINDOW - 1].n;
    const first = seen.get(key);
    if (first === undefined) seen.set(key, { file, start, end });
    if (first === undefined || (first.file === file && first.end >= start)) continue;
    if (block !== undefined && start <= block.end) block.end = end;
    else {
      flush();
      block = { start, end, first };
    }
  }
  flush();
}

report(violations, `duplicate block(s) of ${WINDOW} or more significant lines`, "move each listed block into one shared function, and call it from both places.");
