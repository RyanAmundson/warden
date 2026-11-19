import { beatText, mainHtml, pageTitle, renderApp } from "/render.js";

const params = new URLSearchParams(location.search);
const page = location.pathname.replace(/^\/+|\/+$/g, "") || "overview";
const root = document.getElementById("app");
const state = { page, project: params.get("project") ?? undefined, health: null, projects: [], data: null, error: null, lost: false, frozen: "", frozenAt: null, now: Date.now(), view: { run: params.get("run") ?? undefined, outcome: "all", tier: "", file: "", filter: "", paused: false, fresh: new Set() } };
const seen = new Set();
let lastBeat = Date.now();
let events;
let pending;

const api = async (path) => {
  const res = await fetch(path, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status, body });
  return body;
};

const q = (name) => encodeURIComponent(name);
const runsFor = (project, limit) => api(`/api/runs?project=${q(project)}&limit=${limit}`);
const runsOf = async (projects, limit) => Object.fromEntries(await Promise.all(projects.map(async (p) => [p.project, (await runsFor(p.project, limit)).runs])));

const LOAD = {
  overview: async (ps) => ({ tamper: await api("/api/tamper"), runs: await runsOf(ps, 50) }),
  runs: async (ps, project) => ({ runs: await runsFor(project, 100) }),
  run: async (ps, project) => ({ runs: await runsFor(project, 100) }),
  layers: async (ps, project) => ({ layers: await api(`/api/layers?project=${q(project)}`) }),
  violations: async (ps, project) => ({ violations: await api(`/api/violations?project=${q(project)}`), layers: await api(`/api/layers?project=${q(project)}`), runs: await runsFor(project, 50) }),
  determinism: async (ps) => ({ determinism: await api("/api/determinism"), runs: await runsOf(ps, 100) }),
  tamper: async () => ({ tamper: await api("/api/tamper") }),
};

const runIds = (data) => (data.runs?.runs ?? Object.values(data.runs ?? {}).flat()).map((r) => r.run);

const focusKey = (el) => (el?.id ? `#${CSS.escape(el.id)}` : el?.dataset?.outcome ? `[data-outcome="${el.dataset.outcome}"]` : el?.dataset?.action ? `[data-action="${el.dataset.action}"]` : null);

const render = () => {
  state.now = Date.now();
  const key = focusKey(document.activeElement);
  const caret = document.activeElement?.selectionStart;
  root.innerHTML = renderApp(state);
  document.title = pageTitle(state);
  const el = key ? root.querySelector(key) : null;
  if (el) {
    el.focus();
    if (caret !== undefined && caret !== null && "setSelectionRange" in el) el.setSelectionRange(caret, caret);
  }
};

const goLost = () => {
  if (state.lost) return;
  state.frozen = mainHtml(state);
  state.frozenAt = new Date().toISOString();
  state.lost = true;
  render();
};

const load = async () => {
  try {
    const [health, { projects }] = await Promise.all([api("/api/health"), api("/api/projects")]);
    state.health = health;
    state.projects = projects;
    if (state.project === undefined || !projects.some((p) => p.project === state.project)) state.project = projects[0]?.project;
    const needsProject = ["runs", "run", "layers", "violations"].includes(page);
    const loaded = needsProject && state.project === undefined ? {} : await (LOAD[page] ?? LOAD.overview)(projects, state.project);
    const data = { projects, ...loaded };
    const ids = runIds(data);
    state.view.fresh = new Set(seen.size === 0 ? [] : ids.filter((id) => !seen.has(id)));
    for (const id of ids) seen.add(id);
    state.data = data;
    state.error = null;
    state.lost = false;
    lastBeat = Date.now();
  } catch (cause) {
    if (cause.status === undefined) return goLost();
    state.error = { status: cause.status, ...cause.body };
  }
  render();
};

const schedule = () => {
  if (state.view.paused || state.lost) return;
  clearTimeout(pending);
  pending = setTimeout(load, 250);
};

const connect = () => {
  events?.close();
  events = new EventSource("/api/events");
  events.addEventListener("open", () => {
    lastBeat = Date.now();
    if (state.lost) load();
  });
  events.addEventListener("error", () => {
    if (events.readyState !== EventSource.OPEN) goLost();
  });
  events.addEventListener("evidence", schedule);
  events.addEventListener("tamper", schedule);
  events.addEventListener("heartbeat", (e) => {
    lastBeat = Date.now();
    const beat = JSON.parse(e.data);
    if (beat && state.health) state.health.heartbeatAt = beat.at;
  });
};

root.addEventListener("click", async (e) => {
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.copy !== undefined) {
    await navigator.clipboard.writeText(el.dataset.copy);
    const label = el.textContent;
    el.textContent = "Copied";
    setTimeout(() => (el.textContent = label), 1500);
    return;
  }
  if (el.dataset.outcome) {
    state.view.outcome = el.dataset.outcome;
    state.view.run = undefined;
    return render();
  }
  if (el.dataset.action === "pause") {
    state.view.paused = !state.view.paused;
    if (state.view.paused) return render();
    return load();
  }
  if (el.dataset.action === "reconnect") {
    connect();
    load();
  }
});

root.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.nav === "project") location.href = `/${page}?project=${q(el.value)}`;
  if (el.dataset.action === "filter") {
    state.view.filter = el.value;
    render();
  }
  if (el.dataset.action === "tier") {
    state.view.tier = el.value;
    state.view.run = undefined;
    render();
  }
});

root.addEventListener("input", (e) => {
  if (e.target.dataset.action !== "file") return;
  state.view.file = e.target.value;
  state.view.run = undefined;
  render();
});

setInterval(() => {
  const stale = state.health?.staleAfterMs ?? 30000;
  if (!state.lost && state.health && Date.now() - lastBeat > stale) goLost();
  const beat = document.getElementById("beat");
  if (beat) beat.textContent = beatText(state.health, Date.now());
}, 1000);

connect();
load();
