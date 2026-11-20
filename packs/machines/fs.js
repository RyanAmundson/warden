const MODEL_SUFFIX = ".machine.json";
const TRACE_SUFFIX = ".trace.json";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const name = (value) => typeof value === "string" && value.trim() !== "" && value === value.trim();

const readDocument = (file, read, nonRegular) => {
  if (nonRegular.has(file)) return { error: "Use a regular JSON file." };
  try {
    return { value: JSON.parse(read(file)) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { error: "Fix the invalid JSON." };
  }
};

const tableOf = (model) => {
  if (!record(model) || !Array.isArray(model.states) || !Array.isArray(model.transitions)) {
    return { error: "Declare the machine's initial state, states array, and transitions array." };
  }
  const states = new Set(model.states);
  if (!model.states.every(name) || states.size !== model.states.length || !states.has(model.initial)) {
    return { error: "Declare unique named states and use one of them as the initial state." };
  }
  const table = new Map(model.states.map((state) => [state, new Map()]));
  for (const [index, transition] of model.transitions.entries()) {
    if (!record(transition) || !states.has(transition.from) || !name(transition.event) || !states.has(transition.to)) {
      return { error: `Declare a known from state, a named event, and a known to state for transition ${index + 1}.` };
    }
    const events = table.get(transition.from);
    if (events.has(transition.event)) return { error: `Give state "${transition.from}" one destination for event "${transition.event}".` };
    events.set(transition.event, transition.to);
  }
  const reached = new Set([model.initial]);
  for (const state of reached) for (const next of table.get(state).values()) reached.add(next);
  const unused = model.states.filter((state) => !reached.has(state));
  if (unused.length > 0) return { error: `Connect these states to the initial state or remove them: ${unused.join(", ")}.` };
  return { table, initial: model.initial };
};

const loadModel = (file, read, nonRegular) => {
  const doc = readDocument(file, read, nonRegular);
  return doc.error === undefined ? tableOf(doc.value) : doc;
};

const finding = (file, message, doThis) => ({ file, message, doThis });

const tables = ({ files, read, nonRegular = [] }) => {
  const nonFiles = new Set(nonRegular);
  return files.filter((file) => file.endsWith(MODEL_SUFFIX)).flatMap((file) => {
    const { error } = loadModel(file, read, nonFiles);
    return error === undefined ? [] : [finding(file, "The state machine table is invalid.", error)];
  });
};

const traceError = (trace, model) => {
  if (!record(trace) || trace.initial !== model.initial || !Array.isArray(trace.steps) || trace.steps.length === 0) {
    return "Record the machine's initial state and at least one observed step with an event and its resulting state.";
  }
  let state = trace.initial;
  for (const [index, step] of trace.steps.entries()) {
    const expected = record(step) ? model.table.get(state).get(step.event) : undefined;
    if (expected === undefined || expected !== step.state) {
      return `Inspect the implementation that produced step ${index + 1} from state "${state}", then record a new trace after correcting the transition.`;
    }
    state = expected;
  }
  return undefined;
};

const traces = ({ files, read, nonRegular = [] }) => {
  const known = new Set(files);
  const nonFiles = new Set(nonRegular);
  return files.filter((file) => file.endsWith(MODEL_SUFFIX)).flatMap((modelFile) => {
    const file = modelFile.slice(0, -MODEL_SUFFIX.length) + TRACE_SUFFIX;
    if (!known.has(file)) return [];
    const model = loadModel(modelFile, read, nonFiles);
    if (model.error !== undefined) return [finding(modelFile, "The trace needs a valid state machine table.", model.error)];
    const doc = readDocument(file, read, nonFiles);
    const error = doc.error ?? traceError(doc.value, model);
    return error === undefined ? [] : [finding(file, "The runtime trace does not match the state machine table.", error)];
  });
};

export default { tables, traces };
