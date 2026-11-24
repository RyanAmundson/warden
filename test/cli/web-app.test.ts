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
const heading = { tabIndex: 0, focus: vi.fn() };
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
  bodies = { "/api/health": health, "/api/projects": { projects: [] }, "/api/tamper": { open: [], recent: [] }, "/api/determinism": { projects: [] } };
  const root = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; }, addEventListener(name: string, f: (e: unknown) => unknown) { on[name] = f; }, querySelector(sel: string) { return sel === "h1" ? heading : null; }, querySelectorAll() { return []; } };
  vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null), activeElement: null, title: "" });
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
  expect(html).toContain("The daemon watches no project named gone");
  expect(html).toContain("<code>pick a project under Watched projects</code>");
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

it("asks before a switch discards unsaved pack changes, and stays when told to", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/tamper");
  await click("/layers?project=warden");
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  const e = await click("/tamper");
  expect(e.preventDefault).toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(document.title).toBe("Layers · Warden");
  expect(place.pathname).toBe("/layers");
  history.back();
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(history.go).toHaveBeenLastCalledWith(1);
  expect(place.pathname).toBe("/layers");
  expect(document.title).toBe("Layers · Warden");
  vi.mocked(confirm).mockReturnValue(true);
  await click("/tamper");
  expect(document.title).toBe("Tamper · Warden");
  expect(place.assign).not.toHaveBeenCalled();
});

it("abandons a pending switch when a pack is toggled before it draws", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/layers?project=warden");
  const link = { href: `${origin}/tamper`, target: "", hasAttribute: () => false };
  on.click?.({ button: 0, preventDefault() {}, target: { closest: (sel: string) => (sel === "a[href]" ? link : null) } });
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  await vi.advanceTimersByTimeAsync(0);
  expect(place.pathname).toBe("/layers");
  expect(document.title).toBe("Layers · Warden");
  expect(history.go).toHaveBeenCalledWith(-1);
  expect(history.replaceState).not.toHaveBeenCalled();
});

it("returns to the page on screen in one step after two quick switches and a pack toggle", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/layers?project=warden");
  press("/tamper");
  press("/determinism");
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  await vi.advanceTimersByTimeAsync(0);
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(history.go).toHaveBeenCalledWith(-2);
  expect(confirm).not.toHaveBeenCalled();
  expect(place.pathname).toBe("/layers");
  expect(document.title).toBe("Layers · Warden");
});

const press = (href: string): void => {
  const link = { href: new URL(href, origin).href, target: "", hasAttribute: () => false };
  on.click?.({ button: 0, preventDefault() {}, target: { closest: (sel: string) => (sel === "a[href]" ? link : null) } });
};

it("opens the Back address when Back is pressed while a switch is still loading", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/tamper");
  press("/layers?project=warden");
  history.back();
  on.popstate?.({});
  await vi.advanceTimersByTimeAsync(0);
  expect(place.pathname).toBe("/tamper");
  expect(document.title).toBe("Tamper · Warden");
});

it("keeps the Layers address when a pack is toggled before a Back switch draws", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/tamper");
  await click("/layers?project=warden");
  expect(document.title).toBe("Layers · Warden");
  history.back();
  on.popstate?.({});
  on.change?.({ target: { dataset: { pack: "custom" }, checked: true } });
  await vi.advanceTimersByTimeAsync(0);
  expect(`${place.pathname}${place.search}`).toBe("/layers?project=warden");
  expect(document.title).toBe("Layers · Warden");
});

it("discards the pack draft as soon as a switch is confirmed", async () => {
  bodies["/api/projects"] = warden;
  bodies["/api/layers"] = layers;
  await boot("/layers?project=warden");
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
  expect(html).toContain("is not among the last");
  await click("/runs?project=warden");
  expect(html).not.toContain("is not among the last");
});

it("moves focus to the new heading after a switch, not on the first load", async () => {
  await boot("/");
  expect(heading.focus).not.toHaveBeenCalled();
  await click("/tamper");
  expect(heading.focus).toHaveBeenCalledTimes(1);
  expect(heading.tabIndex).toBe(-1);
});

it("switches project from the picker in place", async () => {
  bodies["/api/projects"] = { projects: [...warden.projects, { project: "other", roots: ["/p/o"], lastRun: null, openAlerts: 0 }] };
  bodies["/api/runs"] = { project: "warden", runs: [] };
  await boot("/runs?project=warden");
  on.change?.({ target: { dataset: { nav: "project" }, value: "other" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(history.pushState).toHaveBeenCalledWith({ n: 1 }, "", `${origin}/runs?project=other`);
  expect(FakeSource.all).toHaveLength(1);
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
