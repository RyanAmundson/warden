const files = require("./files.cjs");

const items = new Map();
for (const f of files(process.cwd())) {
  const s = f.split("/");
  for (let i = 0; i < s.length - 2; i++) {
    if (!files.isCollection(s[i])) continue;
    const c = s.slice(0, i + 1).join("/");
    const m = items.get(c) ?? new Map();
    const k = m.get(s[i + 1]) ?? new Map();
    const e = s[i + 2];
    const n = s[i + 1];
    k.set(e, e === n || e.startsWith(n + ".") ? "<item>" + e.slice(n.length) : e);
    m.set(n, k);
    items.set(c, m);
  }
}
const bad = [];
for (const [c, m] of items) {
  if (m.size < 2) continue;
  const shape = (k) => [...new Set(k.values())].sort().join("/");
  const count = new Map();
  for (const k of m.values()) count.set(shape(k), (count.get(shape(k)) ?? 0) + 1);
  const ranked = [...count].sort((x, y) => y[1] - x[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) continue;
  const want = new Set(ranked[0][0].split("/"));
  for (const [n, k] of m) {
    const lacks = [...want].filter((x) => ![...k].some(([r, t]) => r === x || t === x)).map((x) => x.replace("<item>", n));
    const extra = [...k].filter(([r, t]) => !want.has(r) && !want.has(t)).map(([r]) => r);
    if (lacks.length + extra.length > 0) bad.push(`${c}/${n} differs from the shape most items in ${c} share: ${[lacks.length > 0 ? `lacks [${lacks.join(", ")}]` : "", extra.length > 0 ? `has extra [${extra.join(", ")}]` : ""].filter((x) => x !== "").join(", ")}`);
  }
}
if (bad.length > 0) {
  console.log(bad.join("\n"));
  console.log(`${bad.length} item(s) differ in shape from their collection. Next action: give each listed item the top-level files and folders its collection expects, as listed.`);
  process.exit(1);
}
