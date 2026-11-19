const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

const isSubject = (node) => node?.type === "NewExpression" && node.callee.type === "Identifier" && /Subject$/.test(node.callee.name);

const isSubscribeCall = (node) => node?.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.property.name === "subscribe";

const inSubscribeCallback = (node) => {
  for (let at = node.parent; at !== null && at !== undefined; at = at.parent) {
    if (!FUNCTIONS.has(at.type)) continue;
    const argument = at.parent.type === "Property" && at.parent.value === at && at.parent.parent.type === "ObjectExpression" ? at.parent.parent : at;
    if (isSubscribeCall(argument.parent) && argument.parent.arguments.includes(argument)) return true;
  }
  return false;
};

const variableOf = (scope, name) => {
  for (let at = scope; at !== null; at = at.upper) {
    const found = at.set.get(name);
    if (found !== undefined) return found;
  }
  return undefined;
};

const subjectVariable = (context, id) => {
  const variable = variableOf(context.sourceCode.getScope(id), id.name);
  return variable?.defs.some((d) => d.node.type === "VariableDeclarator" && d.node.id === d.name && isSubject(d.node.init)) ?? false;
};

const subjectField = (member) => {
  const key = member.property;
  for (let at = member.parent; at !== null && at !== undefined; at = at.parent) {
    if (at.type !== "ClassBody") continue;
    return at.body.some((p) => p.type === "PropertyDefinition" && !p.computed && p.key.type === key.type && p.key.name === key.name && isSubject(p.value));
  }
  return false;
};

const isSubjectReceiver = (context, receiver) => {
  if (receiver.type === "Identifier") return subjectVariable(context, receiver);
  return receiver.type === "MemberExpression" && !receiver.computed && receiver.object.type === "ThisExpression" && subjectField(receiver);
};

const noRelay = {
  meta: {
    type: "problem",
    schema: [{ type: "object" }],
    messages: { relay: "A subscribe callback never pushes into a subject. Derive the value with an operator in pipe, and expose that observable." },
  },
  create(context) {
    return {
      "CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.property.name='next']"(node) {
        if (inSubscribeCallback(node) && isSubjectReceiver(context, node.callee.object)) context.report({ node, messageId: "relay" });
      },
    };
  },
};

export default { "no-relay": noRelay };
