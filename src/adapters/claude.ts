import type { Adapter } from "./types.js";

export const SETTINGS_FILE = ".claude/settings.json";

const DENY = ["Edit(.warden/**)", "Write(.warden/**)", "Bash(git commit*--no-verify*)", "Bash(git commit* -n*)"];

const hook = (base: string): unknown => ({
  matcher: "Edit|Write|MultiEdit",
  hooks: [{ type: "command", command: `npx --no -- warden check --format agent --hook claude --base '${base.replaceAll("'", "'\\''")}'` }],
});

export const claudeSettingsAdapter: Adapter = {
  id: "claude",
  emit: (_gs, set) => ({
    [`${SETTINGS_FILE}#permissions.deny`]: JSON.stringify(DENY),
    [`${SETTINGS_FILE}#hooks.PostToolUse`]: JSON.stringify([hook(set.config.base)]),
  }),
  run: async () => [],
};
