#!/usr/bin/env bash
# Replays one UI change in agent-browser and records it.
# warden video record sets URL, OUT, STEPS, and SESSION, and checks OUT afterward.
set -euo pipefail
export AGENT_BROWSER_SCREENSHOT_FORMAT=jpeg AGENT_BROWSER_SCREENSHOT_QUALITY=60

ab() { agent-browser --session "$SESSION" "$@"; }
trap 'ab record stop >/dev/null 2>&1 || true; ab close >/dev/null 2>&1 || true' EXIT

ab set viewport 1280 800
ab record start "$OUT/change.webm" "$URL"
# shellcheck source=/dev/null
source "$STEPS"
ab record stop

# `agent-browser errors` exits 0 even when the page threw, so check the JSON.
errs=$(ab --json errors | jq -r '.data.errors[].text')
[ -z "$errs" ] || { printf 'Page errors:\n%s\n' "$errs" >&2; exit 1; }
