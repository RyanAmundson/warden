#!/bin/sh
set -eu

base=$(git rev-parse --verify --end-of-options "${1:?Provide the exact base commit.}^{commit}")
head=$(git rev-parse --verify --end-of-options "${2:?Provide the exact candidate commit.}^{commit}")
if [ "$base" = "$head" ] || ! git merge-base --is-ancestor "$base" "$head"; then
  echo "The candidate must be ahead of the current main commit. Merge main into the candidate, then run the check again." >&2
  exit 2
fi

WARDEN_HOME=$(mktemp -d)
export WARDEN_HOME
warden daemon --port 0 >"$WARDEN_HOME/daemon.log" 2>&1 &
daemon=$!
cleanup() {
  kill "$daemon" 2>/dev/null || true
  wait "$daemon" 2>/dev/null || true
  rm -r "$WARDEN_HOME"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

remaining=10
until [ -s "$WARDEN_HOME/daemon/heartbeat.json" ]; do
  if [ "$remaining" -eq 0 ] || ! kill -0 "$daemon" 2>/dev/null; then
    cat "$WARDEN_HOME/daemon.log" >&2
    echo "The isolated Warden daemon did not become ready. Fix the daemon error, then run the check again." >&2
    exit 2
  fi
  sleep 1
  remaining=$((remaining - 1))
done

require_candidate_tree() {
  current=$(git rev-parse --verify HEAD) || exit 2
  if [ "$head" != "$current" ]; then
    echo "HEAD differs from the candidate commit. Check out the candidate, then run the check again." >&2
    exit 2
  fi
  status=$(git status --porcelain --untracked-files=all) || exit 2
  if [ -n "$status" ]; then
    echo "The working tree differs from the candidate commit. Commit the required generated changes, then run the check again." >&2
    exit 2
  fi
}

require_candidate_tree
warden check --tier commit --base "$base"
require_candidate_tree
warden check --tier boundary --base "$base"
require_candidate_tree
