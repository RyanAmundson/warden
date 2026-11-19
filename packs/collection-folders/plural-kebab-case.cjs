const files = require("./files.cjs");

const bad = new Set();
for (const f of files(process.cwd())) {
  const s = f.split("/");
  for (let i = 0; i < s.length - 1; i++) if (files.isCollection(s[i]) && !/^\[[a-z0-9]+(-[a-z0-9]+)*s\]$/.test(s[i])) bad.add(s.slice(0, i + 1).join("/"));
}
if (bad.size > 0) {
  console.log([...bad].map((d) => `${d} is not a plural lowercase kebab-case collection name`).join("\n"));
  console.log(`${bad.size} misnamed collection(s). Next action: rename each listed collection to lowercase kebab-case ending in s, such as [quality-gates].`);
  process.exit(1);
}
