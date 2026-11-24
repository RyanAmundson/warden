import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { adapters, prefixOf } from "../runner/run.js";
function accessibleFile(file, mode) {
    try {
        accessSync(file, mode);
        return statSync(file).isFile();
    }
    catch {
        return false;
    }
}
const onPath = (name) => (process.env.PATH ?? "").split(delimiter)
    .some((dir) => isAbsolute(dir) && accessibleFile(join(dir, name), constants.X_OK));
export function jevReadiness() {
    if (!adapters.has("system-one"))
        return { status: "Unavailable", setup: "This Warden build lacks the System One adapter." };
    const missing = [
        ...(process.env.TYPESAFE_API_KEY ? [] : ["TYPESAFE_API_KEY"]),
        ...(process.env.WARDEN_TYPESAFE === "1" ? [] : ["WARDEN_TYPESAFE=1"]),
    ];
    return {
        status: missing.length === 0 ? "Verify in runner" : "Needs setup",
        setup: [
            missing.length === 0 ? "The dashboard has the live-call settings. Verify provider access in the runner." : `Set ${missing.join(" and ")} in the evaluation runner for live calls.`,
            "A Guardrail needs a pinned model, a question, approved input files, and decision thresholds. Cached results can be reused without live credentials.",
        ].join(" "),
    };
}
function adapterReadiness(root, pack, id) {
    if (!adapters.has(id))
        return { status: "Unavailable", setup: "This Warden build does not register the adapter." };
    switch (id) {
        case "system-one": return jevReadiness();
        case "tsc": {
            const hasConfig = accessibleFile(join(root, "tsconfig.json"), constants.R_OK);
            return {
                status: hasConfig ? "Verify in runner" : "Needs setup",
                setup: "Warden bundles TypeScript. Add a readable tsconfig.json and install the project's dependencies. Run the checks to verify compilation.",
            };
        }
        case "cmd": {
            if (pack.id === "tla") {
                const jar = process.env.WARDEN_TLC_JAR;
                const java = onPath("java");
                const jarReadable = jar !== undefined && isAbsolute(jar) && accessibleFile(jar, constants.R_OK);
                return {
                    status: java && jarReadable ? "Verify in runner" : "Needs setup",
                    setup: `Java on PATH: ${java ? "found" : "missing"}. WARDEN_TLC_JAR: ${jarReadable ? "readable" : "missing or unreadable"}. Use the pinned TLC JAR and a project model and TLC config. Run the check to verify the pin and model.`,
                };
            }
            if (pack.id === "review") {
                return {
                    status: "Verify in runner",
                    setup: `Install the project dependencies and verify the configured test command and optional build. Claude on the dashboard PATH: ${onPath("claude") ? "found" : "missing"}. Native Claude review requires an authenticated harness with the selected review plugin.`,
                };
            }
            if (pack.id === "proofs") {
                const lake = onPath("lake");
                return {
                    status: lake ? "Verify in runner" : "Needs setup",
                    setup: `Lake on PATH: ${lake ? "found" : "missing"}. Install Lean with elan, pin the version in the Lean project's lean-toolchain, and give each conformance spec a model command. Run the checks to verify the proofs build.`,
                };
            }
            if (pack.id === "folder-json")
                return { status: "Ready", setup: "Uses Node and Git from the standard Warden setup." };
            return { status: "Verify in runner", setup: "Install the executables and dependencies used by this pack's commands. The dashboard does not run pack commands." };
        }
        case "tool": return { status: "Ready", setup: "Built into Warden. Set the project's manifest and script paths if they differ from the pack defaults." };
        default: return { status: "Ready", setup: "Bundled with Warden. No separate adapter installation." };
    }
}
const projectSetup = new Map([
    ["idempotency", "Add an <operation>.idempotency.js, .mjs, or .ts spec with setup, run, snapshot, and inputs. Call step() between the operation's writes so Warden can test a crash and retry."],
    ["machines", "Add a .machine.json transition table. Add a matching .trace.json when you want Warden to verify recorded transitions."],
    ["proofs", "Add a Lean 4 Lake project at the project setting, default proofs. Add a <logic>.conformance.js, .mjs, or .ts spec that names the proved model's command and the implementation it checks."],
    ["unit-layout", "Set unitKinds and units in .warden/config.yaml. Add each Unit's declared Markdown document and headings."],
]);
export function packDetails(root, pack) {
    const checks = pack.practices.flatMap(({ statement, guardrails }) => guardrails.map((g) => {
        const adapter = g.kind === "instruction" ? null : prefixOf(g);
        const model = adapter === "system-one" ? g.options?.model : undefined;
        return { id: g.id, statement, adapter, runs: g.runs, ...(typeof model === "string" && /^(?:jev|laya)-\d+\.\d+\.\d+$/.test(model) ? { model } : {}) };
    }));
    const required = new Set(checks.flatMap(({ adapter }) => adapter === null ? [] : [adapter]));
    const settings = pack.settings?.properties;
    const keys = settings !== null && typeof settings === "object" ? Object.keys(settings) : [];
    return {
        id: pack.id,
        checks,
        adapters: [...required].map((id) => ({ id, ...adapterReadiness(root, pack, id) })),
        setup: projectSetup.get(pack.id) ?? (keys.length === 0 ? null : `Review these project settings if the defaults do not fit: ${keys.join(", ")}.`),
    };
}
