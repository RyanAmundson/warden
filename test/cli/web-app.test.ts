import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const wardenRoot = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "warden-web-app-"));
const source = readFileSync(join(wardenRoot, "web/app.js"), "utf8").replace('"/render.js"', JSON.stringify(pathToFileURL(join(wardenRoot, "web/render.js")).href));
let copies = 0;

class FakeSource {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 2;
  static all: FakeSource[] = [];
  readyState = 0;
  listeners: Record<string, ((e: { data?: string }) => void)[]> = {};
  constructor() {
    FakeSource.all.push(this);
  }
  addEventListener(name: string, f: (e: { data?: string }) => void): void {
    (this.listeners[name] ??= []).push(f);
  }
  fire(name: string, data?: string): void {
    for (const f of this.listeners[name] ?? []) f({ data });
  }
  close(): void {
    this.readyState = 2;
  }
}

let html = "";
let up = true;
let on: Record<string, (e: unknown) => unknown> = {};
let fetches = 0;
const heading = { tagName: "H1", tabIndex: 0, focus: vi.fn() };
const focusedCatalogLink = { focus: vi.fn() };
const packAnchor = { focus: vi.fn(), scrollIntoView: vi.fn() };
const origin = "http://127.0.0.1:7419";
const place = { pathname: "/", search: "", hash: "", origin, get href() { return `${origin}${this.pathname}${this.search}${this.hash}`; }, assign: vi.fn(), reload: vi.fn() };
const moveTo = (href: string): void => {
  const url = new URL(href, origin);
  Object.assign(place, { pathname: url.pathname, search: url.search, hash: url.hash });
};
let bodies: Record<string, unknown> = {};

const health = { status: "ok", pid: 1, version: "0.1.8", heartbeatAt: "2026-11-18T17:00:00Z", heartbeatFile: "/w/daemon/heartbeat.json", intervalMs: 10000, staleAfterMs: 30000, port: 7419 };

const boot = async (path: string): Promise<FakeSource> => {
  moveTo(path);
  history.pushState(null, "", path);
  vi.mocked(history.pushState).mockClear();
  const file = join(scratch, `app-${++copies}.mjs`);
  writeFileSync(file, source);
  await import(pathToFileURL(file).href);
  vi.mocked(history.replaceState).mockClear();
  await vi.advanceTimersByTimeAsync(0);
  const es = FakeSource.all.at(-1) as FakeSource;
  es.readyState = 1;
  es.fire("open");
  await vi.advanceTimersByTimeAsync(0);
  return es;
};

beforeEach(() => {
  vi.useFakeTimers();
  html = "";
  up = true;
  FakeSource.all = [];
  on = {};
  place.assign = vi.fn();
  place.reload = vi.fn();
  vi.stubGlobal("location", place);
  const entries: { href: string; state: unknown }[] = [];
  let at = -1;
  const go = vi.fn((delta: number) => {
    at += delta;
    moveTo(entries[at]?.href ?? "/");
  });
  vi.stubGlobal("history", {
    get state() {
      return entries[at]?.state ?? null;
    },
    pushState: vi.fn((state: unknown, _t: string, href: string) => {
      entries.splice(++at, Infinity, { href, state });
      moveTo(href);
    }),
    replaceState: vi.fn((state: unknown, _t: string, href: string) => {
      entries[at] = { href, state };
      moveTo(href);
    }),
    go,
    back: () => go(-1),
  });
  vi.stubGlobal("confirm", vi.fn(() => false));
  fetches = 0;
  heading.focus = vi.fn();
  focusedCatalogLink.focus.mockClear();
  packAnchor.focus.mockClear();
  packAnchor.scrollIntoView.mockClear();
  bodies = { "/api/health": health, "/api/projects": { projects: [] }, "/api/tamper": { open: [], recent: [] }, "/api/watch": { added: [], paused: [] }, "/api/determinism": { projects: [] } };
  const root = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; }, addEventListener(name: string, f: (e: unknown) => unknown) { on[name] = f; }, querySelector(sel: string) { return sel === "h1" ? heading : sel === '#pack-core a[href="#adapter-eslint"]' ? focusedCatalogLink : null; }, querySelectorAll() { return []; } };
  vi.stubGlobal("document", { getElementById: (id: string) => id === "app" ? root : id === "pack-info-core" ? packAnchor : null, activeElement: null, title: "" });
  heading.tabIndex = 0;
  vi.stubGlobal("window", { addEventListener(name: string, f: (e: unknown) => unknown) { on[name] = f; }, scrollTo: vi.fn() });
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("fetch", async (path: string) => {
    fetches += 1;
    if (!up) throw new TypeError("Failed to fetch");
    const key = path.split("?")[0] as string;
    if (!(key in bodies)) return { ok: false, status: 404, json: async () => ({ error: `no route ${key}`, next: "GET /api/health" }) };
    return { ok: true, status: 200, json: async () => bodies[key] };
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it("leaves the lost state when heartbeats resume on the same open stream", async () => {
  const es = await boot("/");
  expect(html).toContain("No projects are watched yet");
  await vi.advanceTimersByTimeAsync(35000);
  expect(html).toContain("The Warden daemon stopped answering");
  es.fire("heartbeat", JSON.stringify({ at: "2026-11-18T17:00:40Z" }));
  await vi.advanceTimersByTimeAsync(10);
  expect(html).not.toContain("The Warden daemon stopped answering");
  expect(html).toContain("Daemon live");
  expect(FakeSource.all).toHaveLength(1);
});

it("reloads on an evidence event while lost", async () => {
  const es = await boot("/");
  await vi.advanceTimersByTimeAsync(35000);
  expect(html).toContain("stopped answering");
  es.fire("evidence", JSON.stringify({ project: "warden" }));
  await vi.advanceTimersByTimeAsync(300);
  expect(html).not.toContain("stopped answering");
});

it("reuses the bundled catalog during evidence refreshes and reloads it after a daemon restart", async () => {
  bodies["/api/health"] = { ...health, startedAt: "2026-11-18T17:00:00Z" };
  bodies["/api/pack-catalog"] = {
    packs: [{ id: "core", rules: 2, adapters: ["eslint"], reviewAdapters: [] }],
    adapters: [{ id: "eslint", description: "Runs lint rules.", packs: ["core"] }],
    reviewAdapters: [],
  };
  const requests = vi.spyOn(globalThis, "fetch");
  const catalogRequests = () => requests.mock.calls.filter(([path]) => path === "/api/pack-catalog");
  const es = await boot("/pack-catalog");
  expect(html).toContain('href="#adapter-eslint"');
  expect(catalogRequests()).toHaveLength(1);

  Object.assign(document, { activeElement: {
    matches: (selector: string) => selector.includes(".catalog-grid a"),
    closest: () => ({ id: "pack-core" }),
    getAttribute: () => "#adapter-eslint",
  } });
  bodies["/api/projects"] = { projects: [{ project: "new-project" }] };
  es.fire("evidence");
  es.fire("tamper");
  await vi.advanceTimersByTimeAsync(300);
  expect(html).toContain("new-project");
  expect(focusedCatalogLink.focus).toHaveBeenCalledOnce();
  expect(catalogRequests()).toHaveLength(1);

  es.readyState = FakeSource.CONNECTING;
  es.fire("error");
  bodies["/api/health"] = { ...health, startedAt: "2026-11-18T17:01:00Z" };
  bodies["/api/pack-catalog"] = { packs: [{ id: "new-pack", rules: 0, adapters: [], reviewAdapters: [] }], adapters: [], reviewAdapters: [] };
  es.readyState = FakeSource.OPEN;
  es.fire("open");
  await vi.advanceTimersByTimeAsync(0);
  expect(html).toContain("new-pack");
  expect(catalogRequests()).toHaveLength(2);
});

it("shows the empty state on a run page when no project is watched", async () => {
  await boot("/run?project=gone&run=r-1");
  expect(html).toContain("No projects are watched yet");
});

it("shows a next action, not the lost banner, when a page cannot be drawn", async () => {
  bodies["/api/projects"] = { projects: [{ project: "warden", roots: ["/p/w"], lastRun: null, openAlerts: 0 }] };
  bodies["/api/runs"] = { project: "warden" };
  await boot("/runs?project=warden");
  expect(html).toContain("This page could not");
  expect(html).toContain("<code>reload this page</code>");
  expect(html).not.toContain("stopped answering");
});

it("shows the lost state when the daemon stops answering fetches", async () => {
  const es = await boot("/");
  up = false;
  es.fire("evidence", JSON.stringify({ project: "warden" }));
  await vi.advanceTimersByTimeAsync(300);
  expect(html).toContain("stopped answering");
});

it("goes lost when the event stream errors, and leaves it when the stream opens again", async () => {
  const es = await boot("/");
  up = false;
  es.readyState = 0;
  es.fire("error");
  await vi.advanceTimersByTimeAsync(0);
  expect(html).toContain("stopped answering");
  expect(html).toContain("Reconnecting every 10 seconds");
  up = true;
  es.readyState = 1;
  es.fire("open");
  await vi.advanceTimersByTimeAsync(0);
  expect(html).not.toContain("stopped answering");
});

it("says the page no longer reconnects when the browser closed the stream", async () => {
  const es = await boot("/");
  es.readyState = 2;
  es.fire("error");
  await vi.advanceTimersByTimeAsync(0);
  expect(html).toContain("no longer reconnects on its own");
});

it("names an unknown project instead of showing another one", async () => {
  bodies["/api/projects"] = { projects: [{ project: "warden", roots: ["/p/w"], lastRun: null, openAlerts: 0 }] };
  bodies["/api/runs"] = { project: "warden", runs: [] };
  await boot("/run?project=gone&run=r-1");
  expect(html).toContain("The daemon has no project named gone");
  expect(html).toContain("<code>pick a project in the sidebar</code>");
  expect(html).not.toContain("among the last");
});

it("enters the lost state from a page that could not be drawn", async () => {
  bodies["/api/projects"] = { projects: [{ project: "warden", roots: ["/p/w"], lastRun: null, openAlerts: 0 }] };
  bodies["/api/runs"] = { project: "warden" };
  const es = await boot("/runs?project=warden");
  expect(html).toContain("This page could not");
  es.readyState = 0;
  es.fire("error");
  await vi.advanceTimersByTimeAsync(0);
  expect(html).toContain("stopped answering");
});

const click = async (href: string, keys: { metaKey?: boolean } = {}): Promise<{ preventDefault: ReturnType<typeof vi.fn> }> => {
  const link = { href: new URL(href, origin).href, target: "", hasAttribute: () => false };
  const e = { button: 0, ...keys, preventDefault: vi.fn(), target: { closest: (sel: string) => (sel === "a[href]" ? link : null) } };
  await on.click?.(e);
  await vi.advanceTimersByTimeAsync(0);
  return e;
};

it("switches pages in place, keeping the one event stream open", async () => {
  bodies["/api/projects"] = { projects: [{ project: "warden", roots: ["/p/w"], lastRun: null, openAlerts: 0 }] };
  bodies["/api/runs"] = { project: "warden", runs: [] };
  await boot("/");
  expect(document.title).toBe("Overview · Warden");
  const e = await click("/tamper");
  expect(e.preventDefault).toHaveBeenCalled();
  expect(history.pushState).toHaveBeenCalledWith({ n: 1 }, "", `${origin}/tamper`);
  expect(document.title).toBe("Tamper · Warden");
  expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
  moveTo("/");
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(document.title).toBe("Overview · Warden");
  expect(FakeSource.all).toHaveLength(1);
  expect(place.assign).not.toHaveBeenCalled();
});

it("leaves modified clicks and in-page anchors to the browser", async () => {
  await boot("/");
  expect((await click("/tamper", { metaKey: true })).preventDefault).not.toHaveBeenCalled();
  expect((await click("/#detail")).preventDefault).not.toHaveBeenCalled();
  expect((await click("/api/health")).preventDefault).not.toHaveBeenCalled();
  expect(history.pushState).not.toHaveBeenCalled();
});

const warden = { projects: [{ project: "warden", roots: ["/p/w"], lastRun: null, openAlerts: 0 }] };
const layers = { project: "warden", bands: [], practices: [], packs: [], packSettings: { root: "/p/w", revision: "r1", packs: [{ id: "custom", on: false }] } };

it("shows published audit coverage and keeps checkout-only pages usable for watched projects", async () => {
  bodies["/api/projects"] = { projects: [
    { project: "example-project", roots: [], lastRun: null, openAlerts: 0, mode: "audit", auditOnly: { project: "example-project", root: "/p/ex", ref: "refs/remotes/origin/main" } },
    ...warden.projects,
  ] };
  bodies["/api/runs"] = { project: "example-project", runs: [] };
  bodies["/api/layers"] = layers;
  await boot("/?project=example-project");
  expect(html).toContain("1 project watched · 1 published audit");
  expect(html).toContain("Published audit · origin/main");
  for (const page of ["rule-strength", "violations"]) {
    const before = fetches;
    await click(`/${page}?project=example-project`);
    expect(fetches - before).toBe(2);
    expect(html).toContain("Watched checkout required");
    expect(html).toContain('href="/failures?project=example-project">Current failures');
    expect(html).toContain('href="/runs?project=example-project">Run history');
  }
  await click("/configuration?project=example-project");
  expect(html).not.toContain("pack-settings");
  expect(html).toContain('data-watch="example-project"');
  await click("/packs?project=warden");
  expect(html).toContain("Packs · warden");
  expect(html).not.toContain("Watched checkout required");
});

it("adds a watched project through the folder picker and stays in Configuration", async () => {
  const fetchGet = globalThis.fetch;
  const created = { project: "added", roots: ["/p/added"], lastRun: null, openAlerts: 0 };
  const post = vi.fn(async (_path: string, _body: string) => {
    bodies["/api/projects"] = { projects: [created] };
    bodies["/api/watch"] = { added: [{ project: "added", root: "/p/added" }], paused: [] };
    bodies["/api/layers"] = { ...layers, project: "added" };
    return { ok: true, status: 200, json: async () => ({ project: "added" }) };
  });
  vi.stubGlobal("fetch", (path: string, options: RequestInit) =>
    options.method === "POST" ? post(path, String(options.body)) : fetchGet(path, options));
  await boot("/configuration");
  expect(html).toContain('id="watch-add"');
  await on.submit?.({ target: { id: "watch-add" }, preventDefault: vi.fn() });
  expect(post).toHaveBeenCalledWith("/api/watch", JSON.stringify({ choose: true }));
  expect(place.search).toBe("");
  expect(html).toContain("Watching added.");
  expect(html).not.toContain("pack-settings");
});

it("opens run detail from a run row's non-link cell", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/runs"] = { project: "warden", runs: [] };
  await boot("/runs?project=warden");
  const link = { href: `${origin}/run?project=warden&run=r1`, target: "", hasAttribute: () => false };
  const e = { button: 0, preventDefault: vi.fn(), target: {
    closest: (selector: string) => selector === "tr[data-run-row]" ? { querySelector: () => link } : null,
  } };
  await on.click?.(e);
  await vi.advanceTimersByTimeAsync(0);
  expect(e.preventDefault).toHaveBeenCalled();
  expect(document.title).toBe("Run · Warden");
});

it("opens the previous Configuration pack bookmark in project Checks", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/project-checks"] = { bands: [], details: [], packs: [] };
  await boot("/configuration?project=warden&root=%2Fp%2Fw#pack-config");
  expect(document.title).toBe("warden · Warden");
  expect(html).toContain('tab=checks" aria-current="page">Checks');
  expect(html).not.toMatch(/Watched projects|data-nav="checkout"/);
});

it("opens legacy Layers bookmarks and treats Rule strength as a separate page in history", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/layers?project=warden#pack-info-core");
  expect(document.title).toBe("Configuration · Warden");
  expect(packAnchor.scrollIntoView).toHaveBeenCalledTimes(1);
  history.pushState(null, "", "/layers?project=warden#rule-strength");
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(document.title).toBe("Rule strength · Warden");
  history.back();
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(document.title).toBe("Configuration · Warden");
  expect(packAnchor.scrollIntoView).toHaveBeenCalledTimes(2);
});

it("keeps the selected checkout when switching between policy pages", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/packs?project=warden&root=%2Fp%2Fw");
  expect(html).toContain('Changes apply to this checkout.');
  const fetchGet = globalThis.fetch;
  const paths: string[] = [];
  vi.stubGlobal("fetch", (path: string, options?: RequestInit) => {
    paths.push(path);
    return fetchGet(path, options);
  });
  await click("/rule-strength?project=warden&root=%2Fp%2Fw");
  expect(paths).toContain("/api/layers?project=warden&root=%2Fp%2Fw");
  expect(html).toContain('href="/project?project=warden"');
});

it("asks before a switch discards unsaved pack changes, and stays when told to", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/tamper");
  await click("/packs?project=warden");
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  const e = await click("/tamper");
  expect(e.preventDefault).toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(document.title).toBe("Configuration · Warden");
  expect(place.pathname).toBe("/packs");
  history.back();
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(history.go).toHaveBeenLastCalledWith(1);
  expect(place.pathname).toBe("/packs");
  expect(document.title).toBe("Configuration · Warden");
  vi.mocked(confirm).mockReturnValue(true);
  await click("/tamper");
  expect(document.title).toBe("Tamper · Warden");
  expect(place.assign).not.toHaveBeenCalled();
});

it("abandons a pending switch when a pack is toggled before it draws", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/packs?project=warden");
  const link = { href: `${origin}/tamper`, target: "", hasAttribute: () => false };
  on.click?.({ button: 0, preventDefault() {}, target: { closest: (sel: string) => (sel === "a[href]" ? link : null) } });
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  await vi.advanceTimersByTimeAsync(0);
  expect(place.pathname).toBe("/packs");
  expect(document.title).toBe("Configuration · Warden");
  expect(history.go).toHaveBeenCalledWith(-1);
  expect(history.replaceState).not.toHaveBeenCalled();
});

it("returns to the page on screen in one step after two quick switches and a pack toggle", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/packs?project=warden");
  press("/tamper");
  press("/determinism");
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  await vi.advanceTimersByTimeAsync(0);
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(history.go).toHaveBeenCalledWith(-2);
  expect(confirm).not.toHaveBeenCalled();
  expect(place.pathname).toBe("/packs");
  expect(document.title).toBe("Configuration · Warden");
});

const press = (href: string): void => {
  const link = { href: new URL(href, origin).href, target: "", hasAttribute: () => false };
  on.click?.({ button: 0, preventDefault() {}, target: { closest: (sel: string) => (sel === "a[href]" ? link : null) } });
};

it("opens the Back address when Back is pressed while a switch is still loading", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/tamper");
  press("/packs?project=warden");
  history.back();
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(place.pathname).toBe("/tamper");
  expect(document.title).toBe("Tamper · Warden");
});

it("keeps the Packs address when a pack is toggled before a Back switch draws", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/tamper");
  await click("/packs?project=warden");
  expect(document.title).toBe("Configuration · Warden");
  history.back();
  on.popstate?.({});
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  await vi.advanceTimersByTimeAsync(0);
  expect(`${place.pathname}${place.search}`).toBe("/packs?project=warden");
  expect(document.title).toBe("Configuration · Warden");
});

it("returns from a cancelled two-step Back across a hash entry without reloading", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  bodies["/api/runs"] = { project: "warden", runs: [] };
  await boot("/tamper");
  await click("/runs?project=warden");
  history.pushState(null, "", "/runs?project=warden#x");
  on.popstate?.({});
  await click("/packs?project=warden");
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  history.go(-2);
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(history.go).toHaveBeenLastCalledWith(2);
  expect(`${place.pathname}${place.search}`).toBe("/packs?project=warden");
  expect(document.title).toBe("Configuration · Warden");
});

it("discards the pack draft as soon as a switch is confirmed", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/packs?project=warden");
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  vi.mocked(confirm).mockReturnValue(true);
  press("/tamper");
  press("/determinism");
  await vi.advanceTimersByTimeAsync(0);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(document.title).toBe("Determinism · Warden");
});

it("starts a run-detail switch from the top, as a fresh load does", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/runs"] = { project: "warden", runs: [] };
  await boot("/");
  await click("/runs?project=warden&run=r-1#detail");
  expect(window.scrollTo).toHaveBeenCalledWith(0, 0);
});

it("resets the selected run and filters the way a fresh load does", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/runs"] = { project: "warden", runs: [] };
  await boot("/runs?project=warden&run=gone");
  expect(html).toContain("has no retained record for run");
  await click("/runs?project=warden");
  expect(html).not.toContain("has no retained record for run");
});

it("moves focus to the new heading after a switch, not on the first load", async () => {
  await boot("/");
  expect(heading.focus).not.toHaveBeenCalled();
  await click("/tamper");
  expect(heading.focus).toHaveBeenCalledTimes(1);
  expect(heading.tabIndex).toBe(-1);
});

it("keeps focus on the heading when a live update redraws the page", async () => {
  const es = await boot("/");
  await click("/tamper");
  Object.assign(document, { activeElement: heading });
  heading.tabIndex = 0;
  heading.focus = vi.fn();
  packAnchor.focus.mockClear();
  packAnchor.scrollIntoView.mockClear();
  es.fire("evidence", JSON.stringify({ project: "warden" }));
  await vi.advanceTimersByTimeAsync(300);
  expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(heading.tabIndex).toBe(-1);
});

it("switches project from the sidebar to its own Status tab and scopes Checks saves", async () => {
  bodies["/api/projects"] = { projects: [...warden.projects, { project: "other", roots: ["/p/o"], lastRun: null, openAlerts: 0 }] };
  bodies["/api/runs"] = { project: "warden", runs: [] };
  bodies["/api/project-alerts"] = { alerts: [] };
  const rule = { id: "custom-check", name: "Check the build", kind: "runtime", statement: "Build without errors.", runs: ["commit"] };
  const settings = {
    bands: [{ name: "DETERMINISTIC", kinds: ["runtime"] }, { name: "JUDGMENT", kinds: ["model"] }],
    packs: [{ id: "custom", on: true }, { id: "model", on: false }, { id: "configuration-only", on: false }],
    details: [{ id: "custom", checks: [rule], adapters: [] }, { id: "model", checks: [{ ...rule, id: "model-check", kind: "model" }], adapters: [] }, { id: "configuration-only", checks: [], adapters: [] }],
    results: { "custom-check": { at: "2026-11-18T17:00:00Z", run: "r1", status: "Passed" } },
    revision: "r1",
  };
  const fetchGet = globalThis.fetch;
  const posts = vi.fn();
  vi.stubGlobal("fetch", (path: string, options: RequestInit) => {
    if (path.startsWith("/api/project-checks?")) return Promise.resolve({ ok: true, json: async () => settings });
    if (options.method === "POST") {
      posts(path, JSON.parse(String(options.body)));
      return Promise.resolve({ ok: true, json: async () => ({ changed: true }) });
    }
    return fetchGet(path, options);
  });
  await boot("/runs?project=warden");
  expect(html).toContain('href="/project?project=other"');
  await click("/project?project=other");
  const main = () => html.split("<main")[1];
  expect(main()).toContain('<h1 class="h1">other</h1>');
  expect(main()).toContain(">Passed</span>");
  expect(main()).toContain('project=other&amp;run=r1');
  expect(main()).not.toMatch(/warden|Watched projects|model-check/);
  await click("/project?project=other&tab=checks");
  expect(main()).toContain("Deterministic");
  expect(main()).toContain("Judgment");
  expect(main()).toContain("Packs without checks");
  expect(main()).toContain('data-pack="configuration-only"');
  expect(main()).not.toMatch(/<select|Watched projects|\/p\/o/);
  on.change?.({ target: { dataset: { pack: "custom" }, checked: false } });
  await on.submit?.({ target: { id: "pack-settings" }, preventDefault: vi.fn() });
  expect(posts).toHaveBeenCalledWith("/api/packs?project=other", { revision: "r1", changes: [{ id: "custom", enabled: false }] });
  expect(FakeSource.all).toHaveLength(1);
});

it("shows a staged enrollment and signs its exact revision in the owning project's Checks tab", async () => {
  const auditOnly = { ref: "refs/remotes/origin/main" };
  bodies["/api/projects"] = { projects: [...warden.projects, { project: "published", roots: [], auditOnly }] };
  bodies["/api/watch"] = { added: [], paused: [] };
  bodies["/api/project-checks"] = { packs: [], details: [], bands: [], results: {}, needsSignature: true };
  bodies["/api/project-alerts"] = { alerts: [] };
  const stage = { revision: "staged-revision", verified: false, canSign: true, files: [], rules: [], settings: [] };
  const invoked = vi.fn();
  const fetchGet = globalThis.fetch;
  vi.stubGlobal("fetch", (path: string, options: RequestInit) => {
    if (!path.startsWith("/api/enrollment-signing?")) return fetchGet(path, options);
    invoked(path, options.body);
    return Promise.resolve({ ok: true, json: async () => ({ ref: auditOnly.ref, stage: { ...stage, verified: options.method === "POST" } }) });
  });
  await boot("/configuration?project=published");
  expect(html).toContain("Watched projects");
  expect(invoked).not.toHaveBeenCalled();
  await click("/project?project=published");
  expect(invoked).not.toHaveBeenCalled();
  await click("/project?project=published&tab=checks");
  expect(html).toContain("Policy signing · published");
  await on.submit?.({ target: { id: "enrollment-signing" }, preventDefault: vi.fn() });
  expect(invoked).toHaveBeenLastCalledWith("/api/enrollment-signing?project=published", JSON.stringify({ revision: stage.revision }));
  expect(html).toContain("Signature verified");
});

it("moves through alert cards without making a navigation request", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/runs"] = { project: "warden", runs: [] };
  bodies["/api/tamper"] = { open: [{ project: "warden", detail: "changed" }, { project: "warden", detail: "removed" }] };
  await boot("/");
  expect(html).toContain("1 of 2");
  const before = fetches;
  on.click?.({ target: { closest: (selector: string) => selector === "button" ? { dataset: { alert: "next", index: "1" } } : null }, button: 0 });
  expect(html).toContain("2 of 2");
  expect(fetches).toBe(before);
});

it("leaves the page alone on a hash-only history change", async () => {
  await boot("/");
  const before = fetches;
  moveTo("/#detail");
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(fetches).toBe(before);
  expect(heading.focus).not.toHaveBeenCalled();
});

it("replaces the history entry when the link names the page already open", async () => {
  await boot("/tamper");
  await click("/tamper");
  expect(history.replaceState).toHaveBeenCalledWith({ n: 0 }, "", `${origin}/tamper`);
  expect(history.pushState).not.toHaveBeenCalled();
});

it("loads the requested receipt from a legacy preview link", async () => {
  bodies["/api/projects"] = { projects: [{ project: "warden", roots: ["/p/w"], lastRun: null, openAlerts: 0 }] };
  bodies["/api/runs"] = { project: "warden", runs: [{ run: "old-run", tier: "commit", at: health.heartbeatAt, outcome: "ran", result: "pass" }] };
  const load = vi.spyOn(globalThis, "fetch");
  await boot("/runs?project=warden&run=old-run");
  expect(load.mock.calls.map(([path]) => path)).toContain("/api/runs?project=warden&limit=100&run=old-run");
  expect(html).toContain("Run details");
  expect(html).toContain("old-run");
});
