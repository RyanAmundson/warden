#!/bin/sh
set -eu
if [ $# -ne 1 ]; then
  echo "usage: self-check.sh <release-tag>" >&2
  exit 2
fi
tag=$1
root=$(git rev-parse --show-toplevel)
if ! git -C "$root" diff --quiet; then
  echo "self-check: tracked files differ from the index; stage or discard unstaged changes, then commit." >&2
  exit 1
fi
if ! git -C "$root" rev-parse --verify --quiet "$tag^{commit}" >/dev/null; then
  echo "self-check: tag $tag does not exist" >&2
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
if [ -f "$root/tsconfig.json" ]; then
  git -C "$root" checkout-index -a --prefix="$work/staged/"
  ln -s "$root/node_modules" "$work/staged/node_modules"
  if ! (cd "$work/staged" && node_modules/.bin/tsc --outDir "$work/fresh"); then
    echo "self-check: the source does not compile. Next action: run npm run typecheck and fix the errors it names, then commit." >&2
    exit 1
  fi
  for dir in $(git -C "$root" ls-files dist | cut -d/ -f2 | sort -u); do
    if ! diff -r "$work/staged/dist/$dir" "$work/fresh/$dir" >/dev/null 2>&1; then
      echo "self-check: the staged dist/$dir differs from a fresh compile of the source. Next action: run npm run build:dist, stage dist, then commit." >&2
      exit 1
    fi
  done
fi
env -u GIT_INDEX_FILE git -C "$root" worktree add -q --no-checkout --detach "$work/prev" "$tag" >/dev/null
: > "$work/prev/.warden-self-check"
env -u GIT_INDEX_FILE git -C "$work/prev" reset -q --hard
ln -s "$root/node_modules" "$work/prev/node_modules"
(cd "$work/prev" && npm pack --silent --pack-destination "$work" >/dev/null)
mkdir "$work/install"
(cd "$work/install" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "$work"/warden-*.tgz >/dev/null)
rm -rf "$work/install/node_modules/warden/packs"
cp -R "$root/packs" "$work/install/node_modules/warden/packs"
cd "$root"
"$work/install/node_modules/.bin/warden" check --base main --trigger git-commit
