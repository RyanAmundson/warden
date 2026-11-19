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
let bodies: Record<string, unknown> = {};

const health = { status: "ok", pid: 1, version: "0.1.8", heartbeatAt: "2026-11-18T17:00:00Z", heartbeatFile: "/w/daemon/heartbeat.json", intervalMs: 10000, staleAfterMs: 30000, port: 7419 };

const boot = async (path: string): Promise<FakeSource> => {
  const [pathname, search = ""] = path.split("?");
  vi.stubGlobal("location", { pathname, search: search === "" ? "" : `?${search}` });
  const file = join(scratch, `app-${++copies}.mjs`);
  writeFileSync(file, source);
  await import(pathToFileURL(file).href);
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
  bodies = { "/api/health": health, "/api/projects": { projects: [] }, "/api/tamper": { open: [], recent: [] }, "/api/determinism": { projects: [] } };
  const root = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; }, addEventListener() {}, querySelector() { return null; } };
  vi.stubGlobal("document", { getElementById: (id: string) => (id === "app" ? root : null), activeElement: null, title: "" });
  vi.stubGlobal("CSS", { escape: (s: string) => s });
  vi.stubGlobal("EventSource", FakeSource);
  vi.stubGlobal("fetch", async (path: string) => {
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
