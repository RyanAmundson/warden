const PLUGIN_CHECK_NAMES = new Map([
    ["warden-pq-sdk-1", "Single plugin declaration"],
    ["warden-pq-sdk-2", "Plugin import boundaries"],
    ["warden-pq-sdk-3", "Host SDK access"],
    ["warden-pq-world-1", "Host-provided data"],
    ["warden-pq-world-2", "Trigger-based refresh"],
    ["warden-pq-effects-1", "Git writes through the host"],
    ["warden-pq-logs-1", "Plugin logging"],
    ["warden-pq-docs-1", "Plugin documentation"],
    ["warden-pq-interop-1", "Plugin-owned namespaces"],
    ["warden-pq-interop-2", "Entity collection declarations"],
    ["warden-pq-interop-3", "Versioned peer services"],
    ["warden-pq-interop-4", "Tests without peer services"],
    ["warden-pq-interop-5", "Plugin command handlers"],
    ["warden-pq-interop-8", "Versioned collections and record keys"],
    ["warden-pq-interop-9", "Published contract documentation and tests"],
    ["warden-pq-interop-11", "Contract versions and locks"],
    ["warden-pq-interop-12", "Versioned slot contributions"],
]);
export const recordedRuleIds = (run, findings = []) => new Set([...Object.keys(run.rules ?? {}), ...(run.cachedRules ?? []), ...(run.failedRules ?? []), ...(run.killedRules ?? []), ...findings.map(({ guardrail }) => guardrail)]);
export function describeRules(packs, ids) {
    return Object.fromEntries(packs.flatMap(({ id: pack, practices }) => practices.flatMap(({ statement, guardrails }) => guardrails.filter(({ id }) => ids.has(id)).map(({ id }) => {
        const label = id.replace(/^warden-/, "").replace(/[-_.]+/g, " ");
        const name = (pack === "plugin-compliance" ? PLUGIN_CHECK_NAMES.get(id) : undefined)
            ?? label.replace(/^./, (first) => first.toUpperCase());
        return [id, { name, description: statement.replace(/\s+/g, " ").trim() }];
    }))));
}
