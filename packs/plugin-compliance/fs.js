// The eight rows a plugin's own source files decide.
import { each, inside, namesModule, plugins, relativeTarget, specifiers } from "./rules.js";

const WORLD_MODULES = ["fs", "child_process", "net", "http", "https", "http2", "dgram", "dns", "tls", "os", "worker_threads", "cluster"];
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);
const WORLD_GLOBALS = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "localStorage", "sessionStorage", "indexedDB"]);

// Git subcommands that change a repository; the host's checkout service owns them.
const GIT_WRITE_VERBS = new Set([
  "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "commit", "merge", "mv", "pull",
  "push", "rebase", "reset", "restore", "revert", "rm", "stash", "switch", "tag", "worktree",
]);

// Whether git arguments, after any `-C <dir>`, change a repository. `branch`, `tag`, `stash`, and
// `worktree` also have read forms, such as `branch --show-current` and `worktree list`, which pass.
const isGitWrite = (args) => {
  const rest = args[0] === "-C" ? args.slice(2) : args;
  const [verb, next] = rest;
  if (!verb || !GIT_WRITE_VERBS.has(verb)) return false;
  if (verb === "worktree" || verb === "stash") return next === undefined ? verb === "stash" : !/^(?:list|show)$/.test(next);
  if (verb === "branch" || verb === "tag") {
    return next !== undefined && !/^(?:--show-current|--list|-l|-a|--all|-r|--remotes|-v|-vv|--verbose|--contains|--no-contains|--merged|--no-merged|--points-at|--sort.*|--format.*|-n\d*)$/.test(next);
  }
  return true;
};

const calleeName = (ts, call) => ts.isIdentifier(call.expression) ? call.expression.text
  : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;

// Names a file imports from `rxjs`, so a local `interval` or `timer` is not mistaken for one.
const rxjsImports = (ts, file) => {
  const names = new Set();
  for (const statement of file.source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "rxjs"
      && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) names.add(element.name.text);
    }
  }
  return names;
};

const imports = (ts, files, decide, doThis) => files.flatMap((file) => specifiers(ts, file).flatMap((found) => {
  const what = decide(found, file);
  return what ? [{ file: file.file, line: found.line, message: `${file.rel}: ${what}`, doThis }] : [];
}));

const declaration = (input) => plugins(input).flatMap((p) => {
  const found = [];
  if (!p.has.has("plugin.ts")) {
    found.push({ file: p.anchor, message: `${p.folder}: plugin.ts is missing: the plugin declares itself with definePlugin there.`, doThis: `Add ${p.path("plugin.ts")} that exports the result of definePlugin.` });
  } else if (!/\bdefinePlugin\s*\(/.test(input.read(p.path("plugin.ts")))) {
    found.push({ file: p.path("plugin.ts"), line: 1, message: `${p.folder}: plugin.ts does not call definePlugin.`, doThis: `Export the result of definePlugin from ${p.path("plugin.ts")}.` });
  }
  if (p.has.has("plugin.json")) {
    found.push({ file: p.path("plugin.json"), line: 1, message: `${p.folder}: plugin.json is a second copy of the declaration.`, doThis: `Move what ${p.path("plugin.json")} declares into plugin.ts, then delete plugin.json.` });
  }
  return found;
});

const isolation = (input) => {
  const { ts, settings } = input;
  const host = settings.hostImports.map((source) => new RegExp(source));
  return plugins(input).flatMap((p) => imports(ts, p.sources, ({ specifier }, file) => {
    if (specifier.startsWith(".")) {
      const target = relativeTarget(file.file, specifier);
      return inside(target, p.folder) || settings.sharedCode.some((folder) => inside(target, folder)) ? undefined : `imports ${specifier}, outside the plugin and its shared code`;
    }
    return host.some((re) => re.test(specifier)) ? `imports ${specifier}, which is host code or another plugin` : undefined;
  }, "Import the SDK, an npm package, shared library code, or the plugin's own files instead."));
};

const legacy = (input) => {
  const bridges = input.settings.legacyImports.map((source) => new RegExp(source));
  return plugins(input).flatMap((p) => imports(input.ts, p.sources, ({ specifier }) =>
    bridges.some((re) => re.test(specifier)) ? `imports the legacy bridge ${specifier}` : undefined, "Reach the host through the SDK's own exports instead of this bridge."));
};

const world = (input) => {
  const { ts, settings } = input;
  const modules = [...WORLD_MODULES, ...settings.worldModules];
  const doThis = "Declare a host source or call a host service for this data or effect.";
  return plugins(input).flatMap((p) => {
    const production = p.sources.filter((file) => file.production);
    return [
      // A type-only import loads nothing.
      ...imports(ts, production, ({ specifier, typeOnly }) =>
        !typeOnly && namesModule(specifier.replace(/^node:/, ""), modules) ? `imports ${specifier}` : undefined, doThis),
      ...each(ts, production, (node) => {
        if (ts.isIdentifier(node) && WORLD_GLOBALS.has(node.text)
          && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
          && !ts.isImportSpecifier(node.parent) && !ts.isPropertyAssignment(node.parent)) return `uses ${node.text}`;
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env") return "reads process.env";
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text)
          && WORLD_GLOBALS.has(node.name.text)) return `uses ${node.expression.text}.${node.name.text}`;
        return undefined;
      }, doThis),
    ];
  });
};

const polling = (input) => {
  const { ts } = input;
  return plugins(input).flatMap((p) => p.sources.filter((file) => file.production).flatMap((file) => {
    const rx = rxjsImports(ts, file);
    return each(ts, [file], (node) => {
      if (!ts.isCallExpression(node)) return undefined;
      const name = calleeName(ts, node);
      if (name === "setInterval" || name === "createPoller") return `polls with ${name}`;
      if (ts.isIdentifier(node.expression) && rx.has(node.expression.text)
        && (node.expression.text === "interval" || (node.expression.text === "timer" && node.arguments.length > 1))) return `polls with rxjs ${node.expression.text}`;
      return undefined;
    }, "Declare a source with a trigger and let the host refresh it.");
  }));
};

const gitWrites = (input) => {
  const { ts } = input;
  return plugins(input).flatMap((p) => each(ts, p.sources.filter((file) => file.production), (node) => {
    if (ts.isStringLiteralLike(node) && /^git\s/.test(node.text) && isGitWrite(node.text.split(/\s+/).slice(1))) return `runs "${node.text.slice(0, 40)}"`;
    if (ts.isCallExpression(node)) {
      const [first, second] = node.arguments;
      if (first && second && ts.isStringLiteralLike(first) && first.text === "git" && ts.isArrayLiteralExpression(second)) {
        // A non-literal element, such as the directory after -C, reads as a placeholder.
        const args = second.elements.map((element) => (ts.isStringLiteralLike(element) ? element.text : "<expr>"));
        if (isGitWrite(args)) return `runs git ${(args[0] === "-C" ? args[2] : args[0]) ?? ""}`;
      }
    }
    return undefined;
  }, "Call the host's checkout service for this git write."));
};

const consoleOutput = (input) => {
  const { ts, settings } = input;
  const allowed = new Set(settings.consoleFolders);
  return plugins(input).flatMap((p) => each(ts, p.sources.filter((file) => file.production && !file.rel.split("/").slice(0, -1).some((dir) => allowed.has(dir))), (node) =>
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "console"
      ? `console.${node.expression.name.text}` : undefined, "Publish through the host's log, notice, or error feed."));
};

const documents = (input) => plugins(input).flatMap((p) => {
  const found = ["README.md", "CONTRACT.md", "CHANGELOG.md"]
    .filter((name) => !p.has.has(name))
    .map((name) => ({ file: p.anchor, message: `${p.folder}: ${name} is missing.`, doThis: `Add ${p.path(name)}.` }));
  if (!p.has.has("package.json")) return [...found, { file: p.anchor, message: `${p.folder}: package.json is missing, so the plugin has no version.`, doThis: `Add ${p.path("package.json")} with a version.` }];
  let version;
  try {
    version = JSON.parse(input.read(p.path("package.json"))).version;
  } catch (cause) {
    return [...found, { file: p.path("package.json"), line: 1, message: `${p.folder}: package.json does not parse: ${cause.message}`, doThis: `Fix the JSON in ${p.path("package.json")}.` }];
  }
  if (typeof version !== "string") return [...found, { file: p.path("package.json"), line: 1, message: `${p.folder}: package.json declares no version.`, doThis: `Add a version to ${p.path("package.json")}.` }];
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (p.has.has("CHANGELOG.md") && !new RegExp(`^## \\[?${escaped}\\]?(?:\\s|$)`, "m").test(input.read(p.path("CHANGELOG.md")))) {
    found.push({ file: p.path("CHANGELOG.md"), line: 1, message: `${p.folder}: CHANGELOG.md has no heading for version ${version}.`, doThis: `Add a "## ${version}" heading to ${p.path("CHANGELOG.md")}.` });
  }
  return found;
});

export default {
  declaration,
  isolation,
  legacy,
  world,
  polling,
  "git-writes": gitWrites,
  console: consoleOutput,
  documents,
};
