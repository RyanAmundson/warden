import type { Adapter } from "./types.js";

export const SETTINGS_FILE = ".claude/settings.json";

const DENY = ["Edit(.warden/**)", "Write(.warden/**)", "Bash(git commit*--no-verify*)", "Bash(git commit -n*)"];

const HOOK = {
  matcher: "Edit|Write|MultiEdit",
  hooks: [{ type: "command", command: "npx --no -- warden check --format agent --hook claude" }],
};

export const claudeSettingsAdapter: Adapter = {
  id: "claude",
  emit: () => ({
    [`${SETTINGS_FILE}#permissions.deny`]: JSON.stringify(DENY),
    [`${SETTINGS_FILE}#hooks.PostToolUse`]: JSON.stringify([HOOK]),
  }),
  run: async () => [],
};
