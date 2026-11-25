// The nine rows the manifest decides. An SDK manifest is composed from
// features when plugin.ts runs, so these rows run through Warden's module
// adapter, whose `load` hands the check plugin.ts's exports as data.
import { createHash } from "node:crypto";
import { lineOf, plugins } from "./rules.js";

const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const VERSIONED_ID = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\.([a-z0-9][a-z0-9-]*)@(\d+)$/;

// True when `text` names `id` whole, so `x.y@1` is not found in `x.y@10` or `ax.y@1`.
const namesId = (text, id) => new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(text);

// A schema's fingerprint: sha256 of its JSON with sorted keys, so key order never counts as a change.
// The adapter hands functions over as { $function }; they hash as JSON.stringify leaves them, so a
// fingerprint matches one taken from the live manifest.
const isFunction = (v) => typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$function === "string";
const fingerprint = (value) => {
  const sorted = (v) => (Array.isArray(v) ? v.map((item) => (isFunction(item) ? null : sorted(item)))
    : typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v).filter((k) => !isFunction(v[k])).sort().map((k) => [k, sorted(v[k])]))
      : v);
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex").slice(0, 16);
};

// Every contract the manifest publishes, as `<id>@<major>` to each part's fingerprint, and the older majors it still accepts.
const publishedContracts = (manifest) => {
  const lock = {};
  const accepted = new Set();
  for (const feature of manifest.features ?? []) {
    for (const service of feature.services ?? []) {
      lock[`${service.id}@${service.version}`] = Object.fromEntries(Object.entries(service.methods ?? {})
        .map(([name, method]) => [name, fingerprint({ side: service.side, input: method.input ?? null, result: method.result })]));
      for (const major of service.accepts ?? []) accepted.add(`${service.id}@${major}`);
    }
    for (const slot of feature.ownedSlots ?? []) {
      lock[slot.id] = { slot: fingerprint({ entry: slot.entry, instance: slot.instance ?? null, cardinality: slot.cardinality, contract: slot.contract ?? null, kinds: slot.kinds ?? null }) };
      const base = slot.id.slice(0, slot.id.lastIndexOf("@"));
      for (const major of slot.accepts ?? []) accepted.add(`${base}@${major}`);
    }
  }
  return { lock, accepted };
};

// The versioned peer services the plugin's production code requests: each `registry.request(target, …)`
// whose target is a string literal, or a `const` in the same file set to one, outside the plugin's own
// namespaces and `host`.
// ponytail: a target held in a variable or read from slot data is not followed; the slot's entry schema is that link's contract.
const peerRequests = (ts, files, own) => {
  const found = [];
  for (const file of files) {
    const consts = new Map();
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)
        && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) consts.set(node.name.text, node.initializer.text);
      ts.forEachChild(node, collect);
    };
    collect(file.source);
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "request") {
        const receiver = node.expression.expression;
        const onRegistry = (ts.isIdentifier(receiver) && receiver.text === "registry")
          || (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "registry");
        const [target] = node.arguments;
        const id = !onRegistry || !target ? undefined
          : ts.isStringLiteralLike(target) ? target.text : ts.isIdentifier(target) ? consts.get(target.text) : undefined;
        const match = id === undefined ? null : VERSIONED_ID.exec(id);
        if (match && match[1] !== "host" && !own.has(match[1])) found.push({ id, file: file.file, line: lineOf(file, node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(file.source);
  }
  return found;
};

// Whether some test file in the plugin carries `tag`, such as `[contract:dispatch.runs@1]`, in its text.
const testsCarry = (files, tag) => files.some((file) => TEST.test(file.rel) && file.source.text.includes(tag));

const repeats = (ids) => ids.filter((id, i) => ids.indexOf(id) !== i);
const namespaceOf = (id) => id.slice(0, id.indexOf("."));

// The definePlugin result among plugin.ts's exports: an object with a manifest and a main function.
const definitionOf = (exported) => Object.values(exported).find((value) => typeof value === "object" && value !== null
  && typeof value.manifest === "object" && value.manifest !== null && typeof value.main?.$function === "string");

// Runs `row` for each plugin that has a plugin.ts, with its loaded manifest. A plugin without one
// passes these rows; PQ-sdk.1 reports it.
const byManifest = (row) => (input) => plugins(input).flatMap((p) => {
  if (!p.has.has("plugin.ts")) return [];
  const entry = p.path("plugin.ts");
  let exported;
  try {
    exported = input.load(entry);
  } catch (cause) {
    return [{ file: entry, line: 1, message: `${p.folder}: plugin.ts does not load, so its manifest cannot be checked: ${cause.message}`, doThis: `Make ${entry} load with Node: install the project's dependencies and fix the error.` }];
  }
  const definition = definitionOf(exported);
  if (definition === undefined) return [{ file: entry, line: 1, message: `${p.folder}: plugin.ts exports no definePlugin result.`, doThis: `Export the result of definePlugin from ${entry}.` }];
  const manifest = definition.manifest;
  const features = manifest.features ?? [];
  const namespaces = new Set([manifest.id, ...(manifest.role ? [manifest.role] : []), ...(manifest.replaces ? [manifest.replaces] : [])]);
  const contract = p.has.has("CONTRACT.md") ? input.read(p.path("CONTRACT.md")) : "";
  const at = (message, doThis, file = entry, line = 1) => ({ file, line, message: `${p.folder}: ${message}`, doThis });
  return row({ ...input, plugin: p, manifest, features, namespaces, contract, at });
});

const services = (features) => features.flatMap((f) => f.services ?? []);
const slots = (features) => features.flatMap((f) => f.ownedSlots ?? []);
const collections = (features) => features.flatMap((f) => f.collections ?? []);
const peers = ({ ts, plugin, namespaces }) => {
  const found = peerRequests(ts, plugin.sources.filter((file) => file.production), namespaces);
  return [...new Map(found.map((peer) => [peer.id, peer])).values()];
};

const namespaced = ({ manifest, features, namespaces, at }) => {
  const doThis = `Name each slot, service, and collection once, as ${manifest.id}.<name>.`;
  return [
    ...slots(features).filter((s) => namespaceOf(s.id) !== manifest.id).map((s) => at(`slot ${s.id} is not in the ${manifest.id} namespace.`, doThis)),
    ...services(features).filter((s) => !namespaces.has(namespaceOf(s.id))).map((s) => at(`service ${s.id} is in neither the ${manifest.id} namespace nor a role it fills.`, doThis)),
    ...collections(features).filter((c) => namespaceOf(c.id) !== manifest.id).map((c) => at(`collection ${c.id} is not in the ${manifest.id} namespace.`, doThis)),
    ...repeats([...slots(features).map((s) => s.id), ...services(features).map((s) => `${s.id}@${s.version}`), ...collections(features).map((c) => c.id)]).map((id) => at(`${id} is declared twice.`, doThis)),
  ];
};

const presented = ({ features, at }) => features.flatMap((f) => f.entityKinds ?? []).flatMap((kind) => {
  const shown = features.flatMap((f) => f.kindPresentation ?? []).filter((k) => k.kind === kind);
  if (shown.length !== 1) return [at(`entity kind ${kind} has ${shown.length} presentations; it needs exactly one.`, `Present entity kind ${kind} exactly once.`)];
  return collections(features).some((c) => c.id === shown[0].entities) ? [] : [at(`entity kind ${kind} names entities ${shown[0].entities}, which the plugin does not declare.`, `Declare the collection ${shown[0].entities}, or present ${kind} with one the plugin declares.`)];
});

// ponytail: reads CONTRACT.md until the SDK's requires.services is the record of peer services, then reads that field.
const peersListed = (input) => peers(input).filter((peer) => !namesId(input.contract, peer.id))
  .map((peer) => input.at(`requests ${peer.id}; CONTRACT.md does not name it.`, `Name ${peer.id} in ${input.plugin.path("CONTRACT.md")}.`, peer.file, peer.line));

const peersAbsent = (input) => peers(input).filter((peer) => !testsCarry(input.plugin.sources, `[absent:${peer.id}]`))
  .map((peer) => input.at(`no test is titled [absent:${peer.id}].`, `Add a test titled [absent:${peer.id}] that drives the plugin with that provider absent.`, peer.file, peer.line));

const commands = ({ features, at }) => {
  const all = features.flatMap((f) => f.cliCommands ?? []);
  const own = services(features);
  return all.flatMap((command) => {
    const name = `command ${command.namespace} ${command.name}`;
    const target = own.find((s) => `${s.id}@${s.version}` === command.service || (s.accepts ?? []).some((m) => `${s.id}@${m}` === command.service));
    const doThis = `Point ${name} at a method of one of the plugin's own main-side services, and describe it.`;
    return [
      ...(!target ? [at(`${name} calls ${command.service}, which the plugin does not declare.`, doThis)]
        : target.side !== "main" ? [at(`${name} calls ${command.service}, a ${target.side}-side service.`, doThis)]
          : !Object.hasOwn(target.methods ?? {}, command.method) ? [at(`${name} calls ${command.service} ${command.method}, which the service does not declare.`, doThis)] : []),
      ...(command.description?.trim() ? [] : [at(`${name} has no description.`, doThis)]),
    ];
  }).concat(repeats(all.map((c) => `command ${c.namespace} ${c.name}`)).map((name) => at(`${name} is declared twice.`, `Give ${name} a name no other command of the plugin uses.`)));
};

const keyed = ({ features, at }) => collections(features).flatMap((c) => {
  const field = c.schema?.type === "object" ? c.schema.properties?.[c.key] : undefined;
  return [
    ...(Number.isInteger(c.version) && c.version >= 1 ? [] : [at(`collection ${c.id} has version ${c.version}; it needs an integer from 1.`, `Give collection ${c.id} an integer version from 1.`)]),
    ...(field && field.type === "string" && !field.optional && !field.nullable ? [] : [at(`collection ${c.id} keys by ${c.key}, which is not a required string field of its schema.`, `Key collection ${c.id} by a required string field of its schema.`)]),
  ];
});

const documented = ({ manifest, plugin, contract, at }) => Object.keys(publishedContracts(manifest).lock).flatMap((id) => [
  ...(namesId(contract, id) ? [] : [at(`CONTRACT.md does not name ${id}.`, `Name ${id} in ${plugin.path("CONTRACT.md")}.`)]),
  ...(testsCarry(plugin.sources, `[contract:${id}]`) ? [] : [at(`no test is titled [contract:${id}].`, `Add a test titled [contract:${id}] that exercises the contract.`)]),
]);

const recorded = ({ manifest, plugin, read, settings, at }) => {
  const lockPath = plugin.path(settings.contractLock);
  let lock = {};
  if (plugin.has.has(settings.contractLock)) {
    try {
      lock = JSON.parse(read(lockPath));
    } catch (cause) {
      return [at(`${settings.contractLock} does not parse: ${cause.message}`, `Fix the JSON in ${lockPath}.`, lockPath)];
    }
    const valid = typeof lock === "object" && lock !== null && !Array.isArray(lock)
      && Object.values(lock).every((parts) => typeof parts === "object" && parts !== null && !Array.isArray(parts) && Object.values(parts).every((print) => typeof print === "string"));
    if (!valid) return [at(`${settings.contractLock} must map <id>@<major> to part fingerprints.`, `Make ${lockPath} an object of "<id>@<major>": { "<part>": "<fingerprint>" }.`, lockPath)];
  }
  const { lock: published, accepted } = publishedContracts(manifest);
  const major = "Publish the change as a new major, and keep the recorded major published or accepted.";
  return [
    ...Object.entries(lock).flatMap(([id, parts]) => {
      const now = published[id];
      if (!now) return accepted.has(id) ? [] : [at(`${id} is recorded but no longer published or accepted: a removal needs a new major that drops it.`, major, lockPath)];
      return Object.entries(parts).flatMap(([part, print]) => (now[part] === undefined ? [at(`${id} ${part} was removed under the same major.`, major, lockPath)]
        : now[part] !== print ? [at(`${id} ${part} changed under the same major.`, major, lockPath)] : []));
    }),
    ...Object.entries(published).flatMap(([id, parts]) => Object.entries(parts).filter(([part]) => lock[id]?.[part] === undefined)
      .map(([part, print]) => at(`${id} ${part === "slot" ? "" : `${part} `}is not recorded.`, `Add "${part}": "${print}" under "${id}" in ${lockPath}.`))),
  ];
};

const contributions = ({ manifest, features, at }) => {
  const { lock: published, accepted } = publishedContracts(manifest);
  return features.flatMap((f) => f.contributions ?? []).flatMap((c) => {
    const match = VERSIONED_ID.exec(c.slot);
    const doThis = `Point contribution ${c.id} at a versioned slot a plugin declares.`;
    if (!match) return [at(`contribution ${c.id} targets ${c.slot}, which is not <owner>.<name>@<major>.`, doThis)];
    if (match[1] === "shell") return [at(`contribution ${c.id} targets ${c.slot}; the SDK has no shell.* slots.`, doThis)];
    return match[1] !== manifest.id || Object.hasOwn(published, c.slot) || accepted.has(c.slot) ? [] : [at(`contribution ${c.id} targets ${c.slot}, which the plugin neither declares nor accepts.`, doThis)];
  });
};

export default {
  namespaced: byManifest(namespaced),
  presented: byManifest(presented),
  "peers-listed": byManifest(peersListed),
  "peers-absent": byManifest(peersAbsent),
  commands: byManifest(commands),
  keyed: byManifest(keyed),
  documented: byManifest(documented),
  recorded: byManifest(recorded),
  contributions: byManifest(contributions),
};
