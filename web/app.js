import { beatText, checkoutPageUnavailable, frozenHtml, pageTitle, renderApp } from "/render.js";

// The page being opened. load() commits it to state with its data, so the old page stays on screen until then.
let params;
let page;
let project;
let next;
// The address being opened, and the address of the page on screen. They differ while a switch loads.
let at;
let shown;
// Each history entry carries its position, so an abandoned switch can return to the page on screen in one step.
const position = () => history.state?.n ?? 0;
let shownAt;
const pageOf = (path) => path.replace(/^\/+|\/+$/g, "") || "overview";
const legacyStrength = (url) => pageOf(url.pathname) === "layers" && url.hash === "#rule-strength";
const routeAddress = (url) => `${url.pathname}${url.search}${legacyStrength(url) || url.hash === "#pack-config" ? url.hash : ""}`;
const route = (url) => {
  params = new URLSearchParams(url.search);
  page = pageOf(url.pathname);
  if (page === "configuration") page = "packs";
  if (page === "layers") page = legacyStrength(url) ? "rule-strength" : "packs";
  project = params.get("project") ?? undefined;
  if (page === "runs" && params.has("run")) page = "run";
  at = routeAddress(url);
  return { root: params.get("root") ?? undefined, run: params.get("run") ?? undefined, outcome: "all", tier: "", file: "", packShortcut: page === "packs" && (url.hash === "#pack-config" || pageOf(url.pathname) === "packs"), paused: false, ruleGroup: "strength", packMessage: undefined };
};
const root = document.getElementById("app");
const view = { ...route(location), packDraft: new Map(), fresh: new Set() };
shown = at;
if (typeof history.state?.n !== "number") history.replaceState({ n: 0 }, "", location.href);
shownAt = position();
let last = shownAt;
const state = { page, project, health: null, projects: [], data: null, error: null, lost: false, frozen: "", frozenAt: null, now: Date.now(), view };
const seen = new Set();
let lastBeat = Date.now();
let events;
let pending;
let loads = 0;
let arrived = false;

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

const loadPolicy = async (project, edit) => {
  const query = new URLSearchParams({ project });
  if (edit) query.set("edit", "1");
  if (params.has("root")) query.set("root", params.get("root"));
  return { layers: await api(`/api/layers?${query}`) };
};

const loadConfiguration = async (projects, project) => {
  const watch = api("/api/watch");
  const audit = projects.find((entry) => entry.project === project)?.auditOnly;
  const policy = project && !audit
    ? loadPolicy(project, true).catch((cause) => {
        if (cause.network || cause.status === undefined) throw cause;
        return { layersError: { status: cause.status, ...cause.body } };
      })
    : {};
  const review = audit ? api(`/api/enrollment-signing?project=${q(project)}`).catch((cause) => ({
    error: cause.message,
  })) : undefined;
  const [settings, packs, signing] = await Promise.all([watch, policy, review]);
  return { watch: settings, signing, ...packs };
};

const LOAD = {
  overview: async (ps) => ({ tamper: await api("/api/tamper"), runs: await runsOf(ps, 50) }),
  runs: async (ps, project) => ({ runs: await runsFor(project, 100) }),
  run: async (ps, project) => ({ runs: await api(`/api/runs?project=${q(project)}&limit=100${params.has("run") ? `&run=${q(params.get("run"))}` : "&detail=1"}`) }),
  failures: async (ps, project) => ({ failures: await api(`/api/failures?project=${q(project)}`) }),
  packs: loadConfiguration,
  "rule-strength": (ps, project) => loadPolicy(project, false),
  violations: async (ps, project) => ({ violations: await api(`/api/violations?project=${q(project)}`), layers: await api(`/api/layers?project=${q(project)}`), runs: await runsFor(project, 50) }),
  determinism: async (ps) => ({ determinism: await api("/api/determinism"), runs: await runsOf(ps, 100) }),
  tamper: async () => ({ tamper: await api("/api/tamper") }),
};

const runIds = (data) => (data.runs?.runs ?? Object.values(data.runs ?? {}).flat()).map((r) => r.run);

const focusKey = (el) => (el?.tagName === "H1" ? "h1" : el?.id ? `#${CSS.escape(el.id)}` : el?.dataset?.outcome ? `[data-outcome="${el.dataset.outcome}"]` : el?.dataset?.action ? `[data-action="${el.dataset.action}"]` : null);

const render = () => {
  state.now = Date.now();
  const key = focusKey(document.activeElement);
  const caret = document.activeElement?.selectionStart;
  const playing = root.querySelector("video");
  try {
    root.innerHTML = renderApp(state);
  } catch (cause) {
    root.innerHTML = renderApp({ ...state, lost: false, error: { error: `This page could not be drawn: ${cause.message}`, next: "reload this page" } });
  }
  const video = root.querySelector("video");
  if (playing && video?.src === playing.src) video.replaceWith(playing);
  document.title = pageTitle(state);
  const el = key ? root.querySelector(key) : null;
  if (el) {
    // A heading takes focus only after a switch; a redraw must keep it there.
    if (key === "h1") el.tabIndex = -1;
    el.focus(key === "h1" ? { preventScroll: true } : undefined);
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
  const navigating = next !== undefined;
  if (arrived && !navigating) return;
  arrived = true;
  next = undefined;
  const pack = page === "packs"
    ? document.getElementById(location.hash.startsWith("#pack-info-") ? location.hash.slice(1) : view.packShortcut ? "pack-config" : "")
    : null;
  if (pack) {
    pack.focus({ preventScroll: true });
    pack.scrollIntoView();
    return;
  }
  if (!navigating) return;
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
    const needsProject = ["runs", "run", "failures", "rule-strength", "violations"].includes(page);
    if (needsProject && project !== undefined && projects.length > 0 && !projects.some((p) => p.project === project)) {
      state.data = null;
      state.lost = false;
      state.error = { status: 404, error: `The daemon has no project named ${project}`, next: "pick a project in the sidebar" };
      return commit();
    }
    if (project === undefined || !projects.some((p) => p.project === project)) project = projects[0]?.project;
    const selected = projects.find((p) => p.project === project);
    const unavailable = (needsProject && project === undefined) || checkoutPageUnavailable(page, selected);
    const loaded = unavailable ? {} : await (LOAD[page] ?? LOAD.overview)(projects, project);
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
  last = position();
  next = route(url);
  seen.clear();
  clearTimeout(pending);
  load();
};

// In-page anchors stay on the current page. The old Rule strength bookmark changes pages.
// Any other Back or Forward opens its address, even while a switch is still loading.
// The browser makes a new entry with no state for a "#" link, after the one it left, so it is numbered here.
window.addEventListener("popstate", () => {
  if (typeof history.state?.n !== "number") history.replaceState({ n: last + 1 }, "", location.href);
  last = position();
  if (routeAddress(location) !== at) go(new URL(location.href), false);
});

const schedule = () => {
  if (page === "packs" && state.projects.some((entry) => entry.project === project && entry.auditOnly)) return;
  if (state.view.paused || state.view.packDraft.size || state.view.packSaving || state.view.watchSaving) return;
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

const changeWatch = async (change) => {
  if (view.watchSaving || view.packSaving || view.packDraft.size) return;
  const origin = at;
  view.watchSaving = true;
  clearTimeout(pending);
  render();
  try {
    const { project: changed } = await api("/api/watch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    });
    if ("root" in change) view.watchRoot = "";
    view.watchMessage = change.watching === false ? `Stopped watching ${changed}.` : `Watching ${changed}.`;
    if (at === origin && ("root" in change || (change.watching === false && changed === project))) {
      const url = new URL("/configuration", location.href);
      if ("root" in change) url.searchParams.set("project", changed);
      history.replaceState(history.state, "", url.href);
      Object.assign(view, route(url));
    }
    view.watchSaving = false;
    await load();
  } catch (error) {
    view.watchSaving = false;
    view.watchMessage = error.message;
    render();
  }
};

root.addEventListener("submit", async (e) => {
  const { view } = state;
  if (e.target.id === "enrollment-signing") {
    e.preventDefault();
    const selected = state.project;
    const stage = state.data.signing?.stage;
    if (!stage?.canSign || stage.verified || view.signingProject) return;
    const { revision } = stage;
    view.signingProject = selected;
    view.signingNotice = undefined;
    render();
    try {
      const signing = await api(`/api/enrollment-signing?project=${q(selected)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision }),
      });
      if (state.page === "packs" && state.project === selected) state.data.signing = signing;
    } catch (error) {
      if (state.page === "packs" && state.project === selected) {
        view.signingNotice = { project: selected, message: error.message };
        await load();
      }
    } finally {
      view.signingProject = undefined;
      render();
    }
    return;
  }
  if (e.target.id === "watch-add") {
    e.preventDefault();
    return changeWatch({ root: view.watchRoot ?? "" });
  }
  if (e.target.id !== "pack-settings") return;
  e.preventDefault();
  if (view.packDraft.size === 0 || view.packSaving || view.watchSaving) return;
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
  const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
  const link = e.target.closest("a[href]") ?? (!modified && !window.getSelection?.()?.toString()
    ? e.target.closest("tr[data-run-row]")?.querySelector("a.run-link")
    : null);
  if (link && e.button === 0 && !modified && !link.target && !link.hasAttribute("download")) {
    const url = new URL(link.href);
    const here = routeAddress(url) === routeAddress(location);
    if (url.origin !== location.origin || !(pageOf(url.pathname) in LOAD || ["layers", "configuration"].includes(pageOf(url.pathname))) || (here && url.hash !== "")) return;
    e.preventDefault();
    return go(url);
  }
  const el = e.target.closest("button");
  if (!el) return;
  if (el.dataset.watch) return changeWatch({ project: el.dataset.watch, watching: el.dataset.watching === "true" });
  if (el.dataset.copy !== undefined) {
    await navigator.clipboard.writeText(el.dataset.copy);
    const label = el.textContent;
    el.textContent = "Copied";
    setTimeout(() => (el.textContent = label), 1500);
    return;
  }
  if (el.dataset.ruleGroup) {
    state.view.ruleGroup = el.dataset.ruleGroup;
    return render();
  }
  if (el.dataset.outcome) {
    state.view.outcome = el.dataset.outcome;
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
  if (el.dataset.nav === "checkout") {
    const path = state.page === "packs" ? "configuration" : state.page;
    go(new URL(`/${path}?project=${q(state.project)}&root=${q(el.value)}${view.packShortcut ? "#pack-config" : ""}`, location.href));
  }
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
  if (el.dataset.action === "tier") {
    state.view.tier = el.value;
    render();
  }
});

root.addEventListener("input", (e) => {
  if (e.target.id === "watch-root") view.watchRoot = e.target.value;
  if (e.target.dataset.action !== "file") return;
  state.view.file = e.target.value;
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
