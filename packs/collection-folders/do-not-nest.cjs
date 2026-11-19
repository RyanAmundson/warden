const files = require("./files.cjs");

const bad = new Set();
for (const f of files(process.cwd())) {
  const s = f.split("/");
  for (let i = 1; i < s.length - 1; i++) if (files.isCollection(s[i]) && files.isCollection(s[i - 1])) bad.add(s.slice(0, i + 1).join("/"));
}
if (bad.size > 0) {
  console.log([...bad].map((d) => `${d} is a collection directly inside a collection`).join("\n"));
  console.log(`${bad.size} nested collection(s). Next action: remove the brackets from each listed inner collection so it becomes an item folder.`);
  process.exit(1);
}
