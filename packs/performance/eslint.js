const SYNC_SUBPROCESS = new Set(["execFileSync", "execSync", "spawnSync"]);

const staticName = (node) => node?.type === "Identifier" ? node.name : node?.value;
const propertyName = (node) => node.computed ? node.property.value : staticName(node.property);

function definitionOf(node, sourceCode) {
  for (let scope = sourceCode.getScope(node); scope !== null; scope = scope.upper) {
    const binding = scope.set.get(node.name);
    if (binding !== undefined && binding.isValueVariable !== false) return binding.defs[0];
  }
  return undefined;
}

function requiredModule(node, sourceCode) {
  if (node?.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "require") return undefined;
  if (definitionOf(node.callee, sourceCode) !== undefined) return undefined;
  return node.arguments[0]?.value;
}

function bindingOf(node, sourceCode) {
  if (node.type !== "Identifier") return { module: requiredModule(node, sourceCode) };
  const definition = definitionOf(node, sourceCode);
  if (definition?.type === "ImportBinding") {
    const declaration = definition.node;
    const parent = definition.parent;
    if (declaration.importKind === "type" || parent?.importKind === "type") return {};
    if (declaration.type === "TSImportEqualsDeclaration") {
      const reference = declaration.moduleReference;
      return { module: reference.type === "TSExternalModuleReference" ? reference.expression.value : undefined };
    }
    const member = staticName(declaration.imported);
    return { module: parent?.source?.value, member: member === "default" ? undefined : member };
  }
  if (definition?.type !== "Variable" || definition.parent.kind !== "const") return {};
  const { id, init } = definition.node;
  const module = requiredModule(init, sourceCode);
  if (id.type !== "ObjectPattern") return { module };
  const property = id.properties.find((entry) => entry.type === "Property" && entry.value === definition.name);
  return { module, member: property?.computed ? property.key.value : staticName(property?.key) };
}

const blockingNodeCalls = {
  meta: {
    type: "problem",
    schema: [{ type: "object" }],
    messages: {
      subprocess: "{{name}} blocks the calling thread. Use an async subprocess API or move the work to a worker.",
      filesystem: "{{name}} blocks the calling thread. Use an async filesystem API or move the work to a worker.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        const { callee } = node;
        const isMember = callee.type === "MemberExpression";
        const binding = bindingOf(isMember ? callee.object : callee, sourceCode);
        if (typeof binding.module !== "string") return;
        const module = binding.module.replace(/^node:/, "");
        const name = isMember ? propertyName(callee) : binding.member;
        if (typeof name !== "string" || (isMember && binding.member !== undefined)) return;
        if (module === "child_process" && SYNC_SUBPROCESS.has(name)) {
          context.report({ node, messageId: "subprocess", data: { name } });
        } else if (module === "fs" && name.endsWith("Sync")) {
          context.report({ node, messageId: "filesystem", data: { name } });
        }
      },
    };
  },
};

export default { "blocking-node-calls": blockingNodeCalls };
