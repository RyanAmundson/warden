const files = require("./files.cjs");

const bad = files(process.cwd()).filter((f) => {
  const s = f.split("/");
  return s.length > 1 && files.isCollection(s[s.length - 2]);
});
if (bad.length > 0) {
  console.log(bad.map((f) => `${f} is a file directly inside a collection`).join("\n"));
  console.log(`${bad.length} loose file(s) in collections, which hold only item folders. Next action: move each listed file into an item folder of its collection.`);
  process.exit(1);
}
