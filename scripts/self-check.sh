#!/bin/sh
set -eu
root=$(git rev-parse --show-toplevel)
tag=$(git -C "$root" tag --sort=-v:refname | head -n 1)
if [ -z "$tag" ]; then
  echo "self-check: no release tag exists to check with" >&2
  exit 2
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/warden-self-check.XXXXXX")
cleanup() {
  git -C "$root" worktree remove --force "$work/prev" >/dev/null 2>&1 || true
  git -C "$root" worktree prune
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
env -u GIT_INDEX_FILE git -C "$root" worktree add -q --detach "$work/prev" "$tag" >/dev/null
ln -s "$root/node_modules" "$work/prev/node_modules"
(cd "$work/prev" && npm run build --silent >/dev/null && npm pack --silent --pack-destination "$work" >/dev/null)
mkdir "$work/install"
(cd "$work/install" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "$work"/warden-*.tgz >/dev/null)
cd "$root"
"$work/install/node_modules/.bin/warden" check
