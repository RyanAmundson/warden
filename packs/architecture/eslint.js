import { relative, sep } from "node:path";
import { groupOf, inside, isCompositionRoot, resolveFrom, sameModule, stem } from "./groups.js";

const meta = (messages) => ({ type: "problem", schema: [{ type: "object" }], messages });

const fileOf = (context) => relative(context.cwd, context.filename).split(sep).join("/");

const settingsOf = (context) => context.options[0].settings;

const staticText = (node) => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
};

const allTypes = (specifiers, key) => specifiers.length > 0 && specifiers.every((s) => s[key] === "type");

const references = (visit) => ({
  ImportDeclaration(node) {
    visit(node, node.source.value, node.importKind === "type" || allTypes(node.specifiers, "importKind"));
  },
  ExportAllDeclaration(node) {
    visit(node, node.source.value, node.exportKind === "type");
  },
  ExportNamedDeclaration(node) {
    if (node.source !== null) visit(node, node.source.value, node.exportKind === "type" || allTypes(node.specifiers, "exportKind"));
  },
  ImportExpression(node) {
    const text = staticText(node.source);
    if (text !== undefined) visit(node, text, false);
  },
  CallExpression(node) {
    if (node.callee.type !== "Identifier" || node.callee.name !== "require") return;
    const text = staticText(node.arguments[0]);
    if (text !== undefined) visit(node, text, false);
  },
  TSImportEqualsDeclaration(node) {
    if (node.moduleReference.type === "TSExternalModuleReference") visit(node, node.moduleReference.expression.value, node.importKind === "type");
  },
});

const listed = (specifier, names) => names.some((name) => [name, `node:${name}`].some((n) => specifier === n || specifier.startsWith(`${n}/`)));

const SINK = /(^|\/)sinks(\/|$)/;
const SOURCE = /(^|\/)sources(\/|$)/;

const worldModules = {
  meta: meta({ world: "{{name}} reaches the world, and only a source does. Move this read into the sources folder of its group, and return its data as an Observable." }),
  create(context) {
    const settings = settingsOf(context);
    if (isCompositionRoot(fileOf(context), settings)) return {};
    return references((node, specifier, typeOnly) => {
      if (!typeOnly && listed(specifier, settings.world)) context.report({ node, messageId: "world", data: { name: specifier } });
    });
  },
};

const REACHES = new Map([["setTimeout", "clock"], ["setInterval", "clock"], ["setImmediate", "clock"], ["fetch", "network"], ["XMLHttpRequest", "network"], ["WebSocket", "network"]]);
const HOSTS = new Set(["globalThis", "window", "self", "global"]);
const CLOCK_READERS = new Map([["Date", "now"], ["performance", "now"]]);

const inTypePosition = (node) => {
  for (let at = node.parent; at !== undefined && at !== null; at = at.parent) if (at.type === "TSTypeQuery") return true;
  return false;
};

const propertyName = (member) => {
  if (member.type !== "MemberExpression") return undefined;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return staticText(member.property);
};

const worldGlobals = {
  meta: meta({
    clock: "{{name}} reads the clock, and only a source does. Move it into the sources folder of its group, and take the time from a source as an Observable.",
    network: "{{name}} reaches the network, and only a source does. Move this call into the sources folder of its group.",
  }),
  create(context) {
    if (isCompositionRoot(fileOf(context), settingsOf(context))) return {};
    const report = (node, name, kind = "clock") => context.report({ node, messageId: kind, data: { name } });
    return {
      "Program:exit"(program) {
        const scope = context.sourceCode.getScope(program);
        const implicit = scope.variables.filter((v) => v.defs.length === 0).flatMap((v) => v.references);
        for (const reference of [...scope.through, ...implicit]) {
          const id = reference.identifier;
          if (inTypePosition(id)) continue;
          const parent = id.parent;
          const member = parent.type === "MemberExpression" && parent.object === id ? propertyName(parent) : undefined;
          if (REACHES.has(id.name)) report(id, id.name, REACHES.get(id.name));
          else if (HOSTS.has(id.name) && REACHES.has(member)) report(parent, `${id.name}.${member}`, REACHES.get(member));
          else if (CLOCK_READERS.has(id.name) && member === CLOCK_READERS.get(id.name)) report(parent, `${id.name}.${member}`);
          else if (id.name === "Date" && parent.type === "NewExpression" && parent.callee === id && parent.arguments.length === 0) report(parent, "new Date()");
          else if (id.name === "Date" && parent.type === "CallExpression" && parent.callee === id) report(parent, "Date()");
        }
      },
    };
  },
};

const returnsObservable = (fn) => {
  const type = fn.returnType?.typeAnnotation;
  if (type?.type !== "TSTypeReference") return false;
  return type.typeName.type === "Identifier" ? type.typeName.name === "Observable" : type.typeName.right?.name === "Observable";
};

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const isData = (node) => {
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  if (node.type === "UnaryExpression") return isData(node.argument);
  if (node.type === "ArrayExpression") return node.elements.every((e) => e !== null && isData(e));
  if (node.type === "ObjectExpression") return node.properties.every((p) => p.type === "Property" && !p.computed && isData(p.value));
  return ["TSAsExpression", "TSSatisfiesExpression"].includes(node.type) && isData(node.expression);
};

const localFunctions = (program) => {
  const found = new Map();
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id !== null) found.set(declaration.id.name, declaration);
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const d of declaration.declarations) if (d.id.type === "Identifier" && d.init !== null && FUNCTIONS.has(d.init.type)) found.set(d.id.name, d.init);
  }
  return found;
};

const sourceShape = {
  meta: meta({
    sink: "A source imports no sink. Return an Observable, and let the composition root connect it to the sink.",
    world: "A source re-exports no world module. Read the world inside the source, and export a function that returns its data as an Observable.",
    alias: "A source exports no alias of another value. Export a function that returns an Observable.",
    object: "A source exports no object of functions or other values. Export each function at its declaration, with an Observable return type.",
    list: "A source exports no local value that is not a function returning an Observable. Export each function at its declaration, with an Observable return type.",
    class: "A source exports no class. Export a function that returns an Observable.",
    enum: "A source exports no enum. Move the enum out of the sources folder, and import it from there.",
    returns: "Every function a source exports declares an Observable return type.",
  }),
  create(context) {
    const settings = settingsOf(context);
    const exported = (node, value) => {
      if (value === null || value === undefined) return;
      if (FUNCTIONS.has(value.type)) {
        if (!returnsObservable(value)) context.report({ node: value, messageId: "returns" });
      } else if (value.type === "ClassDeclaration" || value.type === "ClassExpression") {
        context.report({ node, messageId: "class" });
      } else if (value.type === "TSEnumDeclaration" && value.declare !== true) {
        context.report({ node, messageId: "enum" });
      } else if (value.type === "Identifier" || value.type === "MemberExpression") {
        context.report({ node, messageId: "alias" });
      } else if ((value.type === "ObjectExpression" || value.type === "ArrayExpression") && !isData(value)) {
        context.report({ node, messageId: "object" });
      }
    };
    let functions = new Map();
    return {
      Program(program) {
        functions = localFunctions(program);
      },
      ...references((node, specifier, typeOnly) => {
        if (typeOnly) return;
        if (SINK.test(specifier)) context.report({ node, messageId: "sink" });
        else if ((node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") && listed(specifier, settings.world)) context.report({ node, messageId: "world" });
      }),
      "ExportNamedDeclaration:exit"(node) {
        if (node.declaration?.type === "VariableDeclaration") for (const d of node.declaration.declarations) exported(node, d.init);
        else if (node.declaration !== null && node.declaration.type !== "TSTypeAliasDeclaration" && node.declaration.type !== "TSInterfaceDeclaration") exported(node, node.declaration);
        if (node.source !== null || node.exportKind === "type") return;
        for (const s of node.specifiers) {
          if (s.exportKind === "type") continue;
          const fn = functions.get(s.local.name);
          if (fn === undefined) context.report({ node: s, messageId: "list" });
          else if (!returnsObservable(fn)) context.report({ node: s, messageId: "returns" });
        }
      },
      ExportDefaultDeclaration(node) {
        exported(node, node.declaration);
      },
    };
  },
};

const sinkImportsNoSource = {
  meta: meta({ source: "A sink imports no source. Let the composition root pipe the source's Observable into this sink." }),
  create(context) {
    return references((node, specifier, typeOnly) => {
      if (!typeOnly && SOURCE.test(specifier)) context.report({ node, messageId: "source" });
    });
  },
};

const storeWritesOnlyInSinks = {
  meta: meta({ store: "{{name}} writes a store, and only a sink does. Move this write into the sinks folder of its group." }),
  create(context) {
    const settings = settingsOf(context);
    if (isCompositionRoot(fileOf(context), settings)) return {};
    return references((node, specifier, typeOnly) => {
      if (!typeOnly && listed(specifier, settings.sinkModules)) context.report({ node, messageId: "store", data: { name: specifier } });
    });
  },
};

const groupBoundaries = {
  meta: meta({ port: "{{target}} is inside group {{group}}. Import the group through its port, {{port}}." }),
  create(context) {
    const file = fileOf(context);
    const settings = settingsOf(context);
    const own = groupOf(file, settings);
    const root = isCompositionRoot(file, settings);
    return references((node, specifier) => {
      const target = resolveFrom(file, specifier);
      const group = target === undefined ? undefined : groupOf(`${target}/`, settings);
      if (group === undefined || own?.dir === group.dir || sameModule(target, group.port)) return;
      const factory = stem(target).slice(group.dir.length + 1);
      if (root && (factory === "create" || /^adapters\/[^/]+\/create$/.test(factory))) return;
      context.report({ node, messageId: "port", data: { target, group: group.name, port: group.port } });
    });
  },
};

const TYPE_ONLY = new Set(["TSTypeAliasDeclaration", "TSInterfaceDeclaration"]);

const portShape = {
  meta: meta({ runtime: "A port declares only types. Move this code into the group's implementation, and export only its type from {{port}}." }),
  create(context) {
    const file = fileOf(context);
    const group = groupOf(file, settingsOf(context));
    if (group === undefined || !sameModule(file, group.port)) return {};
    const declared = (d) => TYPE_ONLY.has(d.type) || d.type === "TSDeclareFunction" || d.declare === true;
    const typed = (s) => {
      if (declared(s)) return true;
      if (s.type === "ImportDeclaration") return s.importKind === "type" || allTypes(s.specifiers, "importKind");
      if (s.type === "ExportAllDeclaration") return s.exportKind === "type";
      if (s.type !== "ExportNamedDeclaration") return false;
      if (s.declaration !== null) return declared(s.declaration);
      return s.exportKind === "type" || allTypes(s.specifiers, "exportKind");
    };
    return {
      Program(program) {
        for (const s of program.body) if (!typed(s)) context.report({ node: s, messageId: "runtime", data: { port: group.port } });
      },
    };
  },
};

const FACTORY = /^(adapters\/[^/]+\/)?create$/;

const implementsPort = {
  meta: meta({ factory: "This implementation's create is not typed by its port. Write export const create: <factory type> = ..., with the factory type imported as a type from {{port}}." }),
  create(context) {
    const file = fileOf(context);
    const group = groupOf(file, settingsOf(context));
    if (group === undefined || !FACTORY.test(stem(file).slice(group.dir.length + 1))) return {};
    const portTypes = new Set();
    let typed = false;
    return {
      ImportDeclaration(node) {
        const target = resolveFrom(file, node.source.value);
        if (target === undefined || !sameModule(target, group.port)) return;
        for (const s of node.specifiers) portTypes.add(s.local.name);
      },
      "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator"(node) {
        if (node.id.type !== "Identifier" || node.id.name !== "create") return;
        const type = node.id.typeAnnotation?.typeAnnotation;
        if (type?.type !== "TSTypeReference") return;
        const name = type.typeName.type === "Identifier" ? type.typeName.name : type.typeName.left?.name;
        typed = portTypes.has(name);
      },
      "Program:exit"(program) {
        if (!typed) context.report({ node: program, loc: { line: 1, column: 0 }, messageId: "factory", data: { port: group.port } });
      },
    };
  },
};

const ADAPTER = /^(.*\/)?adapters\/([^/]+)\//;

const adapterIsolation = {
  meta: meta({ sibling: "An adapter imports no other adapter. Move the shared code into the group's implementation, and import it from there." }),
  create(context) {
    const file = fileOf(context);
    const own = ADAPTER.exec(file);
    if (own === null) return {};
    const base = `${own[1] ?? ""}adapters`;
    return references((node, specifier) => {
      const target = resolveFrom(file, specifier);
      if (target !== undefined && inside(target, base) && target.slice(base.length + 1).split("/")[0] !== own[2]) context.report({ node, messageId: "sibling" });
    });
  },
};

export default {
  "world-modules": worldModules,
  "world-globals": worldGlobals,
  "source-shape": sourceShape,
  "sink-imports-no-source": sinkImportsNoSource,
  "store-writes-only-in-sinks": storeWritesOnlyInSinks,
  "group-boundaries": groupBoundaries,
  "port-shape": portShape,
  "implements-port": implementsPort,
  "adapter-isolation": adapterIsolation,
};
