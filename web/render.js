export const PAGES = { overview: "Overview", runs: "Runs", layers: "Layers", violations: "Violations", determinism: "Determinism", tamper: "Tamper" };

const PROJECT_PAGES = new Set(["runs", "run", "layers", "violations"]);

export const STEPS = [
  { id: "rules-intact", label: "rules intact", color: "#24364F" },
  { id: "tools-ready", label: "tools ready", color: "#5C7594" },
  { id: "rules", label: "rules", color: "#B8892B" },
  { id: "verdict", label: "verdict", color: "#7A5A1A" },
];

const REST = "#C3CAD3";

const SCALE_MS = 3000;

const TRIGGERS = { "agent-edit": "agent edit", "git-commit": "git commit", manual: "manual run", daemon: "daemon" };

const KIND_TEXT = { type: "compiler proves it", lint: "static analysis on every edit", runtime: "a command or test must pass", model: "a model decides", review: "a reviewer decides", instruction: "told, not checked", legacy: "wrapped old check" };

const KIND_RANK = { type: 0, lint: 0, runtime: 1, model: 2, review: 3, instruction: 4, legacy: 5 };

const DETERMINISTIC = new Set(["type", "lint", "runtime"]);

const BAND_TEXT = { deterministic: "a machine proves it, on every run", judgment: "someone decides, each time", prose: "told, never checked" };

const DETAIL_TEXT = {
  "source-drift": "A pack or record file changed without warden compile.",
  "generated-drift": "A generated tool config no longer matches what compile wrote.",
  "lock-drift": "The lock no longer matches the records it was compiled from.",
  loosened: "The lock or baseline was edited to weaken a Guardrail.",
  "weakened-kind": "A Guardrail was moved to a weaker kind.",
  "base-moved": "The lock's base branch changed.",
  "missing-lock": "The lock file is missing.",
  "leftover-temp": "A temporary file from an interrupted compile is still there.",
  "hooks-disabled": "A settings file sets disableAllHooks.",
  "hook-unwired": "The commit hook does not run Warden.",
  "plugin-missing": "The Warden Claude plugin was enabled here before and is no longer installed.",
  "plugin-disabled": "The Warden Claude plugin was enabled here before and is now turned off.",
  "gate-off": "A commit check ran with WARDEN_DAEMON=off, so it skipped the daemon gate.",
  "unchecked-commit": "A commit landed without a passing commit check for its tree.",
  "record-error": "A record no longer loads.",
  removed: ".warden/config.yaml was removed.",
};

const OUTCOME_TITLE = { error: "Error", tampered: "Tampered", unstaged: "Unstaged changes", refused: "Refused" };

const LOCK_KINDS = new Set(["source-drift", "generated-drift", "lock-drift", "loosened", "weakened-kind", "base-moved", "missing-lock", "leftover-temp"]);

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const clock = (at) => (at ? new Date(at).toTimeString().slice(0, 8) : "–");

const short = (at) => clock(at).slice(0, 5);

const num = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US"));

const ms = (n) => (n === undefined || n === null ? "–" : Math.round(n).toLocaleString("en-US"));

const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

const trigger = (run) => TRIGGERS[run.trigger] ?? run.trigger ?? "–";

const target = (run) => run.file ?? plural(run.files ?? 0, "file");

const stepOf = (id) => STEPS.find((s) => s.id === id);

const href = (page, params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  return esc(`/${page === "overview" ? "" : page}${query === "" ? "" : `?${query}`}`);
};

const ICON_X = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';

const ICON_DONE = '<svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="done"><path d="M3 7.5 L6 10.5 L11 4" stroke="#1F5E39" stroke-width="1.8" fill="none"/></svg>';

const ICON_FAIL = '<svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="stopped here"><path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" stroke="#8E1B14" stroke-width="1.8" fill="none"/></svg>';

const ICON_SKIP = '<svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="not reached"><circle cx="7" cy="7" r="4.5" stroke="#9AA3AE" stroke-width="1.4" fill="none"/></svg>';

const BRAND = '<svg width="34" height="14" viewBox="0 4 120 24" aria-hidden="true"><rect x="1" y="4" width="26" height="24" rx="7" fill="#C9A04A"/><circle cx="10" cy="16" r="3.5" fill="#1C2A3F"/><path d="M27 10 L112 10 L118 16.5 L112 23 L104 23 L100.5 20.25 L95.5 20.25 L88.5 24 L71.5 24 L64.5 14 L59.5 14 L52.5 21.5 L35.5 21.5 L32 24 L27 24 Z" fill="#C9A04A"/></svg>';

export const keyCuts = (name) => {
  const cuts = [];
  for (let i = 0; i < 6; i++) cuts.push(12.75 + ((name.charCodeAt(i % name.length) * (i + 3)) % 6) * 2.25);
  const xs = [[100.5, 95.5], [88.5, 83.5], [76.5, 71.5], [64.5, 59.5], [52.5, 47.5], [40.5, 35.5]];
  return `M27 10 L112 10 L118 16.5 L112 23 L104 23 ${xs.map(([a, b], i) => `L${a} ${cuts[i]} L${b} ${cuts[i]}`).join(" ")} L32 24 L27 24 Z`;
};

const projectKey = (name, open) =>
  `<svg width="180" height="48" viewBox="0 0 120 32" aria-hidden="true"><rect x="1" y="4" width="26" height="24" rx="7" fill="${open ? "#F3D3CF" : "#C9A04A"}" stroke="${open ? "#8E1B14" : "#6E5013"}" stroke-width="0.6"/><circle cx="10" cy="16" r="3.5" fill="#F8F9FA" stroke="${open ? "#8E1B14" : "#6E5013"}" stroke-width="0.6"/><path d="${keyCuts(name)}" fill="${open ? "#F3D3CF" : "#C9A04A"}" stroke="${open ? "#8E1B14" : "#6E5013"}" stroke-width="0.6"${open ? ' stroke-dasharray="1.5 1"' : ""}/></svg>`;

export const passed = (run) => run.outcome === "ran" && run.result === "pass" && run.alert === undefined;

export const notPassing = (run) => !passed(run) && run.outcome !== "empty";

export const stoppedAt = (run) => {
  const reached = STEPS.filter((s) => run.steps?.[s.id] !== undefined);
  return reached.at(-1);
};

export const outcome = (run) => {
  if (run.outcome === "ran" && run.alert !== undefined) return { cls: "block", text: "Block · alert", icon: true };
  if (run.outcome === "ran" && run.result === "pass") return { cls: "pass", text: "Pass" };
  if (run.outcome === "ran" && run.result === "fail") {
    const first = run.failures?.[0];
    return { cls: "block", text: first === undefined || first.line === undefined ? "Block" : `Block · L${first.line}`, icon: true };
  }
  if (run.outcome === "ran") return { cls: "idle", text: "No result recorded" };
  if (run.outcome === "empty") return { cls: "idle", text: "No changes" };
  if (run.outcome === "tampered") return { cls: "tamper", text: "Tampered", icon: true };
  if (run.outcome === "unstaged") return { cls: "err", text: "Unstaged", icon: true };
  if (run.outcome === "refused") return { cls: "err", text: "Refused", icon: true };
  if (run.outcome === "error") return { cls: "err", text: stoppedAt(run) ? `Error · ${stoppedAt(run).label}` : "Error", icon: true };
  return { cls: "idle", text: run.outcome ?? "Unknown" };
};

const tag = ({ cls, text, icon }) => `<span class="tag ${cls}">${icon ? ICON_X : ""}${esc(text)}</span>`;

const nextBox = (text) => `<div class="next"><span class="lbl">Next action</span><code>${esc(text)}</code><button class="btnr" type="button" data-copy="${esc(text)}">Copy</button></div>`;

export const durationBar = (run) => {
  let sum = 0;
  const segs = STEPS.map((s) => {
    const v = run.steps?.[s.id] ?? 0;
    sum += v;
    return `<span style="width:${(v > 0 ? Math.max((v / SCALE_MS) * 100, 0.4) : 0).toFixed(2)}%;background:${s.color}"></span>`;
  });
  const rest = Math.max(0, (run.ms ?? 0) - sum);
  return `<div class="track" role="img" aria-label="${esc(`${ms(run.ms)} ms in all`)}">${segs.join("")}<span style="width:${((rest / SCALE_MS) * 100).toFixed(2)}%;background:${REST}"></span></div>`;
};

const stepLegend = () =>
  `<div class="legend">${STEPS.map((s) => `<span><i class="sw" aria-hidden="true" style="background:${s.color}"></i>${s.label}</span>`).join("")}<span><i class="sw" aria-hidden="true" style="background:${REST}"></i>setup and records</span><span>Every bar shares one scale, 0 to 3 s</span></div>`;

export const projectStatus = (p) => {
  if (p.openAlerts > 0) return { cls: "tamper", text: plural(p.openAlerts, "open alert"), icon: true };
  if (p.lastRun === null || p.lastRun === undefined) return { cls: "idle", text: "No runs yet" };
  return outcome(p.lastRun);
};

const ago = (at, now) => {
  if (!at) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
};

export const beatText = (health, now) => `Heartbeat ${ago(health?.heartbeatAt, now)} · 127.0.0.1:${health?.port ?? "–"}`;

const homeOf = (file) => (file ? file.replace(/\/daemon\/heartbeat\.json$/, "") : "WARDEN_HOME");

const sidebar = (state) => {
  const { health, projects = [], page, project, lost, now } = state;
  const nav = Object.entries(PAGES)
    .map(([id, label]) => {
      const current = id === page || (id === "runs" && page === "run");
      return `<li><a href="${href(id, PROJECT_PAGES.has(id) ? { project } : {})}"${current ? ' aria-current="page"' : ""}>${label}</a></li>`;
    })
    .join("");
  const watched = projects
    .map((p) => {
      const s = projectStatus(p);
      const tone = s.cls === "pass" ? "" : s.cls === "idle" ? " none" : " bad";
      return `<li><a href="${href("runs", { project: p.project })}"${PROJECT_PAGES.has(page) && p.project === project ? ' aria-current="true"' : ""}><span>${esc(p.project)}</span><small class="${tone.trim()}">${esc(s.text)}</small></a></li>`;
    })
    .join("");
  return `<nav class="side" aria-label="Warden">
<div class="brand">${BRAND}<span>WARDEN</span></div>
<div class="daemon${lost ? " lost" : ""}"><b><i aria-hidden="true"></i>${lost ? "Daemon not answering" : "Daemon live"}</b><span id="beat">${esc(beatText(health, now))}</span></div>
<div class="navs"><ul class="nav">${nav}</ul>
<div><div class="lbl">Watched projects</div><ul class="nav">${watched === "" ? '<li class="empty-item">None yet</li>' : watched}</ul></div></div>
<div class="foot">Warden ${esc(health?.version ?? "")} · evidence in ${esc(homeOf(health?.heartbeatFile))}</div>
</nav>`;
};

const header = (title, sub, controls = "") => `<header class="head"><div><h1 class="h1">${title}</h1><div class="muted">${sub}</div></div>${controls === "" ? "" : `<div class="controls">${controls}</div>`}</header>`;

const projectPicker = (state, id) =>
  `<label class="lbl" for="${id}">Project</label><select id="${id}" data-nav="project">${state.projects.map((p) => `<option value="${esc(p.project)}"${p.project === state.project ? " selected" : ""}>${esc(p.project)}</option>`).join("")}</select>`;

export const emptyState = (page) => `${header(PAGES[page === "run" ? "runs" : page] ?? "Overview", "0 projects watched")}
<section class="mod empty" aria-labelledby="em-h">
<svg class="keyart" width="300" height="80" viewBox="0 0 120 32" role="img" aria-label="An empty key outline: no lock to fit yet"><rect x="1" y="4" width="26" height="24" rx="7" fill="none" stroke="#9AA3AE" stroke-width="0.8" stroke-dasharray="2 1.5"/><circle cx="10" cy="16" r="3.5" fill="none" stroke="#9AA3AE" stroke-width="0.8"/><path d="M27 10 L112 10 L118 16.5 L112 23 L27 23" fill="none" stroke="#9AA3AE" stroke-width="0.8" stroke-dasharray="2 1.5"/></svg>
<div><h2 id="em-h">No projects are watched yet</h2>
<p>The daemon watches every project that warden init registered, and every project whose checks wrote evidence. It has found none. Set Warden up in a project and it appears here, with its runs streaming as agents edit.</p>
${nextBox("run warden init in a project")}</div>
</section>`;

export const lostBanner = (state) => {
  const retry = Math.round((state.health?.intervalMs ?? 10000) / 1000);
  return `<section class="banner amber lost" role="alert" aria-labelledby="dl-h">
<div><h2 id="dl-h">The Warden daemon stopped answering</h2>
<p>No heartbeat since ${esc(clock(state.health?.heartbeatAt))}, so this page stopped updating at ${esc(clock(state.frozenAt))}. Commit checks refuse to run until the daemon is back; edit checks still run and still write evidence. Reconnecting every ${retry} seconds.</p>
<div><button class="btn" type="button" data-action="reconnect">Reconnect now</button></div></div>
${nextBox("run warden daemon install")}
</section>`;
};

export const apiError = (err) => `<section class="banner amber" role="alert" aria-labelledby="ae-h">
<div class="top">${tag({ cls: "err", text: `Error ${err.status ?? ""}`.trim(), icon: true })}<h2 id="ae-h">The daemon could not load this page</h2></div>
<p class="mono">${esc(err.error)}</p>
${nextBox(err.next)}
</section>`;

const alertsSection = (data) => {
  const rows = [];
  const byProject = new Map();
  for (const d of data.tamper.open) byProject.set(d.project, [...(byProject.get(d.project) ?? []), d]);
  for (const [project, list] of byProject) {
    const first = list[0];
    rows.push(`<div class="alert lit red">${tag({ cls: "tamper", text: "Tamper", icon: true })}<div><strong>${esc(project)}</strong> · ${plural(list.length, "open detection")}: ${esc(first.detail)} on <span class="mono">${esc(first.file)}</span>${list.length > 1 ? ` and ${plural(list.length - 1, "more")}` : ""}<div class="why">Next action: <span class="mono">${esc(first.next)}</span></div></div><a href="${href("tamper")}">Open tamper detections</a></div>`);
  }
  for (const p of data.projects) {
    const run = p.lastRun;
    if (!run || !notPassing(run)) continue;
    const o = outcome(run);
    rows.push(`<div class="alert lit">${tag(o)}<div><strong>${esc(p.project)}</strong> · the last ${esc(run.tier ?? "")} check, at ${esc(clock(run.at))}, did not pass${run.next ? `<div class="why">Next action: <span class="mono">${esc(run.next)}</span></div>` : ""}</div><a href="${href("run", { project: p.project, run: run.run })}">Open the run</a></div>`);
  }
  if (rows.length === 0) rows.push(`<div class="alert">${tag({ cls: "idle", text: "Clear" })}<div class="muted">No open tamper detections, and every project's last run passed or found no changes.</div><a href="${href("tamper")}">Tamper history</a></div>`);
  return `<section class="mod" aria-labelledby="ov-alerts"><div class="modh"><h2 class="h2" id="ov-alerts">Alerts</h2><span class="muted">Open tamper detections and last runs that did not pass</span></div>${rows.join("")}</section>`;
};

const projectCard = (p, runs) => {
  const run = p.lastRun;
  const lastPass = runs.find(passed);
  const ratchet = runs.find((r) => r.ratchet !== undefined)?.ratchet;
  const s = projectStatus(p);
  const id = `ov-${p.project.replace(/[^a-z0-9]/gi, "-")}`;
  const tail = (path) => (path ?? "").split("/").slice(-2).join("/");
  const roots = `<span title="${esc(p.roots.join("\n"))}">…/${esc(tail(p.roots[0]))}</span>${p.roots.length > 1 ? ` and ${plural(p.roots.length - 1, "other worktree")}` : ""}`;
  const end = run && notPassing(run) && run.next ? nextBox(run.next) : `<div class="calm">${run === null || run === undefined ? "No check has run here yet." : run.outcome === "empty" ? "The last run found no changes; nothing to do." : run.outcome === "ran" && run.result === "pass" ? "The last run passed; nothing to do." : "The last run recorded no next action."}</div>`;
  return `<section class="mod card" aria-labelledby="${id}">
<div class="modh"><div><h2 class="h2" id="${id}">${esc(p.project)}</h2><span class="muted mono">${roots}</span></div>${tag(s)}</div>
<div class="keyrow">${projectKey(p.project, p.openAlerts > 0)}<div>${p.openAlerts > 0 ? `<span class="bad">${plural(p.openAlerts, "open tamper detection")}</span><a href="${href("tamper")}">See what changed</a>` : '<span class="ok">No open tamper detections</span><span class="muted">The daemon is watching its hooks and records</span>'}</div></div>
<div class="stats"><div><div class="lbl">Last run</div><div>${run ? `${esc(clock(run.at))} · ${esc(run.tier ?? "")}` : "–"}</div></div><div><div class="lbl">Last pass</div><div>${lastPass ? `${esc(clock(lastPass.at))} · ${esc(lastPass.tier ?? "")}` : (runs.length === 0 ? "–" : `none in the last ${plural(runs.length, "run")}`)}</div></div><div><div class="lbl">Open alerts</div><div>${num(p.openAlerts)}</div></div><div><div class="lbl">Ratchet left</div><div>${ratchet ? num(ratchet[1]) : "–"}</div></div></div>
${end}
</section>`;
};

const runRow = (run, cols, view) => {
  const cells = {
    time: `<td>${esc(clock(run.at))}</td>`,
    timeLink: `<td><a href="${href("runs", { project: run.project, run: run.run })}#detail" style="font-weight:600">${esc(clock(run.at))}</a></td>`,
    project: `<td style="font-weight:600">${esc(run.project)}</td>`,
    trigger: `<td>${esc(trigger(run))}</td>`,
    tier: `<td>${esc(run.tier ?? "–")}</td>`,
    changed: `<td>${esc(target(run))}</td>`,
    outcome: `<td>${tag(outcome(run))}</td>`,
    bar: `<td>${durationBar(run)}</td>`,
    ms: `<td class="r">${ms(run.ms)}</td>`,
    ratchet: `<td class="r">${run.ratchet ? num(run.ratchet[1]) : "–"}</td>`,
    next: `<td class="mono clip" title="${esc(run.next ?? "")}">${esc(run.next ?? "nothing to do")}</td>`,
  };
  const cls = [view?.selected === run.run ? "sel" : notPassing(run) ? "held" : "", view?.fresh?.has(run.run) ? "arrived" : ""].filter(Boolean).join(" ");
  return `<tr${cls === "" ? "" : ` class="${cls}"`}${view?.selected === run.run ? ' aria-current="true"' : ""}>${cols.map((c) => cells[c]).join("")}</tr>`;
};

export const overviewPage = (state) => {
  const { data, view = {} } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const all = data.projects.flatMap((p) => (data.runs[p.project] ?? []).map((r) => ({ ...r, project: p.project })));
  const stream = all.filter((r) => !view.filter || r.project === view.filter).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
  const now = new Date(state.now ?? Date.now());
  const controls = `<label class="lbl" for="ov-proj">Project</label><select id="ov-proj" data-action="filter"><option value="">All projects</option>${data.projects.map((p) => `<option value="${esc(p.project)}"${view.filter === p.project ? " selected" : ""}>${esc(p.project)}</option>`).join("")}</select><button class="btn" type="button" data-action="pause" aria-pressed="${view.paused ? "true" : "false"}">${view.paused ? "Resume live" : "Pause live"}</button>`;
  const cols = ["time", "project", "trigger", "tier", "changed", "outcome", "bar", "ms", "ratchet"];
  return `${header("Overview", `${plural(data.projects.length, "project")} watched · updated ${esc(clock(now.toISOString()))} · ${esc(now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }))}${view.paused ? " · live updates paused" : ""}`, controls)}
${alertsSection(data)}
<div class="cards">${data.projects.map((p) => projectCard(p, data.runs[p.project] ?? [])).join("")}</div>
<section class="mod" aria-labelledby="ov-stream"><div class="modh"><h2 class="h2" id="ov-stream">Live check runs</h2>${stepLegend()}</div>
<div class="scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Project</th><th scope="col">Trigger</th><th scope="col">Tier</th><th scope="col">Changed</th><th scope="col">Outcome</th><th scope="col">Duration</th><th scope="col" class="r">ms</th><th scope="col" class="r">Ratchet left</th></tr></thead>
<tbody>${stream.length === 0 ? '<tr><td colspan="9" class="muted">No check has run yet. Runs appear here as agents edit and commit.</td></tr>' : stream.map((r) => runRow({ ...r, project: r.project }, cols, { fresh: view.fresh })).join("")}</tbody></table></div></section>`;
};

const stepsList = (run) => {
  const stop = notPassing(run) ? stoppedAt(run)?.id : undefined;
  let sum = 0;
  const items = STEPS.map((s, i) => {
    const v = run.steps?.[s.id];
    if (v === undefined) return `<li>${ICON_SKIP}<span class="no">${i + 1} ${s.label}</span><span class="no">not reached</span><span class="r no">–</span></li>`;
    sum += v;
    const failed = s.id === stop && run.outcome !== "ran";
    const blocked = s.id === "verdict" && (run.result === "fail" || run.alert !== undefined);
    const note = s.id === "rules" && run.rules !== undefined ? [...Object.entries(run.rules).map(([id, n]) => `${id} ${ms(n)} ms`), ...((run.cachedRules ?? []).length > 0 ? [`${run.cachedRules.length} cached`] : [])].join(" · ") || "no rule needed to run" : blocked ? (run.alert === undefined ? `${plural(run.failures?.length ?? 0, "failure")}` : `open tamper alert: ${run.alert}`) : failed ? `stopped here: ${OUTCOME_TITLE[run.outcome] ?? run.outcome}` : "done";
    return `<li>${failed || blocked ? ICON_FAIL : ICON_DONE}<span style="font-weight:650">${i + 1} ${s.label}</span><span class="wrap${failed || blocked ? " bad" : " muted"}">${esc(note)}</span><span class="r">${ms(v)} ms</span></li>`;
  });
  items.push(`<li><span></span><span class="muted">setup and records</span><span></span><span class="r">${ms(Math.max(0, (run.ms ?? 0) - sum))} ms</span></li>`);
  return `<ol class="steps">${items.join("")}</ol>`;
};

const failuresTable = (run) => {
  const list = run.failures ?? [];
  if (list.length === 0) return "";
  return `<div class="pad lbl">Failures · ${num(list.length)}</div><div class="scroll"><table><thead><tr><th scope="col">File</th><th scope="col" class="r">Line</th><th scope="col">Guardrail</th><th scope="col">Practice</th></tr></thead><tbody>${list
    .map((f) => `<tr><td class="mono">${esc(f.file === "" ? "project" : f.file)}</td><td class="r">${esc(f.line ?? "")}</td><td class="mono">${esc(f.guardrail)}</td><td>${esc(f.practice)}</td></tr>${f.doThis ? `<tr><td colspan="4" class="wrap muted">Do this: ${esc(f.doThis)}</td></tr>` : ""}`)
    .join("")}</tbody></table></div>`;
};

const tierTitle = (run) => `${(run.tier ?? "run").replace(/^./, (c) => c.toUpperCase())} check · ${clock(run.at)}`;

const runSub = (run) => `triggered by ${trigger(run)} · ${target(run)}${run.bytes ? ` · ${(run.bytes / 1000).toFixed(1)} kB` : ""} · ${ms(run.ms)} ms · exit ${run.exit ?? "–"}${run.commit ? ` · commit ${run.commit.slice(0, 7)}` : ""}`;

const runDetail = (project, run) => `<section class="mod narrow detail" id="detail" aria-labelledby="rn-dh">
<div class="modh"><div><h2 class="h2" id="rn-dh">${esc(tierTitle(run))}</h2><span class="muted">${esc(runSub(run))}</span></div>${tag(outcome(run))}</div>
${stepsList(run)}
${failuresTable(run)}
${run.next ? nextBox(run.next) : '<div class="pad muted">Nothing to do for this run.</div>'}
<div class="acts"><a href="${href("run", { project, run: run.run })}" style="font-weight:600">Open the run</a><button class="btn" type="button" data-copy="${esc(run.run)}">Copy run id</button>${run.ratchet ? `<span class="mono muted">ratchet ${num(run.ratchet[0])} → ${num(run.ratchet[1])}</span>` : ""}</div>
</section>`;

export const filterRuns = (runs, view = {}) =>
  runs.filter((r) => (view.outcome === "pass" ? passed(r) : view.outcome === "not" ? notPassing(r) : true) && (!view.tier || r.tier === view.tier) && (!view.file || [r.file ?? "", ...(r.failures ?? []).map((f) => f.file)].some((f) => f.includes(view.file))));

export const runsPage = (state) => {
  const { data, view = {} } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const runs = data.runs.runs;
  const shown = filterRuns(runs, view);
  const counts = { all: runs.length, pass: runs.filter(passed).length, not: runs.filter(notPassing).length };
  const missing = view.run && !runs.some((r) => r.run === view.run);
  const selected = runs.find((r) => r.run === view.run) ?? shown[0];
  const seg = [["all", "All"], ["pass", "Passed"], ["not", "Not passing"]].map(([id, label]) => `<button type="button" data-outcome="${id}" aria-pressed="${(view.outcome ?? "all") === id ? "true" : "false"}">${label} ${num(counts[id])}</button>`).join("");
  const tiers = ["edit", "commit", "boundary"].map((t) => `<option value="${t}"${view.tier === t ? " selected" : ""}>${t}</option>`).join("");
  const label = { all: "All runs", pass: "Passed", not: "Not passing" }[view.outcome ?? "all"];
  const cols = ["timeLink", "trigger", "tier", "outcome", "bar", "ms", "next"];
  return `${header(`Runs · ${esc(data.runs.project)}`, `${plural(runs.length, "recent run")} · ${num(counts.not)} not passing`, projectPicker(state, "rn-proj"))}
${missing ? missingRun(data.runs.project, view.run, runs.length) : ""}
<div class="filters"><div class="seg" role="group" aria-label="Outcome">${seg}</div><label><span class="lbl">Tier</span><select id="rn-tier" data-action="tier"><option value="">Every tier</option>${tiers}</select></label><label><span class="lbl">File</span><input id="rn-file" type="search" data-action="file" placeholder="Filter by changed file" value="${esc(view.file ?? "")}"></label></div>
<div class="split"><section class="mod wide" aria-labelledby="rn-list"><div class="modh"><h2 class="h2" id="rn-list">${label} · newest first</h2><span class="muted">Bars share one scale, 0 to 3 s</span></div>
<div class="scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Trigger</th><th scope="col">Tier</th><th scope="col">Outcome</th><th scope="col">Duration</th><th scope="col" class="r">ms</th><th scope="col">Next action</th></tr></thead>
<tbody>${shown.length === 0 ? '<tr><td colspan="7" class="muted">No run matches these filters.</td></tr>' : shown.map((r) => runRow({ ...r, project: data.runs.project }, cols, { selected: selected?.run, fresh: view.fresh })).join("")}</tbody></table></div></section>
${selected ? runDetail(data.runs.project, selected) : ""}</div>`;
};

export const streakOf = (runs, run) => {
  const i = runs.findIndex((r) => r.run === run.run);
  const same = (r) => r.outcome === run.outcome && r.result === run.result && r.alert === run.alert && r.next === run.next;
  const out = [];
  for (let j = i; j >= 0 && j < runs.length && same(runs[j]); j++) out.push(runs[j]);
  return out;
};

const banner = (run) => {
  if (!notPassing(run)) return "";
  const o = outcome(run);
  const step = stoppedAt(run);
  const name = OUTCOME_TITLE[run.outcome] ?? run.outcome;
  const title = run.alert !== undefined ? "Blocked by an open tamper alert" : run.outcome === "ran" ? `Blocked by ${plural(run.failures?.length ?? 0, "failure")}` : step ? `${name} at ${step.label}` : `${name} before the first step`;
  const why = run.alert !== undefined ? `The rules passed, but the daemon holds an open tamper alert for this repository (${run.alert}), so the check exited ${run.exit ?? 1}.` : run.outcome === "ran" ? "The rules ran and found new violations in the changed files." : step ? `Warden stopped at step ${STEPS.indexOf(step) + 1} of 4, so no rule ran.` : "Warden stopped before its first step, so no rule ran.";
  return `<section class="banner ${run.outcome === "tampered" ? "red" : "amber"}" aria-labelledby="er-h"><div class="top">${tag(o)}<h2 id="er-h">${esc(title)}</h2></div><p>${esc(why)}</p>${run.next ? nextBox(run.next) : ""}</section>`;
};

const missingRun = (project, id, count) => `<section class="mod pad" role="status">Run <span class="mono">${esc(id)}</span> is not among the last ${plural(count, "run")} of ${esc(project)}, so this page cannot show it. <a href="${href("runs", { project })}">Open the run list</a></section>`;

export const runPage = (state) => {
  const { data } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const project = data.runs.project;
  const runs = data.runs.runs;
  const wanted = state.view?.run;
  if (wanted && !runs.some((r) => r.run === wanted)) return `${header(`Runs · ${esc(project)}`, "Run not found")}${missingRun(project, wanted, runs.length)}`;
  const run = runs.find((r) => r.run === wanted) ?? runs[0];
  if (run === undefined) return `${header(`Runs · ${esc(project)}`, "No runs yet")}<section class="mod pad muted">No check has run in ${esc(project)} yet.</section>`;
  const streak = streakOf(runs, run);
  const reached = STEPS.filter((s) => run.steps?.[s.id] !== undefined).length;
  const facts = [["Run", `<span class="mono">${esc(run.run)}</span>`], ["Commit", esc(run.commit?.slice(0, 12) ?? "–")], ["Base", esc(run.base ?? "–")], ["Merge base", esc(run.mergeBase?.slice(0, 12) ?? "–")], ["Rules", run.guardrails === undefined ? "–" : `${num(run.guardrails)}, ${num(run.cachedRules?.length ?? 0)} cached`], ["Ratchet", run.ratchet ? `${num(run.ratchet[0])} → ${num(run.ratchet[1])}` : "–"]];
  return `<header class="head"><div><a href="${href("runs", { project })}" style="font-size:12px;font-weight:600">Runs · ${esc(project)}</a><h1 class="h1">${esc(tierTitle(run))}</h1><div class="muted">${esc(runSub(run))}</div></div><div class="controls"><button class="btn" type="button" data-copy="${esc(run.run)}">Copy run id</button></div></header>
${banner(run)}
<div class="split"><section class="mod wide" aria-labelledby="er-steps"><div class="modh"><h2 class="h2" id="er-steps">Steps</h2><span class="muted">${notPassing(run) && run.outcome !== "ran" ? (reached === 0 ? "stopped before step 1" : `stopped at step ${reached} of 4`) : `${reached} of 4 steps ran`}</span></div>${stepsList(run)}${failuresTable(run)}</section>
<section class="mod narrow" aria-labelledby="er-run"><div class="modh"><h2 class="h2" id="er-run">Run</h2>${tag(outcome(run))}</div><dl class="facts">${facts.map(([k, v]) => `<dt class="lbl">${k}</dt><dd>${v}</dd>`).join("")}</dl></section></div>
${streak.length > 1 ? `<section class="mod" aria-labelledby="er-streak"><div class="modh"><h2 class="h2" id="er-streak">Same outcome, ${num(streak.length)} runs in a row</h2><span class="muted">since ${esc(clock(streak.at(-1).at))}${run.next ? " · each gave the same next action" : ""}</span></div><div class="scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Trigger</th><th scope="col">Tier</th><th scope="col" class="r">ms</th></tr></thead><tbody>${streak.map((r) => `<tr${r.run === run.run ? ' class="sel" aria-current="true"' : ""}><td><a href="${href("run", { project, run: r.run })}">${esc(clock(r.at))}</a></td><td>${esc(trigger(r))}</td><td>${esc(r.tier ?? "–")}</td><td class="r">${ms(r.ms)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
};

export const weakest = (practices) => [...practices].sort((a, b) => (KIND_RANK[b.strongestKind] ?? 9) - (KIND_RANK[a.strongestKind] ?? 9))[0];

export const layersPage = (state) => {
  const { data } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const l = data.layers;
  const w = weakest(l.practices);
  const verdict = w === undefined || DETERMINISTIC.has(w.strongestKind) ? "None. Every practice is held by a deterministic rule." : `${esc(w.practice)}, held only by ${esc(w.strongestKind)}. Add a type, lint, or runtime Guardrail to ${esc(w.practice)}.`;
  const marks = { deterministic: '<span class="band det" aria-hidden="true"></span>', judgment: '<span class="band jud" aria-hidden="true"></span>', prose: '<span class="band pro" aria-hidden="true"></span>' };
  const bands = l.bands
    .map((b) => {
      const count = b.kinds.reduce((n, k) => n + k.rules.length, 0);
      const rows = b.kinds
        .map(
          (k) =>
            `<tr class="kind"><td>${KIND_RANK[k.kind] ?? ""}</td><td>${esc(k.kind)}</td><td colspan="6" class="note">${esc(KIND_TEXT[k.kind] ?? "")} · ${k.rules.length === 0 ? "none yet" : plural(k.rules.length, "rule")}</td></tr>${k.rules
              .map((r) => `<tr class="sub"><td></td><td class="mono" style="padding-left:30px">${esc(r.guardrail)}</td><td>${esc(r.pack)}</td><td>${esc(r.practice)}</td><td>${esc(r.adapter)}</td><td>${esc(r.runs.join(", "))}</td><td class="r">${esc(r.median)}</td><td>${r.promote ? tag({ cls: "err", text: "Promote" }) : ""}</td></tr>`)
              .join("")}`,
        )
        .join("");
      const name = esc(b.band.replace(/^./, (c) => c.toUpperCase()));
      const id = esc(b.band);
      return `<section class="mod" aria-labelledby="ly-${id}"><div class="modh"><div style="flex-direction:row;align-items:center;gap:10px">${marks[b.band] ?? ""}<h2 class="h2" id="ly-${id}">${name}</h2><span class="muted">${esc(BAND_TEXT[b.band] ?? "")}</span></div><span class="muted">${plural(count, "rule")}</span></div><div class="scroll"><table>${count === 0 ? "" : '<thead><tr><th scope="col">Rank</th><th scope="col">Kind or Guardrail</th><th scope="col">Pack</th><th scope="col">Practice</th><th scope="col">Adapter</th><th scope="col">Runs at</th><th scope="col" class="r">Median</th><th scope="col"><span class="lbl">Weak</span></th></tr></thead>'}<tbody>${rows}</tbody></table></div></section>`;
    })
    .join("");
  const rulesOf = (id) => l.bands.flatMap((b) => b.kinds.flatMap((k) => k.rules.filter((r) => r.pack === id)));
  const packs = l.packs
    .map((p) => {
      const rules = rulesOf(p.id);
      const kinds = Object.entries(rules.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`);
      const practices = [...new Set(rules.map((r) => r.practice))];
      return `<tr><td style="font-weight:650">${esc(p.id)}</td><td>${esc(p.source)}</td><td>${p.on ? '<span class="on"><i aria-hidden="true"></i>On</span>' : '<span class="muted">Off</span>'}</td><td class="r">${num(p.rules)}</td><td>${p.on ? esc(kinds.join(", ") || "–") : "–"}</td><td class="wrap">${p.on ? esc(practices.join(", ") || "–") : '<span class="muted">turn the pack on to list its practices</span>'}</td></tr>`;
    })
    .join("");
  return `${header(`Layers · ${esc(l.project)}`, "Strongest first. A rule can only move up.", projectPicker(state, "ly-proj"))}
<div class="next"><span class="lbl">Weakest practice</span><span style="flex:1 1 320px;font-size:14px">${verdict}</span></div>
${bands}
<section class="mod" aria-labelledby="ly-packs"><div class="modh"><h2 class="h2" id="ly-packs">Packs</h2><span class="muted">Bundled with Warden${state.health?.version ? ` ${esc(state.health.version)}` : ""}, plus any local pack in .warden</span></div><div class="scroll"><table><thead><tr><th scope="col">Pack</th><th scope="col">Source</th><th scope="col">In this project</th><th scope="col" class="r">Rules</th><th scope="col">Strength</th><th scope="col">Practices</th></tr></thead><tbody>${packs}</tbody></table></div></section>`;
};

export const violationsPage = (state) => {
  const { data } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const v = data.violations;
  const last = v.packs.map((p) => p.lastRun).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0];
  const ratchetRun = data.runs.runs.find((r) => r.ratchet !== undefined);
  const counted = v.packs.filter((p) => p.new !== null);
  const fresh = counted.reduce((n, p) => n + p.new, 0);
  const baselined = v.packs.reduce((n, p) => n + p.baselined, 0);
  const max = Math.max(1, ...v.packs.map((p) => p.baselined + (p.new ?? 0)));
  const barOf = (old, neu) => `<div class="bar" role="img" aria-label="${esc(`${num(old)} baselined, ${neu === null ? "not counted" : `${num(neu)} new`}`)}"><span class="old" style="width:${((old / max) * 100).toFixed(2)}%${old > 0 ? ";min-width:2px" : ""}"></span><span class="new" style="width:${(((neu ?? 0) / max) * 100).toFixed(2)}%${neu > 0 ? ";min-width:2px" : ""}"></span></div>`;
  const rows = v.packs
    .map(
      (p) =>
        `<tr><td style="font-weight:700">${esc(p.pack)}</td><td>${barOf(p.baselined, p.new)}</td><td class="r" style="font-weight:700">${num(p.baselined)}</td><td class="r">${p.new === null ? "not counted yet" : num(p.new)}</td><td>${p.lastRun ? `${esc(short(p.lastRun.at))} ${esc(TRIGGERS[p.lastRun.trigger] ?? p.lastRun.trigger ?? "")}` : "no run yet"}</td></tr>${p.guardrails
          .map((g) => `<tr class="sub"><td class="mono" style="padding-left:28px">${esc(g.guardrail)}</td><td>${barOf(g.baselined, g.new)}</td><td class="r">${num(g.baselined)}</td><td class="r">${g.new === null ? "–" : num(g.new)}</td><td></td></tr>`)
          .join("")}`,
    )
    .join("");
  const off = (data.layers?.packs ?? []).filter((p) => !p.on).map((p) => `<tr><td class="muted" style="font-weight:700">${esc(p.id)}</td><td class="muted">Off in this project · ${plural(p.rules, "rule")}</td><td class="r muted">–</td><td class="r muted">–</td><td></td></tr>`).join("");
  return `${header(`Violations · ${esc(v.project)}`, last ? `Counted at the last run that reached rules: ${esc(clock(last.at))}, ${esc(TRIGGERS[last.trigger] ?? last.trigger ?? "")}` : "No run has reached rules yet", projectPicker(state, "vi-proj"))}
<div class="mod summary"><span><span class="lbl">Ratchet</span> <strong>${ratchetRun ? `${num(ratchetRun.ratchet[0])} → ${num(ratchetRun.ratchet[1])}` : "–"}</strong> <span class="muted">at the last run; it may only go down</span></span><span><span class="lbl">New</span> <strong>${counted.length === 0 ? "–" : num(fresh)}</strong> <span class="muted">${counted.length === 0 ? "not counted yet" : fresh === 0 ? "nothing is blocking" : "blocking until fixed"}</span></span><span><span class="lbl">Baselined</span> <strong>${num(baselined)}</strong> <span class="muted">in .warden/baseline.json</span></span></div>
<section class="mod" aria-labelledby="vi-packs"><div class="modh"><h2 class="h2" id="vi-packs">Violations by pack</h2><div class="legend"><span><i class="sw old" aria-hidden="true"></i>baselined, allowed until touched</span><span><i class="sw new" aria-hidden="true"></i>new in the last run, blocking</span></div></div>
<div class="scroll"><table><thead><tr><th scope="col" style="width:260px">Pack or Guardrail</th><th scope="col">Share of the largest pack</th><th scope="col" class="r">Baselined</th><th scope="col" class="r">New</th><th scope="col">Last run</th></tr></thead><tbody>${rows}${off}</tbody></table></div></section>`;
};

export const share = (c) => {
  const known = c.deterministic + c.judgment + c.prose;
  if (known === 0) return "–";
  return `${Math.min(Math.round((c.deterministic / known) * 100), c.deterministic === known ? 100 : 99)}%`;
};

export const determinismPage = (state) => {
  const { data } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const rows = data.determinism.projects
    .map((p) => {
      const c = p.counts;
      if (c === null) return `<tr><td style="font-weight:700">${esc(p.project)}</td><td colspan="5" class="muted">No run has reached rules yet</td></tr>`;
      const total = c.deterministic + c.judgment + c.prose + c.unknown;
      if (total === 0) return `<tr><td style="font-weight:700">${esc(p.project)}<div class="muted" style="font-weight:400">run at ${esc(clock(p.at))}</div></td><td colspan="4" class="muted">No rule failed at that run</td><td class="r">–</td></tr>`;
      const seg = (cls, n) => (n > 0 ? `<span class="${cls}" style="width:${((n / total) * 100).toFixed(2)}%"></span>` : "");
      return `<tr><td style="font-weight:700">${esc(p.project)}<div class="muted" style="font-weight:400">run at ${esc(clock(p.at))}</div></td><td><div class="sbar" role="img" aria-label="${esc(`${c.deterministic} deterministic, ${c.judgment} judgment, ${c.prose} prose${c.unknown ? `, ${c.unknown} unknown` : ""}`)}">${seg("det", c.deterministic)}${seg("jud", c.judgment)}${seg("pro", c.prose)}${seg("unk", c.unknown)}</div></td><td class="r">${num(c.deterministic)}</td><td class="r">${num(c.judgment)}</td><td class="r">${num(c.prose)}</td><td class="r" style="font-weight:750;font-size:15px">${share(c)}</td></tr>`;
    })
    .join("");
  const unknown = data.determinism.projects.some((p) => (p.counts?.unknown ?? 0) > 0);
  const stops = data.projects
    .map((p) => {
      const runs = data.runs[p.project] ?? [];
      const count = (o) => runs.filter((r) => r.outcome === o).length;
      const recent = runs.find((r) => ["tampered", "error", "unstaged", "refused"].includes(r.outcome));
      return `<tr><td style="font-weight:700">${esc(p.project)}</td><td class="r">${num(count("tampered"))}</td><td class="r">${num(count("refused"))}</td><td class="r">${num(count("error"))}</td><td class="r">${num(count("unstaged"))}</td><td class="wrap" style="min-width:260px">${recent ? `<a href="${href("run", { project: p.project, run: recent.run })}">${esc(clock(recent.at))}</a> · ${esc(outcome(recent).text)}${recent.next ? ` · <span class="mono">${esc(recent.next)}</span>` : ""}` : '<span class="muted">none</span>'}</td></tr>`;
    })
    .join("");
  const depth = Math.max(0, ...data.projects.map((p) => (data.runs[p.project] ?? []).length));
  return `${header("Determinism", "Which strength of rule caught each failure, at each project's last run that reached rules. A deterministic catch is proof; a prose catch is a promise.")}
<section class="mod" aria-labelledby="dt-proj"><div class="modh"><h2 class="h2" id="dt-proj">Rule failures by strength</h2><div class="legend"><span><i class="sw det" aria-hidden="true"></i>deterministic: type, lint, runtime</span><span><i class="sw jud" aria-hidden="true"></i>judgment: model, review</span><span><i class="sw pro" aria-hidden="true"></i>prose: instruction, legacy</span>${unknown ? '<span><i class="sw unk" aria-hidden="true"></i>unknown: recorded before kinds were kept</span>' : ""}</div></div>
<div class="scroll"><table><thead><tr><th scope="col" style="width:200px">Project</th><th scope="col">Failures</th><th scope="col" class="r">Deterministic</th><th scope="col" class="r">Judgment</th><th scope="col" class="r">Prose</th><th scope="col" class="r">Deterministic share</th></tr></thead><tbody>${rows}</tbody></table></div></section>
<section class="mod" aria-labelledby="dt-stops"><div class="modh"><h2 class="h2" id="dt-stops">Stops before any rule ran</h2><span class="muted">Not counted above: Warden itself refused the run · last ${plural(depth, "run")} per project</span></div>
<div class="scroll"><table><thead><tr><th scope="col" style="width:200px">Project</th><th scope="col" class="r">Tampered</th><th scope="col" class="r">Refused</th><th scope="col" class="r">Error</th><th scope="col" class="r">Unstaged</th><th scope="col">Most recent</th></tr></thead><tbody>${stops}</tbody></table></div></section>`;
};

const LOCK_ART = `<svg class="lockart" viewBox="0 0 122 34" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Illustration only: a key that no longer fits its lock"><rect x="1" y="4" width="26" height="24" rx="7" fill="#E1E5EA" stroke="#1C2A3F" stroke-width="0.5"/><circle cx="10" cy="16" r="3.5" fill="#F8F9FA" stroke="#1C2A3F" stroke-width="0.5"/><path d="M27 10 L112 10 L118 16.5 L112 23 L104 23 L100.5 12.75 L95.5 12.75 L88.5 24 L83.5 24 L76.5 16.5 L71.5 16.5 L64.5 14 L59.5 14 L52.5 21.5 L47.5 21.5 L40.5 21.5 L35.5 21.5 L32 24 L27 24 Z" fill="#B3261E" fill-opacity="0.22" stroke="#B3261E" stroke-width="0.5" stroke-dasharray="1.2 0.8"/><path d="M27 10 L112 10 L118 16.5 L112 23 L104 23 L100.5 20.25 L95.5 20.25 L88.5 24 L83.5 24 L76.5 24 L71.5 24 L64.5 14 L59.5 14 L52.5 21.5 L47.5 21.5 L40.5 21.5 L35.5 21.5 L32 24 L27 24 Z" fill="none" stroke="#1C2A3F" stroke-width="0.6"/><path d="M74 16.5 L74 24 M98 12.75 L98 20.25" stroke="#B3261E" stroke-width="1.1"/></svg>`;

const isOpen = (open, e) => open.some((d) => d.project === e.project && d.file === e.file && d.detail === e.detail);

export const tamperPage = (state) => {
  const { data } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const { open, recent } = data.tamper;
  const projects = [...new Set(open.map((d) => d.project))];
  const kinds = [...new Set(open.map((d) => d.detail.split(" ")[0]))];
  const history = `<section class="mod" aria-labelledby="tp-hist"><div class="modh"><h2 class="h2" id="tp-hist">Tamper records</h2><span class="muted">${plural(recent.length, "record")}, newest first, from checks and the daemon</span></div><div class="scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Project</th><th scope="col">Found by</th><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Next action Warden gave</th><th scope="col">Now</th></tr></thead><tbody>${
    recent.length === 0
      ? '<tr><td colspan="7" class="muted">No tamper has been recorded.</td></tr>'
      : recent.map((e) => `<tr><td>${esc(clock(e.at))}</td><td>${esc(e.project)}</td><td>${esc(TRIGGERS[e.trigger] ?? "a check")}</td><td class="mono">${esc(e.file ?? "–")}</td><td class="mono">${esc(e.detail ?? "–")}</td><td class="mono clip" title="${esc(e.next ?? "")}">${esc(e.next ?? "–")}</td><td>${isOpen(open, e) ? tag({ cls: "block", text: "Open" }) : tag({ cls: "pass", text: "Not open now" })}</td></tr>`).join("")
  }</tbody></table></div></section>`;
  if (open.length === 0) return `${header("Tamper", "The daemon compares each project's hooks, plugin, and records with its lock")}<section class="mod"><div class="alert">${tag({ cls: "pass", text: "Clear" })}<div>No open tamper detections in any watched project.</div></div></section>${history}`;
  const first = open[0];
  return `<section class="banner red" role="alert" aria-labelledby="tp-h"><div class="top" style="justify-content:space-between"><div style="display:flex;flex-direction:column;gap:4px;min-width:0"><h1 id="tp-h">Tamper detected in ${esc(projects.join(" and "))}</h1><p>${plural(open.length, "open detection")}. The first: ${esc(first.detail)} on ${esc(first.file)}. ${esc(DETAIL_TEXT[first.detail.split(" ")[0]] ?? "")}</p></div></div>${nextBox(first.next)}</section>
<div class="split">${kinds.some((k) => LOCK_KINDS.has(k)) ? `<section class="mod wide" aria-labelledby="tp-key"><div class="modh"><h2 class="h2" id="tp-key">The key no longer fits</h2><span class="muted">illustration; the files that changed are listed below</span></div><div class="pad">${LOCK_ART}</div></section>` : ""}
<section class="mod narrow" aria-labelledby="tp-kinds"><div class="modh"><h2 class="h2" id="tp-kinds">What was found</h2></div><dl class="kinds">${kinds.map((k) => `<dt class="mono">${esc(k)}</dt><dd>${esc(DETAIL_TEXT[k] ?? "Reported by the daemon.")}</dd>`).join("")}</dl></section></div>
<section class="mod" aria-labelledby="tp-open"><div class="modh"><h2 class="h2" id="tp-open">Open now · ${plural(open.length, "detection")}</h2><span class="muted">Each clears when the daemon's next scan no longer finds it</span></div><div class="scroll"><table><thead><tr><th scope="col">Project</th><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Next action</th></tr></thead><tbody>${open.map((d) => `<tr class="held"><td>${esc(d.project)}${d.repo ? `<div class="muted mono" title="${esc(d.repo)}">…/${esc(d.repo.replace(/\/\.git$/, "").split("/").slice(-2).join("/"))}</div>` : ""}</td><td class="mono">${esc(d.file)}</td><td class="mono">${esc(d.detail)}</td><td class="mono wrap">${esc(d.next)}</td></tr>`).join("")}</tbody></table></div></section>
${history}`;
};

const RENDER = { overview: overviewPage, runs: runsPage, run: runPage, layers: layersPage, violations: violationsPage, determinism: determinismPage, tamper: tamperPage };

export const pageTitle = (state) => `${state.page === "run" ? "Run" : (PAGES[state.page] ?? "Warden")} · Warden`;

export const mainHtml = (state) => {
  if (state.error) return apiError(state.error);
  if (!state.data) return '<p class="muted">Loading…</p>';
  return (RENDER[state.page] ?? overviewPage)(state);
};

export const renderApp = (state) => {
  const body = state.lost ? `${lostBanner(state)}<div class="frozen" inert style="display:flex;flex-direction:column;gap:16px">${state.frozen ?? ""}</div>` : mainHtml(state);
  return `<div class="shell">${sidebar(state)}<main class="main" id="main">${body}</main></div>`;
};
