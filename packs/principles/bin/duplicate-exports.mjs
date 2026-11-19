import { append, declaredExports, parsed, report, usage } from "./project.mjs";

usage();

const homes = new Map();

for (const { file, ast } of parsed()) {
  if (/(^|\/)create\.[^/]+$/.test(file)) continue;
  for (const { name, line } of declaredExports(ast)) append(homes, name, { file, line });
}

const violations = [...homes]
  .filter(([, hs]) => hs.length > 1)
  .flatMap(([name, [first, ...rest]]) => rest.map(({ file, line }) => `${file}:${line}: ${name} is also exported from ${first.file}:${first.line}`))
  .sort();

report(violations, "name(s) exported from more than one file", "keep each listed name in the file it is first exported from, import it here instead, and rename it if it means something different.");
