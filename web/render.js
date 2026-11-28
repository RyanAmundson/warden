export const PAGES = { overview: "Overview", configuration: "Configuration", projects: "Projects", project: "Project", about: "About", "pack-catalog": "Pack catalog", runs: "Runs", failures: "Current failures", packs: "Packs", "rule-strength": "Rule strength", violations: "Violations", determinism: "Determinism", tamper: "Tamper" };

const CHECKOUT_PAGES = new Set(["rule-strength", "violations"]);
const PROJECT_PAGES = new Set(["project", "runs", "run", "failures", "packs", ...CHECKOUT_PAGES]);
export const checkoutPageUnavailable = (page, project) => project?.auditOnly && CHECKOUT_PAGES.has(page);

export const STEPS = [
  { id: "rules-intact", label: "rules intact", color: "#24364F" },
  { id: "tools-ready", label: "tools ready", color: "#5C7594" },
  { id: "rules", label: "rules", color: "#B8892B" },
  { id: "verdict", label: "verdict", color: "#7A5A1A" },
];

const REST = "#C3CAD3";

const SCALE_MS = 3000;

const TRIGGERS = { "agent-edit": "agent edit", "git-commit": "git commit", manual: "manual run", audit: "manual audit", "main audit": "main branch update", daemon: "daemon" };

const KIND_TEXT = { type: "compiler proves it", lint: "static analysis on every edit", runtime: "a command or test must pass", model: "a model decides", review: "a reviewer decides", instruction: "documented expectation", legacy: "wrapped old check" };

const KIND_RANK = { type: 0, lint: 0, runtime: 1, model: 2, review: 3, instruction: 4, legacy: 5 };

const DETERMINISTIC = new Set(["type", "lint", "runtime"]);

const BAND_TEXT = { deterministic: "Automated checks with repeatable results", judgment: "A model or reviewer evaluates the rule", prose: "Instructions and legacy checks" };

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
  "hook-unwired": "Git must invoke Warden’s generated pre-commit hook through the configured Git hooks path.",
  "plugin-missing": "The Warden Claude plugin was enabled here before and is no longer installed.",
  "plugin-disabled": "The Warden Claude plugin was enabled here before and is now turned off.",
  "gate-off": "A commit check ran with WARDEN_DAEMON=off, so it skipped the daemon gate.",
  "unchecked-commit": "A commit landed without a passing commit check for its tree.",
  "untrusted-trust": "A trust entry for a commit is not signed by the owner's trust key.",
  "record-error": "A record no longer loads.",
  removed: ".warden/config.yaml was removed.",
};

const alertLabel = (detail) => detail === "hook-unwired" ? "Git pre-commit hook is not wired to Warden" : detail;

const OUTCOME_TITLE = { error: "Error", tampered: "Tampered", unstaged: "Unstaged changes", refused: "Refused" };

const UNWIRED = new Set(["hook-unwired", "hooks-disabled", "plugin-missing", "plugin-disabled", "gate-off", "removed"]);

const UNWIRED_EFFECT = {
  "hook-unwired": "Commits land without a Warden check.",
  "hooks-disabled": "Claude Code runs no hooks here, so agent edits get no Warden check.",
  "plugin-missing": "Agent edits in Claude Code get no Warden check. Commit checks still run.",
  "plugin-disabled": "Agent edits in Claude Code get no Warden check. Commit checks still run.",
  "gate-off": "That commit check ran without the daemon's alert gate.",
  removed: "Warden has no config here, so it checks nothing.",
};

const MODE = {
  audit: ["Audit mode", "Warden records failures and never blocks edits or commits."],
  enforce: ["Enforcing", "Failures block agent edits and commits."],
};

const LOCK_KINDS = new Set(["source-drift", "generated-drift", "lock-drift", "loosened", "weakened-kind", "base-moved", "missing-lock", "leftover-temp"]);

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const clock = (at) => (at ? new Date(at).toTimeString().slice(0, 8) : "–");

const short = (at) => clock(at).slice(0, 5);

const num = (n) => (n === null || n === undefined ? "–" : Number(n).toLocaleString("en-US"));

const ms = (n) => (n === undefined || n === null ? "–" : Math.round(n).toLocaleString("en-US"));

const elapsed = (n) => n == null ? "–" : n > 0 && n < 1 ? "<1 ms" : `${ms(n)} ms`;

const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

const trigger = (run) => TRIGGERS[run.trigger] ?? run.trigger ?? "–";

const target = (run) => run.file ?? (run.files == null ? "–" : plural(run.files, "file"));

const isAudit = (run) => ["audit", "main audit", "continuous audit"].includes(run.trigger);

const unwired = (run) => UNWIRED.has(run.alert);

const auditMode = (run) => run.mode === "audit";

const runMode = (run) => isAudit(run) ? "Advisory audit run. It never blocks." : auditMode(run) ? "Audit mode. Warden recorded this run and did not block." : "Enforcing. Failures block.";

const checkout = (run) => run.root ?? run.attemptedRoot;

const pathTail = (path) => path.split("/").slice(-2).join("/");

const shortRef = (ref) => ref?.replace(/^refs\/(heads|remotes)\//, "");

const mainAuditRuns = (project) => {
  if (project.mainAuditRuns?.length) return project.mainAuditRuns;
  const audit = project.lastMainAudit ?? (project.lastRun?.trigger === "main audit" ? project.lastRun : undefined);
  return audit ? [audit] : [];
};

const auditRefLabel = (audit) => esc(shortRef(audit.ref) ?? "main");

const stepOf = (id) => STEPS.find((s) => s.id === id);

const href = (page, params = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  return esc(`/${page === "overview" ? "" : page}${query === "" ? "" : `?${query}`}`);
};

const ICON_X = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';

const ICON_DONE = '<svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="passed"><path d="M3 7.5 L6 10.5 L11 4" stroke="#1F5E39" stroke-width="1.8" fill="none"/></svg>';

const ICON_FAIL = '<svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="failed"><path d="M3.5 3.5 L10.5 10.5 M10.5 3.5 L3.5 10.5" stroke="#8E1B14" stroke-width="1.8" fill="none"/></svg>';

const ICON_SKIP = '<svg width="14" height="14" viewBox="0 0 14 14" role="img" aria-label="not run"><circle cx="7" cy="7" r="4.5" stroke="#9AA3AE" stroke-width="1.4" fill="none"/></svg>';

const BRAND = '<svg width="34" height="14" viewBox="0 4 120 24" aria-hidden="true"><rect x="1" y="4" width="26" height="24" rx="7" fill="#C9A04A"/><circle cx="10" cy="16" r="3.5" fill="#1C2A3F"/><path d="M27 10 L112 10 L118 16.5 L112 23 L104 23 L100.5 20.25 L95.5 20.25 L88.5 24 L71.5 24 L64.5 14 L59.5 14 L52.5 21.5 L35.5 21.5 L32 24 L27 24 Z" fill="#C9A04A"/></svg>';

export const passed = (run) => run.outcome === "ran" && run.result === "pass" && run.alert === undefined;

export const notPassing = (run) => !passed(run) && run.outcome !== "empty";

export const stoppedAt = (run) => {
  const reached = STEPS.filter((s) => run.steps?.[s.id] !== undefined);
  return reached.at(-1);
};

export const outcome = (run) => {
  if (run.outcome === "refused" || (run.outcome === "ran" && isAudit(run) && run.alert !== undefined)) return { cls: "err", text: "Refused", icon: true };
  if (run.outcome === "ran" && run.alert !== undefined) {
    if (auditMode(run)) return { cls: "err", text: `${unwired(run) ? "Warden unwired" : "Tamper alert"} · not blocked`, icon: true };
    return unwired(run) ? { cls: "tamper", text: "Warden unwired", icon: true } : { cls: "block", text: "Blocked by alert", icon: true };
  }
  if (run.outcome === "ran" && run.result === "pass") return { cls: "pass", text: "Pass" };
  if (run.outcome === "ran" && run.result === "fail") {
    if (auditMode(run)) return { cls: "err", text: "Failed · not blocked", icon: true };
    if (!isAudit(run)) return { cls: "block", text: "Blocked", icon: true };
    if (run.exit === 0) return { cls: "err", text: "Advisory findings" };
    return { cls: "err", text: "Incomplete audit", icon: true };
  }
  if (run.outcome === "ran") return { cls: "idle", text: "No result recorded" };
  if (run.outcome === "empty") return { cls: "idle", text: "No changes" };
  if (run.outcome === "tampered") return { cls: "tamper", text: "Tampered", icon: true };
  if (run.outcome === "unstaged") return { cls: "err", text: "Unstaged", icon: true };
  if (run.outcome === "error") return { cls: "err", text: stoppedAt(run) ? `Error · ${stoppedAt(run).label}` : "Error", icon: true };
  return { cls: "idle", text: run.outcome ?? "Unknown" };
};

const tag = ({ cls, text, icon }) => `<span class="tag ${cls}">${icon ? ICON_X : ""}${esc(text)}</span>`;

let quiet = false;

const nextBox = (text) => quiet ? "" : `<div class="next"><span class="lbl">Next action</span><code>${esc(text)}</code><button class="btnr" type="button" data-copy="${esc(text)}">Copy</button></div>`;

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
  if (p.unwired?.length > 0) return { cls: "tamper", text: "Warden unwired", icon: true };
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
  const nav = ["overview", "configuration", "pack-catalog", "about"].map((id) =>
    `<li><a href="${href(id)}"${id === page || id === "overview" && page === "projects" ? ' aria-current="page"' : ""}>${PAGES[id]}</a></li>`).join("");
  const watched = projects.map((p) =>
    `<li><a href="${href("project", { project: p.project })}"${PROJECT_PAGES.has(page) && p.project === project ? ' aria-current="page"' : ""}><span class="project-name">${esc(p.project)}</span></a></li>`).join("");
  return `<nav class="side" aria-label="Warden">
<div class="brand">${BRAND}<span>WARDEN</span></div>
<div class="daemon${lost ? " lost" : ""}"><b><i aria-hidden="true"></i>${lost ? "Daemon not answering" : "Daemon live"}</b><span id="beat">${esc(beatText(health, now))}</span></div>
<div class="navs">
<ul class="nav" aria-label="Dashboard">${nav}</ul>
<div><div class="lbl">Projects</div><ul class="nav project-nav" aria-label="Projects">${watched || '<li class="empty-item">None yet</li>'}</ul></div></div>
<div class="foot">Warden ${esc(health?.version ?? "")} · evidence in ${esc(homeOf(health?.heartbeatFile))}</div>
</nav>`;
};

const header = (title, sub, controls = "") => `<header class="head"><div><h1 class="h1">${title}</h1><div class="muted">${sub}</div></div>${controls === "" ? "" : `<div class="controls">${controls}</div>`}</header>`;

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
<p>No heartbeat since ${esc(clock(state.health?.heartbeatAt))}, so this page stopped updating at ${esc(clock(state.frozenAt))}. Commit checks refuse to run until the daemon is back; edit checks still run and still write evidence. ${state.streamClosed ? "The event stream closed, so the page no longer reconnects on its own." : `Reconnecting every ${retry} seconds.`}</p>
<div><button class="btn" type="button" data-action="reconnect">Reconnect now</button></div></div>
${nextBox("run warden daemon install")}
</section>`;
};

export const apiError = (err) => `<section class="banner amber" role="alert" aria-labelledby="ae-h">
<div class="top">${tag({ cls: "err", text: `Error ${err.status ?? ""}`.trim(), icon: true })}<h2 id="ae-h">The daemon could not load this page</h2></div>
<p class="mono">${esc(err.error)}</p>
${nextBox(err.next)}
</section>`;

export const unwiredBanner = (p) => {
  const first = p?.unwired?.[0];
  if (first === undefined) return "";
  const id = `uw-${p.project.replace(/[^a-z0-9]/gi, "-")}`;
  const effect = `${UNWIRED_EFFECT[first.detail] ?? ""} ${p.mode === "audit" ? "In audit mode, this alert does not block work." : "While this alert is open, Warden refuses checks that would otherwise pass."}`;
  return `<section class="banner red unwired" role="alert" aria-labelledby="${id}"><div class="top">${tag({ cls: "tamper", text: "Warden unwired", icon: true })}<h2 id="${id}">Warden is unwired in ${esc(p.project)}</h2></div><p>${esc(DETAIL_TEXT[first.detail] ?? first.detail)} ${esc(effect.trim())} This is a setup problem, not a rule failure.${p.openAlerts > p.unwired.length ? " Fix it first, then review the remaining open alerts on the Tamper page." : ""}</p>${nextBox(first.next)}</section>`;
};

const selectedProject = (state) => state.projects?.find((p) => p.project === state.project);

const slot = (html) => `<span class="slot">${html}</span>`;

const alertCards = (state) => {
  const { data, view = {} } = state;
  const cards = [];
  for (const alert of data.tamper.open) {
    cards.push({ project: alert.project, title: alertLabel(alert.detail), detail: DETAIL_TEXT[alert.detail] ?? alert.file, target: href("project", { project: alert.project, tab: "status" }) + "#project-alerts", action: "Open project alerts" });
  }
  for (const { project, lastRun: run } of data.projects) {
    if (!run || !notPassing(run)) continue;
    cards.push({ project, title: outcome(run).text, detail: `${trigger(run)} · ${clock(run.at)}`, target: href("run", { project, run: run.run }), action: "Open run" });
  }
  const index = Math.max(0, Math.min(view.alertIndex ?? 0, cards.length - 1));
  const card = cards[index];
  return `<section class="mod" aria-labelledby="ov-alerts" aria-roledescription="carousel"><div class="modh"><h2 class="h2" id="ov-alerts">Alerts</h2>
${cards.length > 1 ? `<div class="carousel-controls"><button id="alert-prev" class="btn" type="button" data-alert="previous" data-index="${(index - 1 + cards.length) % cards.length}" aria-label="Previous alert">Previous</button><span>${index + 1} of ${cards.length}</span><button id="alert-next" class="btn" type="button" data-alert="next" data-index="${(index + 1) % cards.length}" aria-label="Next alert">Next</button></div>` : ""}</div>
<div class="carousel-card" aria-live="polite">${card ? `<div><strong>${esc(card.project)}</strong><div>${esc(card.title)}</div><p class="muted">${esc(card.detail)}</p></div><a href="${card.target}">${card.action}</a>` : '<p class="muted">No open alerts.</p>'}</div></section>`;
};

const projectGallery = (projects) => `<ul class="project-gallery">${projects.map((p) =>
  `<li><a class="project-card" href="${href("project", { project: p.project })}"><strong>${esc(p.project)}</strong>${tag(projectStatus(p))}<span class="muted">${p.auditOnly ? `Published audit · ${auditRefLabel(p.auditOnly)}` : p.lastRun ? `Last run ${esc(clock(p.lastRun.at))}` : "Watching repository"}</span></a></li>`).join("")}</ul>`;

const projectsPage = ({ data }) => `${header("Projects", plural(data.projects.length, "project"))}${data.projects.length ? projectGallery(data.projects) : '<p class="muted">No projects are watched yet.</p>'}`;

const runRow = (run, cols, view) => {
  const root = checkout(run);
  const ref = shortRef(run.ref);
  const source = ref ?? (root && pathTail(root));
  const first = run.failures?.[0];
  const location = first?.file ? `${first.file}${first.line > 0 ? `:${first.line}` : ""}` : "";
  let next = `<td class="muted">${notPassing(run) ? "–" : "Nothing to do"}</td>`;
  if (quiet) next = '<td class="muted">–</td>';
  else if (run.next) next = `<td class="mono clip" title="${esc(run.next)}">${esc(run.next)}</td>`;
  const cells = {
    timeLink: `<td>${run.run ? `<a class="run-link" href="${href("run", { project: run.project, run: run.run })}" aria-label="${esc(`Open ${trigger(run)} run at ${clock(run.at)}`)}">${esc(clock(run.at))}</a>` : esc(clock(run.at))}</td>`,
    project: `<td style="font-weight:600">${esc(run.project)}</td>`,
    trigger: `<td>${esc(trigger(run))}${source ? `<div class="mono muted run-source" title="${esc(run.ref ?? root)}">${esc(source)}</div>` : ""}</td>`,
    tier: `<td>${esc(run.tier ?? "–")}</td>`,
    changed: `<td>${esc(target(run))}</td>`,
    outcome: `<td>${tag(outcome(run))}${location ? `<div class="mono muted run-location" title="${esc(location)}">${esc(location.split("/").at(-1))}</div>` : ""}</td>`,
    bar: `<td>${durationBar(run)}</td>`,
    ms: `<td class="r">${ms(run.ms)}</td>`,
    ratchet: `<td class="r">${run.ratchet ? num(run.ratchet[1]) : "–"}</td>`,
    next,
  };
  const cls = [notPassing(run) ? "held" : "", view?.fresh?.has(run.run) ? "arrived" : ""].filter(Boolean).join(" ");
  return `<tr${run.run ? " data-run-row" : ""}${cls === "" ? "" : ` class="${cls}"`}>${cols.map((c) => cells[c]).join("")}</tr>`;
};

export const overviewPage = (state) => {
  const { data, view = {} } = state;
  const all = data.projects.flatMap((p) => (data.runs?.[p.project] ?? []).map((r) => ({ ...r, project: p.project })));
  const stream = all.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  const now = new Date(state.loadedAt ?? state.now ?? Date.now());
  const auditOnlyCount = data.projects.filter((p) => p.auditOnly).length;
  const coverage = `${plural(data.projects.length - auditOnlyCount, "project")} watched${auditOnlyCount ? ` · ${plural(auditOnlyCount, "published audit")}` : ""}`;
  const controls = `<button class="btn" type="button" data-action="pause" aria-pressed="${view.paused ? "true" : "false"}">${view.paused ? "Resume live" : "Pause live"}</button>`;
  const cols = ["timeLink", "project", "trigger", "tier", "changed", "outcome", "bar", "ms", "ratchet"];
  return `${header("Overview", `${coverage} · updated ${esc(clock(now.toISOString()))} · ${esc(now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }))}${view.paused ? " · live updates paused" : ""}`, controls)}
${alertCards(state)}
<section aria-labelledby="ov-projects"><div class="overview-section"><h2 class="h2" id="ov-projects">Projects</h2><a href="/projects">See more</a></div>${data.projects.length ? projectGallery(data.projects.slice(0, 6)) : '<p class="muted">No projects are watched yet. <a href="/configuration">Add a project</a></p>'}</section>
<section class="mod" aria-labelledby="ov-stream"><div class="modh"><h2 class="h2" id="ov-stream">Recent runs</h2>${stepLegend()}</div>
<div class="scroll fit-table"><table class="recent-runs-table"><thead><tr><th scope="col">Time</th><th scope="col">Project</th><th scope="col">Trigger</th><th scope="col">Tier</th><th scope="col">Changed</th><th scope="col">Outcome</th><th scope="col">Duration</th><th scope="col" class="r">ms</th><th scope="col" class="r">Ratchet left</th></tr></thead>
<tbody>${stream.length === 0 ? '<tr><td colspan="9" class="muted">No check has run yet. Runs appear here as agents edit and commit.</td></tr>' : stream.map((r) => runRow({ ...r, project: r.project }, cols, { fresh: view.fresh })).join("")}</tbody></table></div></section>`;
};

const CHECK_ICON = { pass: ICON_DONE, fail: ICON_FAIL, skip: ICON_SKIP };

const ruleDetail = (details, id) => Object.hasOwn(details, id) ? details[id] : undefined;

const ruleName = (id, detail) => detail
  ? `<strong title="${esc(id)}">${esc(detail.name)}</strong>`
  : `<span class="mono">${esc(id)}</span>`;

const check = (state, label, note, time = "", detail) => {
  const name = detail
    ? `<div class="wrap rule-detail">${ruleName(label, detail)}<div class="muted">${esc(detail.description)}</div></div>`
    : `<span class="mono wrap">${esc(label)}</span>`;
  return { state, html: `<li class="check-${state}">${CHECK_ICON[state]}${name}<span class="wrap ${state === "fail" ? "bad" : "muted"}">${esc(note)}</span><span class="r">${esc(time)}</span></li>` };
};

const failedRules = (run) => new Set([...(run.failedRules ?? (run.failures ?? []).map((f) => f.guardrail)), ...(run.killedRules ?? [])]);

const alertsChecked = (run) => run.outcome === "empty" || (run.outcome === "ran" && (run.result === "pass" || isAudit(run) || auditMode(run)));

const setupChecks = (run, events) => {
  const stop = notPassing(run) && run.outcome !== "ran" ? stoppedAt(run)?.id : undefined;
  const step = (id, label) => {
    const v = run.steps?.[id];
    if (v === undefined) return check("skip", label, "not reached");
    const failed = events.findLast((event) => event.step === id)?.state === "fail" || id === stop;
    return failed ? check("fail", label, outcome(run).text, elapsed(v)) : check("pass", label, "done", elapsed(v));
  };
  const alert = run.alert !== undefined
    ? check("fail", "No open alerts", unwired(run) ? `Warden is unwired. ${DETAIL_TEXT[run.alert] ?? run.alert}` : `open tamper alert: ${run.alert}`)
    : alertsChecked(run) ? check("pass", "No open alerts", "none open") : check("skip", "No open alerts", run.outcome === "ran" ? "not checked, because a rule failed first" : "not reached");
  return [alert, step("rules-intact", "Rules intact"), step("tools-ready", "Tools ready")];
};

const ruleChecks = (run, details) => {
  const failed = failedRules(run);
  const timed = run.rules ?? {};
  const ids = [...new Set([...failed, ...Object.keys(timed), ...(run.cachedRules ?? [])])].sort((a, b) => Number(failed.has(b)) - Number(failed.has(a)) || a.localeCompare(b));
  if (ids.length === 0) {
    if (run.steps?.rules === undefined) return [check("skip", "Rules", run.outcome === "ran" || run.outcome === "empty" ? "no per-rule results were recorded" : "did not run, because Warden stopped first")];
    return [check("skip", "Rules", run.guardrails === 0 ? "no rules were selected" : "no per-rule results were recorded")];
  }
  return ids.map((id) => {
    const detail = ruleDetail(details, id);
    const time = timed[id] === undefined ? "cached" : elapsed(timed[id]);
    if (!failed.has(id)) return check("pass", id, timed[id] === undefined ? "passed, cached result" : "passed", time, detail);
    const shown = (run.failures ?? []).filter((f) => f.guardrail === id).length;
    if (run.killedRules?.includes(id)) return check("fail", id, "stopped at its time budget", time, detail);
    return check("fail", id, shown === 0 ? "failed" : `failed · ${plural(shown, "finding")} shown below`, time, detail);
  });
};

export const checklist = (run, heading = { level: "h3", id: "" }, events = [], currentDetails) => {
  const setup = setupChecks(run, events);
  const rules = ruleChecks(run, run.ruleDetails ?? currentDetails ?? {});
  const count = (state) => [...setup, ...rules].filter((c) => c.state === state).length;
  return `<div class="modh"><${heading.level} class="h2"${heading.id ? ` id="${heading.id}"` : ""}>Checks</${heading.level}><span class="muted">${num(count("pass"))} passed · ${num(count("fail"))} failed · ${num(count("skip"))} not run</span></div>
<div class="lbl checks-group">Warden setup</div><ol class="steps checks">${setup.map((c) => c.html).join("")}</ol>
<div class="lbl checks-group">Rules · ${plural(rules.filter((c) => c.state !== "skip").length, "rule")}</div>${currentDetails ? '<p class="muted rule-detail-source">Descriptions use the current rule definitions.</p>' : ""}<ol class="steps checks rule-checks">${rules.map((c) => c.html).join("")}</ol>`;
};

const findingRow = ({ source, file, guardrail, line, practice, doThis }, project, details) => {
  const detail = ruleDetail(details, guardrail);
  const location = file ? `${file}${line > 0 ? `:${line}` : ""}` : "Project-wide";
  const label = source ? `${new Date(source.at).toLocaleDateString()} ${short(source.at)} · ${source.tier ?? "Run"}` : "";
  const run = source?.run ? `<a class="run-link" href="${href("run", { project, run: source.run })}">${esc(label)}</a>` : esc(label);
  return `<li class="finding-row">
<div class="finding-location"><div class="mono">${esc(location)}</div>${doThis ? `<div class="muted finding-note">${esc(doThis)}</div>` : ""}</div>
<div>${ruleName(guardrail, detail)}${practice && !detail ? `<div class="muted">${esc(practice)}</div>` : ""}</div>
${source ? `<div>${run}<div class="muted">${esc([trigger(source), shortRef(source.ref)].filter(Boolean).join(" · "))}</div>${source.root ? `<div class="mono muted" title="${esc(source.root)}">${esc(pathTail(source.root))}</div>` : ""}</div>` : ""}
</li>`;
};

const findingsList = (list, project, details = {}) => `<div class="findings${project ? " has-source" : ""}">
<div class="finding-row finding-labels lbl" aria-hidden="true"><span>Location</span><span>Guardrail</span>${project ? "<span>Source run</span>" : ""}</div>
<ul aria-label="Rule findings">${list.map((finding) => findingRow(finding, project, details)).join("")}</ul></div>`;

export const failuresPage = (state) => {
  const { data } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const { project, checked, findings, problems, alerts } = data.failures;
  const section = (id, label, count, body) => `<section class="mod" aria-labelledby="${id}"><div class="modh"><h2 class="h2" id="${id}">${label}</h2><span class="muted">${num(count)}</span></div>${body}</section>`;
  const notice = (message) => `<div class="pad muted">${message}</div>`;
  const current = findings.filter((finding) => !finding.unverified);
  const unverified = findings.filter((finding) => finding.unverified);
  const recorded = current.length ? findingsList(current, project) : notice(checked ? "No unresolved tracked failures or audit findings in the retained records." : "No check has run for a watched checkout yet.");
  const issues = problems.map((run) => `<div class="alert">${slot(tag(outcome(run)))}<div><strong>${esc(tierTitle(run))}</strong><div class="muted">${esc(trigger(run))}${checkout(run) ? ` · <span class="mono" title="${esc(checkout(run))}">${esc(pathTail(checkout(run)))}</span>` : ""}</div>${run.next && !quiet ? `<div class="mono finding-note">${esc(run.next)}</div>` : ""}</div>${run.run ? `<a href="${href("run", { project, run: run.run })}">Open run</a>` : ""}</div>`).join("");
  const detections = alerts.map((alert) => `<div class="alert"><div><strong>${esc(alertLabel(alert.detail))}</strong><div class="mono finding-note">${esc(alert.file)} · ${esc(alert.root)}</div>${alert.next && !quiet ? `<div class="muted finding-note">${esc(alert.next)}</div>` : ""}</div></div>`).join("");
  return `${header(`Current failures · ${esc(project)}`, "Check failures with no recorded resolution, plus the latest findings from each audit.")}
${section("fl-findings", "Rule findings", current.length, recorded)}
${unverified.length ? section("fl-unverified", "Findings with unverified status", unverified.length, notice("Warden recorded these findings without evidence that tracks when they clear.") + findingsList(unverified, project)) : ""}
${section("fl-problems", "Latest run problems", problems.length, issues || notice("No run problems in the latest recorded attempts."))}
${section("fl-alerts", "Open tamper detections", alerts.length, detections || notice("No open tamper detections."))}`;
};

const tierTitle = (run) => `${(run.tier ?? "").replace(/^./, (c) => c.toUpperCase())}${run.tier ? ` ${isAudit(run) ? "audit" : "check"}` : "Run"} · ${clock(run.at)}`;

const runSub = (run) => [trigger(run), elapsed(run.ms), run.exit == null ? null : `exit ${run.exit}`].filter(Boolean).join(" · ");

const code = (value) => value == null ? "–" : `<code class="mono">${esc(value)}</code>`;

const runFacts = (run) => {
  const scope = { full: "Full tier", partial: "Partial tier" }[run.scope] ?? run.scope ?? "–";
  const facts = [
    [run.root || !run.attemptedRoot ? "Checkout" : "Attempted checkout", code(checkout(run))],
    ["Commit", code(run.commit)],
    ...(run.ref ? [["Ref", code(run.ref)]] : []),
    ["Mode", esc(runMode(run))],
    ["Scope", esc(scope)],
    ["Files scanned", run.file == null ? esc(target(run)) : code(run.file)],
    ...(Array.isArray(run.packs) ? [["Packs", run.packs.map(code).join(", ") || "None"]] : []),
    ["Run ID", code(run.run)],
    ["Base", code(run.base)],
    ["Merge base", code(run.mergeBase)],
    ["Bytes scanned", num(run.bytes)],
    ["Ratchet", run.ratchet ? `${num(run.ratchet[0])} → ${num(run.ratchet[1])}` : "–"],
  ];
  return `<dl class="facts">${facts.map(([key, value]) => `<dt class="lbl">${key}</dt><dd>${value}</dd>`).join("")}</dl>`;
};

export const filterRuns = (runs, view = {}) =>
  runs.filter((r) => (view.outcome === "pass" ? passed(r) : view.outcome === "not" ? notPassing(r) : true) && (!view.tier || r.tier === view.tier) && (!view.file || [r.file ?? "", ...(r.failures ?? []).map((f) => f.file)].some((f) => f.includes(view.file))));

export const runsPage = (state) => {
  const { data, view = {} } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const runs = data.runs.runs;
  const shown = filterRuns(runs, view);
  const counts = { all: runs.length, pass: runs.filter(passed).length, not: runs.filter(notPassing).length };
  const seg = [["all", "All"], ["pass", "Passed"], ["not", "Not passing"]].map(([id, label]) => `<button type="button" data-outcome="${id}" aria-pressed="${(view.outcome ?? "all") === id ? "true" : "false"}">${label} ${num(counts[id])}</button>`).join("");
  const tiers = ["edit", "commit", "boundary"].map((t) => `<option value="${t}"${view.tier === t ? " selected" : ""}>${t}</option>`).join("");
  const label = { all: "All runs", pass: "Passed", not: "Not passing" }[view.outcome ?? "all"];
  const cols = ["timeLink", "trigger", "tier", "outcome", "bar", "ms", "next"];
  const mode = selectedProject(state)?.mode;
  return `${header(`Runs · ${esc(data.runs.project)}`, `${plural(runs.length, "recent run")} · ${num(counts.not)} not passing${MODE[mode] ? ` · ${MODE[mode][0]}: ${MODE[mode][1]}` : ""}`, `<a class="run-link" href="${href("failures", { project: data.runs.project })}">Current failures</a>`)}
${unwiredBanner(selectedProject(state))}
<div class="filters"><div class="seg" role="group" aria-label="Outcome">${seg}</div><label><span class="lbl">Tier</span><select id="rn-tier" data-action="tier"><option value="">Every tier</option>${tiers}</select></label><label><span class="lbl">File</span><input id="rn-file" type="search" data-action="file" placeholder="Filter by changed file" value="${esc(view.file ?? "")}"></label></div>
<section class="mod run-list" aria-labelledby="rn-list"><div class="modh"><h2 class="h2" id="rn-list">${label} · newest first</h2><span class="muted bar-note">Duration bars show up to 3 s</span></div>
<div class="scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Trigger</th><th scope="col">Tier</th><th scope="col">Outcome</th><th scope="col">Duration</th><th scope="col" class="r" aria-label="Duration in milliseconds">ms</th><th scope="col">Next action</th></tr></thead>
<tbody>${shown.length === 0 ? '<tr><td colspan="7" class="muted">No run matches these filters.</td></tr>' : shown.map((r) => runRow({ ...r, project: data.runs.project }, cols, { fresh: view.fresh })).join("")}</tbody></table></div></section>`;
};

export const streakOf = (runs, run) => {
  const i = runs.findIndex((r) => r.run === run.run);
  const same = (r) => r.outcome === run.outcome && r.result === run.result && r.alert === run.alert && r.next === run.next;
  const out = [];
  for (let j = i; j >= 0 && j < runs.length && same(runs[j]); j++) out.push(runs[j]);
  return out;
};

const runMessage = (run) => {
  const audit = isAudit(run);
  if (run.alert === "hook-unwired" && !audit) {
    const rules = run.result === "pass" ? "The run’s rules passed. " : "";
    const result = auditMode(run) ? "Warden recorded this run and did not block it." : run.trigger === "agent-edit" && run.exit === 0
      ? "Warden reported a block to the agent hook and exited with status 0."
      : "Warden blocked this check because Git’s configured pre-commit hook does not invoke Warden.";
    return [alertLabel(run.alert), rules + result];
  }
  if (run.alert !== undefined && !audit && unwired(run)) return ["Warden is unwired", `${DETAIL_TEXT[run.alert] ?? run.alert} ${auditMode(run) ? "Warden recorded this run and did not block it." : "Warden blocked this run until you fix the setup."} This is a setup problem. The rule results are in the checklist.`];
  if (run.alert !== undefined) return audit
    ? ["Audit refused by an open tamper alert", `The daemon has an open alert for this repository (${run.alert}). Resolve it before relying on the audit.`]
    : ["Blocked by an open tamper alert", `The daemon has an open alert for this repository (${run.alert}). The check exited ${run.exit ?? 1}.`];
  if (run.outcome === "ran" && run.result === undefined) return ["No verdict recorded", "The run receipt does not include a result."];
  if (run.outcome === "ran" && audit) {
    if (run.exit === 0) return ["Audit reported findings", "This advisory run completed with exit 0. Review the recorded findings below."];
    return ["Audit did not complete", "Review the next action and any recorded findings before relying on this result."];
  }
  if (run.outcome === "ran" && auditMode(run)) return ["Rules failed in audit mode", "Warden recorded the failures and did not block. The checklist shows which rules failed."];
  if (run.outcome === "ran") return ["Check blocked", "The checklist shows which rules failed. Fix them, then run the check again."];
  const step = stoppedAt(run);
  const name = OUTCOME_TITLE[run.outcome] ?? run.outcome;
  return step
    ? [`${name} at ${step.label}`, `Warden stopped at step ${STEPS.indexOf(step) + 1} of ${STEPS.length}.`]
    : [`${name} before the first step`, "Warden recorded no completed steps."];
};

const banner = (run) => {
  if (!notPassing(run)) return "";
  const [title, why] = runMessage(run);
  return `<section class="banner ${run.outcome === "tampered" ? "red" : "amber"}" aria-labelledby="er-h"><div class="top">${tag(outcome(run))}<h2 id="er-h">${esc(title)}</h2></div><p>${esc(why)}</p>${run.next ? nextBox(run.next) : ""}</section>`;
};

const videoSection = (project, run) => {
  if (!run.video) return "";
  const src = (file) => esc(`/api/video?${new URLSearchParams({ project, run: run.run, file })}`);
  const frames = run.video.keyframes ?? [];
  return `<section class="mod change-video" aria-labelledby="er-video"><div class="modh"><h2 class="h2" id="er-video">Change video</h2><span class="muted">Recorded by the agent that made the change${frames.length ? ` · ${plural(frames.length, "keyframe")}` : ""}</span></div>
<div class="pad"><video controls preload="metadata" width="1280" height="800" src="${src(run.video.file)}"></video>${frames.length ? `<ul class="keyframes">${frames.map((k) => `<li><a href="${src(k)}" target="_blank" rel="noopener"><img src="${src(k)}" alt="Keyframe ${esc(k)}" width="1280" height="800" loading="lazy"></a></li>`).join("")}</ul>` : ""}</div></section>`;
};

const missingRun = (project, id) => `<section class="mod pad finding-note" role="status">Warden has no retained record for run <span class="mono">${esc(id)}</span> in ${esc(project)}. <a href="${href("runs", { project })}">Open the run list</a></section>`;

export const runPage = (state) => {
  const { data } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const project = data.runs.project;
  const runs = data.runs.runs;
  const wanted = state.view?.run;
  if (wanted && !runs.some((r) => r.run === wanted)) return `${header(`Runs · ${esc(project)}`, "Run not found")}${missingRun(project, wanted)}`;
  const run = runs.find((r) => r.run === wanted) ?? runs[0];
  if (run === undefined) return `${header(`Runs · ${esc(project)}`, "No runs yet")}<section class="mod pad muted">No check has run in ${esc(project)} yet.</section>`;
  const streak = streakOf(runs, run);
  const findings = data.runs.findings ?? run.failures ?? [];
  const details = run.ruleDetails ?? data.runs.currentRuleDetails;
  const date = new Date(run.at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `<header class="head"><div><a href="${href("runs", { project })}" style="font-size:12px;font-weight:600">Runs · ${esc(project)}</a><h1 class="h1">${esc(tierTitle(run))}</h1><div class="muted">${esc(date)} · ${esc(runSub(run))}</div></div><div class="controls"><button class="btn" type="button" data-copy="${esc(run.run)}">Copy run ID</button></div></header>
${unwiredBanner(selectedProject(state))}
${banner(run)}
${videoSection(project, run)}
<section class="mod" aria-labelledby="er-steps">${checklist({ ...run, failures: findings }, { level: "h2", id: "er-steps" }, data.runs.steps, data.runs.currentRuleDetails)}${!notPassing(run) && run.next ? nextBox(run.next) : ""}</section>
${findings.length ? `<section class="mod" aria-labelledby="er-findings"><div class="modh"><h2 class="h2" id="er-findings">Recorded ${isAudit(run) ? "findings" : "failures"}</h2><span class="muted">${num(findings.length)}</span></div>${findingsList(findings, undefined, details)}</section>` : ""}
<section class="mod" aria-labelledby="er-run"><div class="modh"><h2 class="h2" id="er-run">Run details</h2>${notPassing(run) ? "" : tag(outcome(run))}</div>${runFacts(run)}</section>
${streak.length > 1 ? `<section class="mod" aria-labelledby="er-streak"><div class="modh"><h2 class="h2" id="er-streak">Same outcome, ${num(streak.length)} runs in a row</h2><span class="muted">since ${esc(clock(streak.at(-1).at))}${run.next ? " · each gave the same next action" : ""}</span></div><div class="scroll"><table><thead><tr><th scope="col">Time</th><th scope="col">Trigger</th><th scope="col">Tier</th><th scope="col" class="r">ms</th></tr></thead><tbody>${streak.map((r) => `<tr${r.run === run.run ? ' class="sel" aria-current="true"' : ""}><td><a href="${href("run", { project, run: r.run })}">${esc(clock(r.at))}</a></td><td>${esc(trigger(r))}</td><td>${esc(r.tier ?? "–")}</td><td class="r">${ms(r.ms)}</td></tr>`).join("")}</tbody></table></div></section>` : ""}`;
};

export const weakest = (practices) => [...practices].sort((a, b) => (KIND_RANK[b.strongestKind] ?? 9) - (KIND_RANK[a.strongestKind] ?? 9))[0];

const readinessTag = (status) => tag({ text: status, cls: ({ Ready: "pass", "Needs setup": "err", Unavailable: "block" })[status] ?? "idle" });

const packChecks = (checks) => {
  const byStatement = new Map();
  for (const check of checks) {
    if (!byStatement.has(check.statement)) byStatement.set(check.statement, []);
    byStatement.get(check.statement).push(check);
  }
  return `<ul class="pack-detail-list">${[...byStatement].map(([statement, group]) => `<li><strong>${esc(statement)}</strong>${group.map((check) => `<div class="pack-check-meta muted"><code>${esc(check.id)}</code><span>${check.adapter === null ? "Instruction" : esc([check.adapter, check.model, ...check.runs].filter(Boolean).join(" · "))}</span></div>`).join("")}</li>`).join("")}</ul>`;
};

const packDetailsPanel = (detail) => `<div class="pack-detail-body">
<div>
<h4>Checks</h4>
${detail.checks.length ? packChecks(detail.checks) : '<p class="muted">This pack has no checks.</p>'}
</div>
<div>
<h4>Setup</h4>
${detail.setup ? `<p>${esc(detail.setup)}</p>` : ""}
${detail.adapters.length ? `<ul class="pack-detail-list">${detail.adapters.map((adapter) => `<li><div class="pack-adapter"><code>${esc(adapter.id)}</code> ${readinessTag(adapter.status)}</div><p>${esc(adapter.setup)}</p></li>`).join("")}</ul>` : '<p class="muted">No execution adapters required.</p>'}
</div>
</div>`;

const checkoutPicker = (state, project, selected, id, disabled = false) => {
  const roots = state.projects.find((entry) => entry.project === project)?.roots ?? [];
  const labels = roots.map(pathTail);
  return roots.length > 1
    ? `<label for="${id}" class="lbl">Checkout</label><select id="${id}" data-nav="checkout" title="${esc(selected)}"${disabled ? " disabled" : ""}>${roots.map((root, i) => `<option value="${esc(root)}"${root === selected ? " selected" : ""}>${esc(labels.indexOf(labels[i]) === labels.lastIndexOf(labels[i]) ? labels[i] : root)}</option>`).join("")}</select>`
    : `<span class="lbl">Checkout</span><span class="mono">${esc(selected)}</span>`;
};

const packCatalog = (state, l) => {
  const settings = l.packSettings;
  const { packDraft, packSaving, packMessage, watchSaving } = state.view;
  const packCount = packDraft?.size ?? 0;
  const detailById = new Map(settings?.details?.map((detail) => [detail.id, detail]));
  const groups = [
    { id: "enabled-packs", title: "Enabled in this checkout", packs: l.packs.filter((pack) => pack.on) },
    { id: "disabled-packs", title: "Disabled in this checkout", packs: l.packs.filter((pack) => !pack.on) },
  ];
  const packOption = (pack) => {
    const saved = settings?.packs.find((entry) => entry.id === pack.id);
    const checked = packDraft?.get(pack.id) ?? saved?.on ?? pack.on;
    const status = saved && !saved.required
      ? `<label class="pack-toggle"><input type="checkbox" id="pack-${esc(pack.id)}" data-pack="${esc(pack.id)}" aria-label="${esc(pack.id)} pack"${checked ? " checked" : ""}${packSaving || watchSaving ? " disabled" : ""}>${checked ? "On" : "Off"}${packDraft?.has(pack.id) ? " (unsaved)" : ""}</label>`
      : pack.on ? `<span class="on"><i aria-hidden="true"></i>${saved?.required ? "On · Required" : "On"}</span>` : '<span class="muted">Off</span>';
    return `<li><a href="#pack-info-${encodeURIComponent(pack.id)}">${esc(pack.id)}</a>${status}</li>`;
  };
  const packArticle = (pack) => {
    const detail = detailById.get(pack.id);
    return `<article class="pack-entry" id="pack-info-${esc(pack.id)}" aria-labelledby="pack-title-${esc(pack.id)}" tabindex="-1">
<header class="pack-entry-head"><div><h3 id="pack-title-${esc(pack.id)}">${esc(pack.id)}</h3><p class="muted">${esc(pack.source)} · ${plural(pack.rules, "rule")}</p></div></header>
${detail ? packDetailsPanel(detail) : '<p class="pack-no-details muted">Check and setup details are unavailable.</p>'}
</article>`;
  };
  const options = groups.map((group) => `<section aria-labelledby="${group.id}"><h3 id="${group.id}">${group.title} <span class="muted">${group.packs.length}</span></h3>${group.packs.length ? `<ul>${group.packs.map(packOption).join("")}</ul>` : '<p class="muted">None</p>'}</section>`).join("");
  return `<section class="mod pack-catalog" aria-labelledby="pack-config"><form id="pack-settings">
<div class="modh"><h2 class="h2" id="pack-config" tabindex="-1">Packs · ${esc(l.project)}</h2></div>
${settings ? `<div class="pack-toolbar"><div class="controls">${checkoutPicker(state, l.project, settings.root, "pack-checkout", packSaving || packCount)}</div><p>Changes apply to this checkout. New packs cover all paths. After saving, run <code>warden compile</code> with this Warden build and sign the commit.</p></div>` : ""}
${l.packs.length ? `<div class="pack-options">${options}</div>` : '<p class="pad muted">No packs available for this checkout.</p>'}
${settings ? `<div class="pack-toolbar pack-actions controls${packCount || packSaving ? " pending" : ""}"><button type="submit" class="btn"${!packCount || packSaving ? " disabled" : ""}>${packSaving ? "Saving…" : "Save pack changes"}</button><button type="button" class="btn" data-action="discard-packs"${!packCount || packSaving ? " disabled" : ""}>Discard changes</button><span role="status">${esc(packMessage ?? (packCount ? plural(packCount, "unsaved change") : ""))}</span></div>` : ""}
</form></section>
${l.packs.length ? `<section class="mod pack-catalog" aria-labelledby="pack-details"><div class="modh"><div><h2 class="h2" id="pack-details">Checks and setup</h2><span class="muted">Readiness is measured in this checkout and dashboard process.</span></div></div>${groups.flatMap((group) => group.packs.map(packArticle)).join("")}
${settings?.jev ? `<section class="pack-evaluator" aria-labelledby="jev-evaluator"><div class="pack-adapter"><h3 id="jev-evaluator">Jev live calls (TypeSafe)</h3>${readinessTag(settings.jev.status)}</div><p>${settings.jev.packIds.length ? `Declared in ${esc(settings.jev.packIds.join(", "))}.` : "Optional evaluator. No pack in this checkout declares a Jev check."}</p><p>${esc(settings.jev.setup)}</p></section>` : ""}
</section>` : ""}`;
};

const watchPanel = (state) => {
  const { projects, watch = { added: [], paused: [] } } = state.data;
  const { watchSaving, watchMessage } = state.view ?? {};
  const disabled = watchSaving ? ' aria-disabled="true"' : "";
  const active = new Map(projects.map((entry) => [entry.project, entry]));
  const names = [...new Set([...active.keys(), ...watch.added.map(({ project }) => project), ...watch.paused])].sort();
  const rows = names.map((project) => {
    const entry = active.get(project);
    const paused = watch.paused.includes(project);
    const status = paused ? "Stopped" : entry?.auditOnly ? "Published audit" : entry ? "Watching" : "Project folder unavailable";
    return `<li><strong>${esc(project)}</strong><span class="muted">${status}</span><button type="button" class="btn" id="watch-toggle-${esc(encodeURIComponent(project))}" data-watch="${esc(project)}" data-watching="${paused}" aria-label="${paused ? "Resume watching" : "Stop watching"} ${esc(project)}"${disabled}>${paused ? "Resume watching" : "Stop watching"}</button></li>`;
  }).join("");
  return `<section class="mod" aria-labelledby="watch-heading">
<div class="modh"><h2 class="h2" id="watch-heading">Watched projects</h2></div>
<form id="watch-add" class="watch-form"><div><button id="watch-submit" class="btn" type="submit"${disabled}>Choose project folder</button></div><p class="muted">Choose the root folder of a Git project set up with <code>warden init</code>. Stopping a watch pauses daemon checks and scheduled audits. Git hooks and recorded runs stay in place.</p><p role="status">${esc(watchSaving ? "Updating watched projects…" : watchMessage ?? "")}</p></form>
${rows ? `<ul class="watch-list">${rows}</ul>` : '<p class="pad muted">No watched projects yet.</p>'}
</section>`;
};

const signingPanel = (state, selected) => {
  const { signing } = state.data;
  const { signingProject, signingNotice } = state.view ?? {};
  const pending = signingProject === selected.project;
  const status = signingNotice?.project === selected.project ? signingNotice.message : "";
  const stage = signing?.stage;
  const value = (label, content, file) => content === undefined ? ""
    : `<div><strong>${label}${file && content.binary ? " (base64)" : ""}</strong><pre>${esc(file ? content.text : JSON.stringify(content, null, 2))}</pre></div>`;
  const changes = (items, empty, file = false) => items.length
    ? `<ul>${items.map(({ name, change, before, after }) => `<li><details><summary><strong>${esc(change)}</strong> <code>${esc(name)}</code></summary>
<div class="signing-values">${value("Current", before, file)}${value("Staged", after, file)}</div></details></li>`).join("")}</ul>`
    : `<p class="muted">${empty}</p>`;
  return `<section class="mod" aria-labelledby="policy-signing">
<div class="modh"><h2 class="h2" id="policy-signing">Policy signing · ${esc(selected.project)}</h2></div>
<div class="watch-form signing-review">
${signing?.error ? `<p role="alert">${esc(signing.error)}</p>`
  : !stage ? '<p class="muted">No policy is staged for signing.</p>'
    : `<p>Published audit branch <code>${esc(signing.ref)}</code></p>
<h3>Rule changes</h3>${changes(stage.rules, "No rule changes.")}
<details${stage.settings.length ? " open" : ""}><summary>Enrollment settings (${stage.settings.length})</summary>${changes(stage.settings, "No enrollment setting changes.")}</details>
<details><summary>Changed policy files (${stage.files.length})</summary>${changes(stage.files, "No file changes.", true)}</details>
<p>Policy revision <code>${esc(stage.revision)}</code></p>
<form id="enrollment-signing">
<button class="btn" type="submit" id="sign-policy"${pending || stage.verified || !stage.canSign ? ' aria-disabled="true"' : ""}>${stage.verified ? "Signature verified" : pending ? "Waiting for approval…" : "Sign reviewed policy"}</button>
</form>
<p role="status">${esc(status || (pending ? "Complete or cancel the local signing prompt." : stage.verified ? "The staged policy is signed. Activate it separately." : stage.canSign ? "Unlock your owner key in the local prompt." : "Native policy signing is available on macOS."))}</p>`}</div></section>`;
};

export const packsPage = (state) => {
  const { data } = state;
  const selected = selectedProject(state);
  const packContent = data.layersError ? apiError(data.layersError)
    : data.layers ? packCatalog(state, data.layers)
    : `<section class="mod" aria-labelledby="pack-config"><div class="modh"><h2 class="h2" id="pack-config" tabindex="-1">Packs${selected ? ` · ${esc(selected.project)}` : ""}</h2></div><p class="pad muted">${selected?.auditOnly ? "Pack settings require a watched checkout. This project uses a published audit." : "Add a project with a watched checkout to manage its packs."}</p></section>`;
  return `${header("Configuration", "Manage watched projects and packs.")}${watchPanel(state)}${packContent}`;
};

const configurationPage = (state) => `${header("Configuration", "Manage the projects Warden watches.")}${watchPanel(state)}`;

const catalogAnchor = (type, id) => `${type}-${id}`;
const catalogLink = (type, id) => `<a href="#${encodeURIComponent(catalogAnchor(type, id))}"><code>${esc(id)}</code></a>`;

const packCatalogPage = ({ data: { catalog } }) => {
  const groups = [
    { type: "adapter", title: "Execution adapters", key: "adapters" },
    { type: "review-adapter", title: "Review adapters", key: "reviewAdapters" },
  ].map((group) => ({ ...group, registered: new Set(catalog[group.key].map(({ id }) => id)) }));
  const packRows = catalog.packs.map((pack) => {
    const { id, rules } = pack;
    const links = groups.flatMap(({ key, type, registered }) => pack[key].map((id) =>
      registered.has(id) ? catalogLink(type, id) : `<span><code>${esc(id)}</code> (unregistered)</span>`));
    return `<li id="${esc(catalogAnchor("pack", id))}" tabindex="-1">
<h3><code>${esc(id)}</code></h3>
<div class="catalog-links"><span class="muted">${plural(rules, "rule")}</span>
${links.length ? links.join("") : '<span class="muted">No adapters declared</span>'}</div></li>`;
  }).join("");
  const adapterGroups = groups.map(({ key, type, title }) => {
    const list = catalog[key].map(({ id, description, packs }) => `<li id="${esc(catalogAnchor(type, id))}" tabindex="-1">
<h4><code>${esc(id)}</code></h4><p>${esc(description)}</p>
<div class="catalog-links">${packs.length ? packs.map((id) => catalogLink("pack", id)).join("") : '<span class="muted">No bundled packs use this adapter</span>'}</div></li>`).join("");
    return `<section aria-labelledby="catalog-${type}"><h3 class="catalog-group-heading" id="catalog-${type}" tabindex="-1">${title}</h3>
${list ? `<ul class="catalog-list">${list}</ul>` : '<p class="pad muted">This build has none registered.</p>'}</section>`;
  }).join("");
  return `${header("Pack catalog", "Browse bundled packs and the adapters registered in this Warden build.", '<a href="#catalog-adapters">Jump to adapters</a>')}
<div class="catalog-grid">
<section class="mod" aria-labelledby="catalog-packs"><div class="modh"><h2 class="h2" id="catalog-packs">Packs</h2><span class="muted">${catalog.packs.length}</span></div>
${packRows ? `<ul class="catalog-list">${packRows}</ul>` : '<p class="pad muted">No bundled packs are available.</p>'}</section>
<section class="mod" aria-labelledby="catalog-adapters"><div class="modh"><h2 class="h2" id="catalog-adapters" tabindex="-1">Adapters</h2><span class="muted">${catalog.adapters.length + catalog.reviewAdapters.length}</span></div>
${adapterGroups}</section>
</div>`;
};

const ruleExample = `id: warden-no-comments
kind: lint
runs: [edit, commit]
budgetMs: 5000
version: 1
implementation: "eslint:warden/no-comments"
mustFail: |
  // A greeting
  export const greeting = "Hello";
mustPass: |
  export const greeting = "Hello";`;

const aboutPage = () => `${header("About Warden", "Advisory checks for the projects you work on.")}
<article class="mod about-content">
<section><h2>What Warden does</h2><p>Warden records checks from edits, commits, and scheduled audits of published branches. It surfaces rule findings and setup problems while work continues.</p></section>
<section><h2>Packs</h2><p>A pack is a set of related checks you can enable for a project. A check can need a tool, project configuration, or credentials in the runner. Open a project's Checks tab to see the checks and setup for each pack.</p><p><a href="${href("pack-catalog")}">Browse packs and adapters</a></p></section>
<section aria-labelledby="check-timing"><h2 id="check-timing">When checks run</h2>
<p>A Guardrail lists its eligible tiers in <code>runs</code>. Warden selects rules from enabled packs for the tier it is running.</p>
<dl class="about-reference">
<dt>Edit</dt><dd>Trusted Claude Code edit hooks and the Codex patch hook run <code>edit</code> rules. Core checks matching source files for comments and inline suppressions.</dd>
<dt>Commit</dt><dd>The Git pre-commit hook runs <code>commit</code> rules for the proposed commit. For example, the TypeScript pack checks compiler diagnostics.</dd>
<dt>Boundary</dt><dd>Run <code>warden audit --tier boundary</code> to evaluate <code>boundary</code> rules. Packs can run tests, validate project structure, check a model, or request a judgment. For a signed enrollment, <code>warden candidate</code> evaluates one boundary rule against exact base and candidate commits.</dd>
<dt>Published branch</dt><dd>When an enrolled ref such as <code>origin/main</code> advances locally, the daemon runs <code>edit</code> and <code>boundary</code> rules from the signed policy in a temporary checkout. Each receipt identifies the ref, commit, base, and enabled packs.</dd>
<dt>After the fact</dt><dd>The daemon checks watched repositories for missing commit verification and policy drift. At Claude Code session end, Warden records unresolved edit findings when the judged file still matches the recorded evidence. You can also publish an external check report for an enrolled ref with <code>warden publish</code>.</dd>
</dl></section>
<section aria-labelledby="check-methods"><h2 id="check-methods">How checks evaluate code and evidence</h2>
<dl class="about-reference">
<dt>Static analysis</dt><dd>ESLint inspects source syntax, TypeScript checks types, and graph rules inspect imports. These checks can report findings without running the application.</dd>
<dt>Runtime checks</dt><dd>The command adapter can run tests or builds. The Machines pack can validate recorded transitions against a machine definition.</dd>
<dt>Models and proofs</dt><dd>The TLA pack checks a model with TLC. The Proofs pack builds Lean proofs and can compare implementation results with a proved model.</dd>
<dt>Judgment and review</dt><dd>The System One adapter evaluates a question against selected inputs with a pinned model. A review capability selects a <a href="${href("pack-catalog")}#catalog-review-adapter">review adapter</a> to prepare the review and normalize its findings.</dd>
<dt>Written guidance</dt><dd>An <code>instruction</code> rule describes a practice without invoking an execution adapter.</dd>
</dl></section>
<section><h2>How a rule runs</h2><p>Warden calls a rule a Guardrail. A pack groups Guardrails under practices that describe what to check and which paths to include.</p>
<pre class="rule-example mono"><code>${esc(ruleExample)}</code></pre>
<p>For the rule above, Warden selects <a href="${href("pack-catalog")}#adapter-eslint"><code>eslint</code></a> from <code>implementation</code>. The adapter runs <code>warden/no-comments</code> on matching files at edit and commit time. Warden reports any findings and tracks the run against <code>budgetMs</code>. Some adapters also read rule-specific <code>options</code>.</p>
<p><code>version</code> identifies the rule revision. During policy compilation, Warden checks that <code>mustFail</code> produces a finding and <code>mustPass</code> passes.</p></section>
<section><h2>Rule strength</h2><dl><dt>Deterministic</dt><dd>Code applies a check you can repeat, such as a compiler check, a lint rule, or a test.</dd><dt>Judgment</dt><dd>A model or reviewer evaluates a rule that calls for interpretation.</dd><dt>Prose</dt><dd>Written guidance describes what to do. A prose rule alone produces no automated test result.</dd></dl></section>
<section><h2>Tamper alerts</h2><p>Warden compares policy files, signatures, and check setup with their expected state. An alert points to what changed and what to inspect.</p></section>
</article>`;

const projectCheckRow = (rule, result, project) => {
  const automated = rule.kind !== "instruction" && rule.runs.length > 0;
  const text = automated ? result?.status ?? "No run recorded" : rule.kind === "instruction" ? "Written guidance" : "No automated check";
  const status = !automated || !result ? "idle" : result.status === "Passed" ? "pass" : "err";
  return `<li><div><strong title="${esc(rule.id)}">${esc(rule.name)}</strong><p class="muted">${esc(rule.statement)}</p></div><div class="project-check-result">${tag({ cls: status, text })}${automated ? `<span class="muted">Runs on ${esc(rule.runs.join(", "))}</span>` : ""}${automated && result?.run ? `<a href="${href("run", { project, run: result.run })}" title="${esc(result.at)}">Last result</a>` : ""}</div></li>`;
};

const projectStatusPanel = ({ data, project }, entry) => {
  const { checks } = data;
  const active = checks?.packs.filter((pack) => pack.on) ?? [];
  const sections = active.map(({ id }) => {
    const details = checks.details.find((entry) => entry.id === id);
    const rows = details.checks.map((rule) => projectCheckRow(rule, Object.hasOwn(checks.results, rule.id) ? checks.results[rule.id] : undefined, project)).join("");
    return `<section class="mod" aria-label="${esc(id)}"><div class="modh"><h2 class="h2">${esc(id)}</h2>${tag({ cls: "pass", text: "Enabled" })}</div>${rows ? `<ul class="project-check-list">${rows}</ul>` : '<p class="pad muted">This pack has no checks.</p>'}</section>`;
  }).join("");
  const alerts = data.alerts?.alerts ?? [];
  const audits = mainAuditRuns(entry);
  const audit = audits.length ? `<section class="mod" aria-label="Latest scheduled audit"><div class="modh"><h2 class="h2">Latest scheduled audit</h2><span class="muted" title="${esc(audits[0].ref)}">${auditRefLabel(audits[0])}</span></div><ul class="audit-results pad">${audits.map((run) => `<li>${run.run ? `<a href="${href("run", { project, run: run.run })}">${esc(run.tier ? `${titleCase(run.tier)} audit` : "Audit run")}</a>` : "Audit run"} ${tag(outcome(run))}</li>`).join("")}</ul></section>` : "";
  return `${audit}${checks ? sections || '<p class="muted">No packs are enabled.</p>' : ""}
<section class="mod" id="project-alerts" tabindex="-1" aria-labelledby="project-alert-heading"><div class="modh"><h2 class="h2" id="project-alert-heading">Project alerts</h2><a href="${href("failures", { project })}">Current failures</a></div>${data.alerts?.error ? `<p class="pad" role="alert">${esc(data.alerts.error)}</p>` : alerts.length ? `<ul class="project-alert-list">${alerts.map((alert) => `<li><strong>${esc(alertLabel(alert.detail))}</strong><div class="muted wrap">${esc(alert.file)}</div><p>${esc(alert.next)}</p></li>`).join("")}</ul>` : '<p class="pad muted">No open tamper detections.</p>'}</section>`;
};

const projectChecksPanel = ({ data, view }) => {
  const { checks } = data;
  if (!checks) return "";
  const seen = new Set();
  const renderPack = (pack, rules) => {
    const setting = checks.packs.find((entry) => entry.id === pack.id);
    const enabled = view.packDraft?.get(pack.id) ?? setting.on;
    const first = !seen.has(pack.id);
    seen.add(pack.id);
    const toggle = first && !setting.required
      ? `<label class="pack-toggle"><input id="pack-${esc(pack.id)}" data-pack="${esc(pack.id)}" type="checkbox" aria-label="${esc(pack.id)} pack"${enabled ? " checked" : ""}${view.packSaving ? " disabled" : ""}>${enabled ? "On" : "Off"}</label>`
      : tag({ cls: enabled ? "pass" : "idle", text: enabled ? setting.required ? "Required" : "On" : "Off" });
    const rows = rules.map((rule) => `<li><div><strong title="${esc(rule.id)}">${esc(rule.name)}</strong><p class="muted">${esc(rule.statement)}</p></div><span class="muted">${rule.kind !== "instruction" ? esc(rule.runs.join(" · ")) : ""}</span></li>`).join("");
    const setup = first ? [pack.setup, ...pack.adapters.filter((adapter) => adapter.status === "Needs setup" || adapter.status === "Unavailable").map((adapter) => adapter.setup)].filter(Boolean) : [];
    return `<section class="mod project-pack"><div class="modh"><h3 class="h2">${esc(pack.id)}</h3>${toggle}</div>${rows ? `<ul class="project-check-list">${rows}</ul>` : ""}${setup.map((note) => `<p class="pad muted project-setup">${esc(note)}</p>`).join("")}</section>`;
  };
  const bands = checks.bands.map((band) => {
    const groups = checks.details.map((pack) => {
      const rules = pack.checks.filter((rule) => band.kinds.includes(rule.kind));
      return rules.length ? renderPack(pack, rules) : "";
    }).join("");
    const label = titleCase(band.name.toLowerCase());
    return groups ? `<section class="check-band"><div><h2>${esc(label)}</h2><div class="muted">${esc(BAND_TEXT[label.toLowerCase()])}</div></div>${groups}</section>` : "";
  }).join("");
  const withoutChecks = checks.details.filter((pack) => pack.checks.length === 0).map((pack) => renderPack(pack, [])).join("");
  return `<form id="pack-settings" class="project-check-form">
${checks.needsSignature ? '<p class="muted">Download the updated config for the policy owner to compile and stage. Review and sign the staged policy below.</p>' : ""}
<div class="mod pack-save controls"><button id="pack-save" class="btn" type="submit"${!view.packDraft?.size || view.packSaving ? " disabled" : ""}>${checks.needsSignature ? "Download pack changes" : "Save pack changes"}</button><button class="btn" data-action="discard-packs" type="button"${!view.packDraft?.size || view.packSaving ? " disabled" : ""}>Discard changes</button><span role="status">${esc(view.packMessage ?? (view.packDraft?.size ? plural(view.packDraft.size, "unsaved change") : ""))}</span></div>
${bands}${withoutChecks ? `<section class="check-band"><h2>Packs without checks</h2>${withoutChecks}</section>` : ""}${bands || withoutChecks ? "" : '<p class="muted">No packs are available.</p>'}</form>`;
};

const projectPage = (state) => {
  const { data, project, view = {} } = state;
  const p = selectedProject(state);
  if (!p) return state.projects.length ? `${header("Project unavailable", "Choose a project in the sidebar.")}` : emptyState("project");
  const tab = view.tab === "checks" ? "checks" : "status";
  const tabs = ["status", "checks"].map((name) => `<a href="${href("project", { project, tab: name })}"${name === tab ? ' aria-current="page"' : ""}>${titleCase(name)}</a>`).join("");
  const description = p.auditOnly ? `Published audit · ${auditRefLabel(p.auditOnly)}` : "Watched project";
  return `${header(esc(project), description, `<a href="${href("runs", { project })}">Run history</a>`)}
<nav class="project-tabs" aria-label="Project tabs">${tabs}</nav>
${data.checksError ? apiError(data.checksError) : ""}
${tab === "checks" ? projectChecksPanel(state) : projectStatusPanel(state, p)}
${tab === "checks" && p.auditOnly ? signingPanel(state, p) : ""}`;
};

const titleCase = (value) => value[0].toUpperCase() + value.slice(1);

const ruleRows = (rules, context) => `<ul class="policy-rules">${rules.map((r) => `<li>
<div><strong>${esc(r.name ?? r.guardrail)}</strong>${context && r.statement ? `<p>${esc(r.statement)}</p>` : ""}</div>
<div class="rule-meta muted">${context ? `<span>${esc(r.pack)}</span>` : `<span title="${esc(KIND_TEXT[r.kind] ?? "")}">${esc(r.bandLabel)} · ${esc(r.kind)}</span>`}<code>${esc(r.guardrail)}</code>${r.adapter ? `<span>${esc(r.adapter)}</span>` : ""}${r.runs.length ? `<span>Runs at ${esc(r.runs.join(", "))}</span>` : ""}<span>Median ${esc(r.median)}</span>${r.promote ? tag({ cls: "err", text: "Promote" }) : ""}</div>
</li>`).join("")}</ul>`;

const bandLabel = (band) => band.replace(/^./, (first) => first.toUpperCase());

const rulesByStrength = (bands) => bands.map((band) => {
  const count = band.kinds.reduce((sum, kind) => sum + kind.rules.length, 0);
  return `<section class="mod policy-group"><div class="modh"><div><h2 class="h2">${esc(bandLabel(band.band))}</h2><span class="muted">${esc(BAND_TEXT[band.band] ?? "")}</span></div><span class="muted">${plural(count, "rule")}</span></div>
${count ? band.kinds.filter((kind) => kind.rules.length).map((kind) => `<h3 class="policy-subhead">${esc(bandLabel(kind.kind))}<span class="muted">${esc(KIND_TEXT[kind.kind])}</span></h3>${ruleRows(kind.rules, true)}`).join("") : '<p class="pad muted">No rules at this strength.</p>'}
</section>`;
}).join("");

const rulesByPurpose = (bands) => {
  const packs = new Map();
  for (const band of bands) {
    for (const { rules } of band.kinds) {
      for (const rule of rules) {
        if (!packs.has(rule.pack)) packs.set(rule.pack, new Map());
        const practices = packs.get(rule.pack);
        if (!practices.has(rule.practice)) practices.set(rule.practice, []);
        practices.get(rule.practice).push({ ...rule, bandLabel: bandLabel(band.band) });
      }
    }
  }
  return [...packs].sort(([a], [b]) => a.localeCompare(b)).map(([pack, practices]) => `<section class="mod policy-group"><div class="modh"><h2 class="h2">${esc(pack)}</h2></div>
${[...practices.values()].map((rules) => `<h3 class="policy-subhead">${esc(rules[0].statement || rules[0].practice)}</h3>${ruleRows(rules, false)}`).join("")}
</section>`).join("");
};

export const ruleStrengthPage = (state) => {
  const { data, view } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const l = data.layers;
  const w = weakest(l.practices);
  const rule = l.bands.flatMap((band) => band.kinds.flatMap((kind) => kind.rules)).find((entry) => entry.practice === w?.practice && entry.kind === w.strongestKind);
  const verdict = w === undefined ? "No configured rules." : DETERMINISTIC.has(w.strongestKind) ? "Every practice has a deterministic rule." : `${esc(rule?.statement || w.practice)} · strongest rule uses ${esc(w.strongestKind)}.`;
  const by = view.ruleGroup ?? "strength";
  const groups = [["strength", "By strength"], ["purpose", "By purpose"]].map(([id, label]) => `<button type="button" id="rule-group-${id}" data-rule-group="${id}" aria-pressed="${by === id}">${label}</button>`).join("");
  const checkout = l.root ? checkoutPicker(state, l.project, l.root, "strength-checkout") : "";
  return `${header(`Rule strength · ${esc(l.project)}`, "See what each configured rule checks and how it’s evaluated.")}
<div class="controls policy-controls">${checkout}<div class="seg" role="group" aria-label="Group rules">${groups}</div></div>
<div class="next"><span class="lbl">Weakest practice</span><span>${verdict}</span></div>
${by === "purpose" ? rulesByPurpose(l.bands) || '<p class="muted">No configured rules.</p>' : rulesByStrength(l.bands)}`;
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
  return `${header(`Violations · ${esc(v.project)}`, last ? `Counted at the last run that reached rules: ${esc(clock(last.at))}, ${esc(TRIGGERS[last.trigger] ?? last.trigger ?? "")}` : "No run has reached rules yet")}
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
<div class="scroll fit-table"><table class="strength-table"><thead><tr><th scope="col" class="strength-project">Project</th><th scope="col">Failures</th><th scope="col" class="r">Deterministic</th><th scope="col" class="r">Judgment</th><th scope="col" class="r">Prose</th><th scope="col" class="r">Deterministic share</th></tr></thead><tbody>${rows}</tbody></table></div></section>
<section class="mod" aria-labelledby="dt-stops"><div class="modh"><h2 class="h2" id="dt-stops">Stops before any rule ran</h2><span class="muted">Not counted above: Warden itself refused the run · last ${plural(depth, "run")} per project</span></div>
<div class="scroll"><table><thead><tr><th scope="col" style="width:200px">Project</th><th scope="col" class="r">Tampered</th><th scope="col" class="r">Refused</th><th scope="col" class="r">Error</th><th scope="col" class="r">Unstaged</th><th scope="col">Most recent</th></tr></thead><tbody>${stops}</tbody></table></div></section>`;
};

const LOCK_ART = `<svg class="lockart" viewBox="0 0 122 34" preserveAspectRatio="xMinYMid meet" role="img" aria-label="Illustration only: a key that no longer fits its lock"><rect x="1" y="4" width="26" height="24" rx="7" fill="#E1E5EA" stroke="#1C2A3F" stroke-width="0.5"/><circle cx="10" cy="16" r="3.5" fill="#F8F9FA" stroke="#1C2A3F" stroke-width="0.5"/><path d="M27 10 L112 10 L118 16.5 L112 23 L104 23 L100.5 12.75 L95.5 12.75 L88.5 24 L83.5 24 L76.5 16.5 L71.5 16.5 L64.5 14 L59.5 14 L52.5 21.5 L47.5 21.5 L40.5 21.5 L35.5 21.5 L32 24 L27 24 Z" fill="#B3261E" fill-opacity="0.22" stroke="#B3261E" stroke-width="0.5" stroke-dasharray="1.2 0.8"/><path d="M27 10 L112 10 L118 16.5 L112 23 L104 23 L100.5 20.25 L95.5 20.25 L88.5 24 L83.5 24 L76.5 24 L71.5 24 L64.5 14 L59.5 14 L52.5 21.5 L47.5 21.5 L40.5 21.5 L35.5 21.5 L32 24 L27 24 Z" fill="none" stroke="#1C2A3F" stroke-width="0.6"/><path d="M74 16.5 L74 24 M98 12.75 L98 20.25" stroke="#B3261E" stroke-width="1.1"/></svg>`;

const isRepositoryDetection = ({ detail, file }) => detail === "hook-unwired" || detail === "unchecked-commit" || detail === "untrusted-trust" || (detail === "scan-error" && file === "git history");

const detectionState = (open, e, reposByRoot) => {
  const repo = e.repo ?? reposByRoot.get(e.root);
  const repoWide = isRepositoryDetection(e);
  if (repoWide ? !repo : !e.root) return tag({ cls: "idle", text: "Unknown" });
  const active = open.some((d) => d.project === e.project && d.file === e.file && d.detail === e.detail &&
    (repoWide ? d.repo === repo : d.root === e.root && (!repo || !d.repo || d.repo === repo)));
  return active ? tag({ cls: "block", text: "Open" }) : tag({ cls: "pass", text: "Not open now" });
};

const detectionLocation = ({ root, repo }) => {
  const path = root ?? repo;
  if (!path) return '<div class="muted">Checkout unavailable</div>';
  const label = root ? `…/${pathTail(root)}` : `Repo …/${pathTail(repo.replace(/\/\.git$/, ""))}`;
  return `<div class="muted mono detection-location" title="${esc(path)}">${esc(label)}</div>`;
};

export const tamperPage = (state) => {
  const { data } = state;
  if (data.projects.length === 0) return emptyState(state.page);
  const { open, recent } = data.tamper;
  const projects = [...new Set(open.map((d) => d.project))];
  const kinds = [...new Set(open.map((d) => d.detail.split(" ")[0]))];
  const reposByRoot = new Map(data.projects.flatMap((p) => (p.repositories ?? []).flatMap((repository) => repository.roots.map((root) => [root, repository.repo]))));
  const history = `<section class="mod" aria-labelledby="tp-hist"><div class="modh"><h2 class="h2" id="tp-hist">Tamper records</h2><span class="muted">${plural(recent.length, "record")}, newest first, from checks and the daemon</span></div><div class="scroll fit-table"><table class="tamper-history-table"><thead><tr><th scope="col">Time</th><th scope="col">Project and checkout</th><th scope="col">Found by</th><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Next action Warden gave</th><th scope="col">Now</th></tr></thead><tbody>${
    recent.length === 0
      ? '<tr><td colspan="7" class="muted">No tamper has been recorded.</td></tr>'
      : recent.map((e) => `<tr><td>${esc(clock(e.at))}</td><td>${esc(e.project)}${detectionLocation(e)}</td><td>${esc(TRIGGERS[e.trigger] ?? "a check")}</td><td class="mono">${esc(e.file ?? "–")}</td><td class="mono">${esc(e.detail ?? "–")}</td><td class="mono clip" title="${esc(e.next ?? "")}">${esc(e.next ?? "–")}</td><td>${detectionState(open, e, reposByRoot)}</td></tr>`).join("")
  }</tbody></table></div></section>`;
  if (open.length === 0) return `${header("Tamper", "The daemon compares each project's hooks, plugin, and records with its lock")}<section class="mod"><div class="alert">${tag({ cls: "pass", text: "Clear" })}<div>No open tamper detections in any watched project.</div></div></section>${history}`;
  const first = open[0];
  return `<section class="banner red" role="alert" aria-labelledby="tp-h"><div class="top" style="justify-content:space-between"><div style="display:flex;flex-direction:column;gap:4px;min-width:0"><h1 id="tp-h">Tamper detected in ${esc(projects.join(" and "))}</h1><p>${plural(open.length, "open detection")}. The first: ${esc(first.detail)} on ${esc(first.file)}. ${esc(DETAIL_TEXT[first.detail.split(" ")[0]] ?? "")}</p></div></div>${nextBox(first.next)}</section>
<div class="split">${kinds.some((k) => LOCK_KINDS.has(k)) ? `<section class="mod wide" aria-labelledby="tp-key"><div class="modh"><h2 class="h2" id="tp-key">The key no longer fits</h2><span class="muted">illustration; the files that changed are listed below</span></div><div class="pad">${LOCK_ART}</div></section>` : ""}
<section class="mod narrow" aria-labelledby="tp-kinds"><div class="modh"><h2 class="h2" id="tp-kinds">What was found</h2></div><dl class="kinds">${kinds.map((k) => `<dt class="mono">${esc(k)}</dt><dd>${esc(DETAIL_TEXT[k] ?? "Reported by the daemon.")}</dd>`).join("")}</dl></section></div>
<section class="mod" aria-labelledby="tp-open"><div class="modh"><h2 class="h2" id="tp-open">Open now · ${plural(open.length, "detection")}</h2><span class="muted">Each clears when the daemon's next scan no longer finds it</span></div><div class="scroll"><table><thead><tr><th scope="col">Project</th><th scope="col">File</th><th scope="col">Kind</th><th scope="col">Next action</th></tr></thead><tbody>${open.map((d) => `<tr class="held"><td>${esc(d.project)}${d.repo ? `<div class="muted mono" title="${esc(d.repo)}">…/${esc(d.repo.replace(/\/\.git$/, "").split("/").slice(-2).join("/"))}</div>` : ""}</td><td class="mono">${esc(d.file)}</td><td class="mono">${esc(d.detail)}</td><td class="mono wrap">${esc(d.next)}</td></tr>`).join("")}</tbody></table></div></section>
${history}`;
};

const RENDER = { overview: overviewPage, projects: projectsPage, project: projectPage, configuration: configurationPage, about: aboutPage, "pack-catalog": packCatalogPage, runs: runsPage, run: runPage, failures: failuresPage, packs: packsPage, "rule-strength": ruleStrengthPage, violations: violationsPage, determinism: determinismPage, tamper: tamperPage };

export const pageTitle = (state) => `${state.page === "run" ? "Run" : state.page === "project" && state.project ? state.project : state.page === "packs" ? "Configuration" : (PAGES[state.page] ?? "Warden")} · Warden`;

export const mainHtml = (state) => {
  if (state.error) return apiError(state.error);
  if (!state.data) return '<p class="muted">Loading…</p>';
  const selected = selectedProject(state);
  if (checkoutPageUnavailable(state.page, selected)) {
    return `${header(`${PAGES[state.page]} · ${esc(selected.project)}`, `Automatic audit · ${auditRefLabel(selected.auditOnly)}`)}
<section class="mod" aria-labelledby="checkout-page-unavailable"><div class="modh"><h2 class="h2" id="checkout-page-unavailable">Watched checkout required</h2></div><p class="pad muted">This project has a published audit and 0 watched checkouts.</p><div class="project-links"><a href="${href("failures", { project: selected.project })}">Current failures</a><a href="${href("runs", { project: selected.project })}">Run history</a></div></section>`;
  }
  return (RENDER[state.page] ?? overviewPage)(state);
};

export const frozenHtml = (state) => {
  quiet = true;
  try {
    return mainHtml(state);
  } finally {
    quiet = false;
  }
};

export const renderApp = (state) => {
  const body = state.lost ? `${lostBanner(state)}<div class="frozen" inert style="display:flex;flex-direction:column;gap:16px">${state.frozen ?? ""}</div>` : mainHtml(state);
  return `<div class="shell">${sidebar(state)}<main class="main" id="main">${body}</main></div>`;
};
