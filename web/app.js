import { beatText, frozenHtml, pageTitle, renderApp } from "/render.js";

const params = new URLSearchParams(location.search);
const page = location.pathname.replace(/^\/+|\/+$/g, "") || "overview";
const root = document.getElementById("app");
const state = { page, project: params.get("project") ?? undefined, health: null, projects: [], data: null, error: null, lost: false, frozen: "", frozenAt: null, now: Date.now(), view: { run: params.get("run") ?? undefined, outcome: "all", tier: "", file: "", filter: "", paused: false, packDraft: new Map(), fresh: new Set() } };
const seen = new Set();
let lastBeat = Date.now();
let events;
let pending;
let loads = 0;
let jump = location.hash === "#detail";

const api = async (path, options) => {
  const res = await fetch(path, { cache: "no-store", ...options }).catch((cause) => {
    throw Object.assign(cause, { network: true });
  });
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
  layers: async (ps, project) => ({ layers: await api(`/api/layers?project=${q(project)}&edit=1${params.has("root") ? `&root=${q(params.get("root"))}` : ""}`) }),
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
  try {
    root.innerHTML = renderApp(state);
  } catch (cause) {
    root.innerHTML = renderApp({ ...state, lost: false, error: { error: `This page could not be drawn: ${cause.message}`, next: "reload this page" } });
  }
  document.title = pageTitle(state);
  const el = key ? root.querySelector(key) : null;
  if (el) {
    el.focus();
    if (caret !== undefined && caret !== null && "setSelectionRange" in el) el.setSelectionRange(caret, caret);
  }
};

const goLost = () => {
  if (state.lost) return;
  try {
    state.frozen = frozenHtml(state);
  } catch {
    state.frozen = "";
  }
  state.frozenAt = new Date().toISOString();
  state.lost = true;
  render();
};

const load = async () => {
  const seq = ++loads;
  try {
    const [health, { projects }] = await Promise.all([api("/api/health"), api("/api/projects")]);
    if (seq !== loads) return;
    state.health = health;
    state.projects = projects;
    const needsProject = ["runs", "run", "layers", "violations"].includes(page);
    if (needsProject && state.project !== undefined && projects.length > 0 && !projects.some((p) => p.project === state.project)) {
      state.data = null;
      state.lost = false;
      state.error = { status: 404, error: `The daemon watches no project named ${state.project}`, next: "pick a project under Watched projects" };
      return render();
    }
    if (state.project === undefined || !projects.some((p) => p.project === state.project)) state.project = projects[0]?.project;
    const loaded = needsProject && state.project === undefined ? {} : await (LOAD[page] ?? LOAD.overview)(projects, state.project);
    if (seq !== loads) return;
    const data = { projects, ...loaded };
    const { view } = state;
    if (view.packDraft.size && !view.packSaving &&
        (view.packTarget.project !== state.project || view.packTarget.root !== loaded.layers?.packSettings?.root)) {
      view.packDraft.clear();
      view.packMessage = "The selected checkout is unavailable. Your unsaved pack changes were discarded.";
    }
    const ids = runIds(data);
    state.view.fresh = new Set(seen.size === 0 ? [] : ids.filter((id) => !seen.has(id)));
    for (const id of ids) seen.add(id);
    state.data = data;
    state.error = null;
    state.lost = false;
    state.streamClosed = false;
    state.loadedAt = Date.now();
    lastBeat = Date.now();
    render();
    const detail = jump && document.getElementById("detail");
    if (detail) {
      jump = false;
      if (detail.getBoundingClientRect().top > innerHeight) detail.scrollIntoView();
    }
    return;
  } catch (cause) {
    if (seq !== loads) return;
    if (cause.network) return goLost();
    state.lost = false;
    state.error = cause.status === undefined ? { error: `This page could not load: ${cause.message}`, next: "reload this page" } : { status: cause.status, ...cause.body };
  }
  render();
};

const schedule = () => {
  if (state.view.paused || state.view.packDraft.size || state.view.packSaving) return;
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
    state.streamClosed = events.readyState === EventSource.CLOSED;
    if (events.readyState === EventSource.OPEN) return;
    if (state.lost) render();
    else goLost();
  });
  events.addEventListener("evidence", schedule);
  events.addEventListener("tamper", schedule);
  events.addEventListener("heartbeat", (e) => {
    lastBeat = Date.now();
    const beat = JSON.parse(e.data);
    if (beat && state.health) state.health.heartbeatAt = beat.at;
    if (state.lost) load();
  });
};

window.addEventListener("beforeunload", (e) => {
  if (state.view.packDraft.size === 0) return;
  e.preventDefault();
  e.returnValue = "";
});

root.addEventListener("submit", async (e) => {
  if (e.target.id !== "pack-settings") return;
  e.preventDefault();
  const { view } = state;
  if (view.packDraft.size === 0 || view.packSaving) return;
  view.packSaving = true;
  view.packMessage = undefined;
  render();
  try {
    const { project, root: checkout, revision } = view.packTarget;
    await api(`/api/packs?project=${q(project)}&root=${q(checkout)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision, changes: [...view.packDraft].map(([id, enabled]) => ({ id, enabled })) }),
    });
    view.packDraft.clear();
    view.packMessage = "Config saved. Run warden compile in this checkout, then sign the commit.";
    view.packSaving = false;
    await load();
  } catch (error) {
    view.packSaving = false;
    view.packMessage = error.message;
    render();
  }
});

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
  if (el.dataset.action === "discard-packs") {
    state.view.packDraft.clear();
    state.view.packMessage = undefined;
    return load();
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
  if (el.dataset.nav === "checkout") location.href = `/layers?project=${q(state.project)}&root=${q(el.value)}`;
  if (el.dataset.pack !== undefined) {
    const { view } = state;
    const { root: checkout, revision, packs } = state.data.layers.packSettings;
    if (view.packDraft.size === 0) {
      clearTimeout(pending);
      view.packTarget = { project: state.project, root: checkout, revision };
      loads += 1;
    }
    const saved = packs.find((pack) => pack.id === el.dataset.pack);
    if (el.checked === saved.on) view.packDraft.delete(saved.id);
    else view.packDraft.set(saved.id, el.checked);
    view.packMessage = undefined;
    render();
  }
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
