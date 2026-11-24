import { beatText, frozenHtml, pageTitle, renderApp } from "/render.js";

// The page being opened. load() commits it to state with its data, so the old page stays on screen until then.
let params;
let page;
let project;
let jump;
let next;
// The address being opened, and the address of the page on screen. They differ while a switch loads.
let at;
let shown;
// Each history entry carries its position, so an abandoned switch can return to the page on screen in one step.
const position = () => history.state?.n ?? 0;
let shownAt;
const pageOf = (path) => path.replace(/^\/+|\/+$/g, "") || "overview";
const route = (url) => {
  params = new URLSearchParams(url.search);
  page = pageOf(url.pathname);
  project = params.get("project") ?? undefined;
  jump = url.hash === "#detail";
  at = `${url.pathname}${url.search}`;
  return { run: params.get("run") ?? undefined, outcome: "all", tier: "", file: "", filter: "", paused: false, packMessage: undefined };
};
const root = document.getElementById("app");
const view = { ...route(location), packDraft: new Map(), fresh: new Set() };
shown = at;
if (typeof history.state?.n !== "number") history.replaceState({ n: 0 }, "", location.href);
shownAt = position();
const state = { page, project, health: null, projects: [], data: null, error: null, lost: false, frozen: "", frozenAt: null, now: Date.now(), view };
const seen = new Set();
let lastBeat = Date.now();
let events;
let pending;
let loads = 0;

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
  const openDetails = state.page === "layers" ? [...root.querySelectorAll("[data-pack-details][open]")].map((details) => details.id) : [];
  try {
    root.innerHTML = renderApp(state);
  } catch (cause) {
    root.innerHTML = renderApp({ ...state, lost: false, error: { error: `This page could not be drawn: ${cause.message}`, next: "reload this page" } });
  }
  for (const id of openDetails) {
    const details = root.querySelector(`#${CSS.escape(id)}`);
    if (details) details.open = true;
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

// After an in-page navigation, show the new page the way a fresh load would: at the top, with focus on its heading.
const arrive = () => {
  if (next === undefined) return;
  next = undefined;
  const heading = root.querySelector("h1") ?? root.querySelector("main");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo(0, 0);
};

// Draw the opened page: its address, view settings, and whatever load() set.
const commit = () => {
  shown = at;
  shownAt = position();
  state.page = page;
  state.project = project;
  if (next !== undefined) Object.assign(state.view, next);
  render();
  arrive();
};

const load = async () => {
  const seq = ++loads;
  try {
    const [health, { projects }] = await Promise.all([api("/api/health"), api("/api/projects")]);
    if (seq !== loads) return;
    state.health = health;
    state.projects = projects;
    const needsProject = ["runs", "run", "layers", "violations"].includes(page);
    if (needsProject && project !== undefined && projects.length > 0 && !projects.some((p) => p.project === project)) {
      state.data = null;
      state.lost = false;
      state.error = { status: 404, error: `The daemon watches no project named ${project}`, next: "pick a project under Watched projects" };
      return commit();
    }
    if (project === undefined || !projects.some((p) => p.project === project)) project = projects[0]?.project;
    const loaded = needsProject && project === undefined ? {} : await (LOAD[page] ?? LOAD.overview)(projects, project);
    if (seq !== loads) return;
    const data = { projects, ...loaded };
    const { view } = state;
    if (view.packDraft.size && !view.packSaving &&
        (view.packTarget.project !== project || view.packTarget.root !== loaded.layers?.packSettings?.root)) {
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
    commit();
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
  commit();
};

// Abandon a switch that has not drawn yet: the address and target go back to the page on screen.
const stay = () => {
  if (position() !== shownAt) history.go(shownAt - position());
  route(new URL(shown, location.href));
  project = state.project;
  next = undefined;
};

// Open a page of this app without reloading, so the event stream stays open.
// Unsaved pack changes are discarded only after the same question beforeunload asks.
const go = (url, push = true) => {
  const { view } = state;
  if (view.packDraft.size || view.packSaving) {
    if (!confirm("Leave this page? Your unsaved pack changes will be lost.")) {
      if (!push) history.go(shownAt - position());
      return;
    }
    view.packDraft.clear();
  }
  if (push && url.href === location.href) history.replaceState(history.state, "", url.href);
  else if (push) history.pushState({ n: position() + 1 }, "", url.href);
  next = route(url);
  seen.clear();
  clearTimeout(pending);
  load();
};

// A hash-only change, such as "See run details", stays on the page being opened.
// Any other Back or Forward opens its address, even while a switch is still loading.
window.addEventListener("popstate", () => {
  if (`${location.pathname}${location.search}` !== at) go(new URL(location.href), false);
});

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
  const link = e.target.closest("a[href]");
  if (link && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !link.target && !link.hasAttribute("download")) {
    const url = new URL(link.href);
    const here = url.pathname === location.pathname && url.search === location.search;
    if (url.origin !== location.origin || !(pageOf(url.pathname) in LOAD) || (here && url.hash !== "")) return;
    e.preventDefault();
    return go(url);
  }
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
  if (el.dataset.nav === "project") go(new URL(`/${state.page}?project=${q(el.value)}`, location.href));
  if (el.dataset.nav === "checkout") go(new URL(`/layers?project=${q(state.project)}&root=${q(el.value)}`, location.href));
  if (el.dataset.pack !== undefined) {
    const { view } = state;
    const { root: checkout, revision, packs } = state.data.layers.packSettings;
    if (view.packDraft.size === 0) {
      if (next !== undefined) stay();
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
